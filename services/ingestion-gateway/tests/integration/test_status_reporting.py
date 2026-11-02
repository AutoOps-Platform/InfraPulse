"""Real authenticated ingestion and lifespan reporting, without external services."""
import asyncio
import inspect
import json
import time

import httpx
import pytest

from app.config import Settings
from app.main import create_app
from tests.unit.test_status_reporter import Clock, Receiver, BASE, REPORTS, stamp

PATH = '/api/v1/ingest/remote-write'


@pytest.mark.parametrize('upstream', [200, 204, 299, 400, 413, 429, 500, 302])
async def test_only_real_prom_success_records_receipt_after_forward(app_client, headers, make_write,
        pack_write, active_proof, monkeypatch, upstream):
    order, receipts = [], []
    receipt_ms = BASE + 1000
    def forward(request):
        order.append('prom-success' if 200 <= upstream < 300 else 'prom-rejection')
        return httpx.Response(upstream)
    def receipt_clock():
        order.append('receipt-clock')
        return receipt_ms
    monkeypatch.setattr('app.pipeline.utc_now_ms', receipt_clock, raising=False)
    async with app_client(upstream_transport=httpx.MockTransport(forward)) as (app, client):
        reporter = getattr(app.state, 'status_reporter', None)
        assert reporter is not None, 'lifespan must wire the required reporter'
        original = reporter.record_success
        def record(proof, succeeded_at_ms):
            order.append('record')
            receipts.append((proof, succeeded_at_ms))
            original(proof, succeeded_at_ms)
        monkeypatch.setattr(reporter, 'record_success', record)
        response = await client.post(PATH, headers=headers, content=pack_write(make_write()))
        assert app.state.pipeline.admission.inflight == app.state.pipeline.codec_limiter.borrowed_tokens == 0
        assert not inspect.iscoroutinefunction(reporter.record_success)
    if 200 <= upstream < 300:
        assert response.status_code == 204
        assert order == ['prom-success', 'receipt-clock', 'record']
        assert len(receipts) == 1 and receipts[0][1] == receipt_ms
        proof = receipts[0][0]
        assert (proof.identity.agent_id, proof.identity.server_id, proof.credential_id) == (
            active_proof['agent_id'], active_proof['server_id'], active_proof['credential_id'])
    else:
        assert len(receipts) == 0 and order == ['prom-rejection']
        assert response.status_code != 204


async def test_reporter_failure_never_rewrites_accepted_204(app_client, headers, make_write, pack_write, monkeypatch):
    async with app_client() as (app, client):
        reporter = getattr(app.state, 'status_reporter', None)
        assert reporter is not None
        def broken(*args):
            __tracebackhide__ = True
            raise RuntimeError('private-status-error-SENTINEL')
        monkeypatch.setattr(reporter, 'record_success', broken)
        response = await client.post(PATH, headers=headers, content=pack_write(make_write()))
        assert response.status_code == 204
        assert app.state.pipeline.admission.inflight == 0


async def test_reporting_blocked_does_not_wait_on_ingest_or_readiness(app_client, headers, make_write, pack_write):
    clock = Clock()
    receiver = Receiver(clock)
    receiver.report_gate = asyncio.Event()
    # Factory transport DI is a test boundary, never an environment bypass.
    async with app_client(reporter_transport=httpx.MockTransport(receiver)) as (app, client):
        reporter = app.state.status_reporter
        reporter._clock = lambda: clock.wall
        # Runtime boot remains truthful; this test uses real UTC for receiver too.
        clock.wall = int(time.time() * 1000)
        clock.mono = time.monotonic()
        sending = asyncio.create_task(reporter._tick())
        try:
            await asyncio.wait_for(receiver.entered.wait(), 1)
            response = await asyncio.wait_for(client.post(PATH, headers=headers, content=pack_write(make_write())), 1)
            assert response.status_code == 204
            assert (await client.get('/health/live')).status_code == 200
            assert (await client.get('/health/ready')).status_code == 200
            assert receiver.peak == 1
            assert app.state.pipeline.admission.inflight == app.state.pipeline.codec_limiter.borrowed_tokens == 0
        finally:
            receiver.report_gate.set()
            await sending


@pytest.mark.parametrize('failure', ['auth', 'payload', 'identity'])
async def test_rejected_ingest_does_not_record(app_client, headers, make_write, pack_write, failure, monkeypatch):
    calls = []
    async with app_client() as (app, client):
        reporter = getattr(app.state, 'status_reporter', None)
        assert reporter is not None
        monkeypatch.setattr(reporter, 'record_success', lambda *args: calls.append(True))
        selected = headers
        if failure == 'auth':
            selected = [(k, v) for k, v in headers if k != b'authorization']
        elif failure == 'identity':
            selected = [(k, b'forged' if k == b'x-agent-id' else v) for k, v in headers]
        response = await client.post(PATH, headers=selected,
            content=b'not-snappy' if failure == 'payload' else pack_write(make_write()))
        assert response.status_code in {400, 401, 403}
        assert calls == []


async def test_cancelled_forward_does_not_record_success(app_client, headers, make_write, pack_write, monkeypatch):
    entered, never = asyncio.Event(), asyncio.Event()
    calls = []
    async def forward(request):
        __tracebackhide__ = True
        entered.set()
        await never.wait()
        return httpx.Response(204)
    async with app_client(upstream_transport=httpx.MockTransport(forward)) as (app, client):
        monkeypatch.setattr(app.state.status_reporter, 'record_success', lambda *args: calls.append(True))
        sending = asyncio.create_task(client.post(PATH, headers=headers, content=pack_write(make_write())))
        try:
            await asyncio.wait_for(entered.wait(), 1)
            sending.cancel()
            with pytest.raises(asyncio.CancelledError):
                await sending
            assert calls == []
            assert app.state.pipeline.admission.inflight == app.state.pipeline.codec_limiter.borrowed_tokens == 0
        finally:
            never.set()
            if not sending.done():
                sending.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await sending


async def test_lifespan_repeated_cancel_joins_reporter_and_closes_all_five_once():
    entered, release = asyncio.Event(), asyncio.Event()
    transports = []
    class Transport(httpx.AsyncBaseTransport):
        closes = 0
        async def handle_async_request(self, request):
            return httpx.Response(503)
        async def aclose(self):
            self.closes += 1
            entered.set()
            await release.wait()
    transports = [Transport() for _ in range(5)]
    app = create_app(Settings(), upstream_transport=transports[0], ready_transport=transports[1],
        management_transport=transports[2], management_ready_transport=transports[3], reporter_transport=transports[4])
    lifespan = app.router.lifespan_context(app)
    await lifespan.__aenter__()
    assert app.state.initialized
    clients = [app.state.pipeline.forwarder._client, app.state.ready_client, app.state.credential_client,
               app.state.management_ready_client, app.state.reporter_client]
    assert len({id(client) for client in clients}) == 5
    assert app.state.reporter_client.timeout == httpx.Timeout(2)
    assert app.state.status_reporter._client._timeout == 2
    exiting = asyncio.create_task(lifespan.__aexit__(None, None, None))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        exiting.cancel()
        await asyncio.sleep(0)
        exiting.cancel()
        await asyncio.sleep(0)
        assert not exiting.done()
    finally:
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await exiting
    assert [t.closes for t in transports] == [1] * 5
    assert all(client.is_closed for client in clients)
    assert not app.state.initialized and app.state.status_reporter._task.done()
    assert app.state.pipeline.admission.inflight == 0


async def test_reporting_telemetry_is_finite_and_secret_free(app_client, headers, make_write, pack_write,
        api_key, active_proof, capsys):
    assertions = []
    def unavailable(request):
        __tracebackhide__ = True
        assertions.append(request.headers.get('authorization', ''))
        raise RuntimeError('private-status-exception-SENTINEL')
    async with app_client(reporter_transport=httpx.MockTransport(unavailable)) as (app, client):
        response = await client.post(PATH, headers=headers, content=pack_write(make_write()))
        assert response.status_code == 204
        await app.state.status_reporter._tick()
        metrics = (await client.get('/metrics')).text
    captured = capsys.readouterr()
    combined = captured.out + captured.err + metrics + response.text
    leaks = sum(value in combined for value in [api_key, *assertions, *[active_proof[k] for k in
                ('agent_id', 'server_id', 'credential_id')], 'SENTINEL', 'Traceback'] if value)
    assert leaks == 0
    assert 'infrapulse_status_reports_total{result="unavailable"}' in metrics
    events = [json.loads(line) for line in captured.out.splitlines() if line.startswith('{')]
    assert any(event['event'] == 'status_report_unavailable' for event in events)
