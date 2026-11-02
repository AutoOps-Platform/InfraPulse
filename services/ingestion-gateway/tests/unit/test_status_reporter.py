"""Bounded, deterministic status sender tests over the real signed HTTP boundary."""
import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from uuid import UUID

import httpx
import jwt
import pytest
import rfc8785
from pydantic import ValidationError

from app.config import Settings
from app.credentials import VerifiedCredential
from app.identity import Identity
from app.management_client import SignedManagementClient
from app.service_auth import ServiceSigner

EPOCH = '/internal/v1/status/epoch'
REPORTS = '/internal/v1/status/reports'
BASE = 1800000000000


def stamp(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def proof(i=1, credential=9000):
    return VerifiedCredential(str(UUID(int=credential)), Identity(str(UUID(int=8000)), str(UUID(int=i))),
                              frozenset({'metrics:write'}), datetime(2030, 1, 1, tzinfo=timezone.utc))


class Clock:
    wall = BASE
    mono = 100.0

    def advance(self, ms):
        self.wall += ms
        self.mono += ms / 1000


class Receiver:
    """External transport implementing the actual T10 DTO/ack, not a sender stub."""
    def __init__(self, clock):
        self.clock = clock
        self.requests = []
        self.epoch = 0
        self.boot = None
        self.activation = None
        self.fail = False
        self.report_status = 200
        self.report_gate = None
        self.entered = asyncio.Event()
        self.active = self.peak = 0
        self.ack_override = None

    async def __call__(self, request):
        __tracebackhide__ = True
        self.requests.append(request)
        self.active += 1
        self.peak = max(self.peak, self.active)
        try:
            if self.fail:
                return httpx.Response(503)
            if request.url.path == EPOCH:
                if request.method == 'POST':
                    data = json.loads(request.content)
                    if self.boot is not None and data['boot_id'] != self.boot:
                        return httpx.Response(409)
                    self.boot, self.epoch = data['boot_id'], 1
                    self.activation = self.activation or stamp(self.clock.wall)
                return httpx.Response(200, json={'gateway_id': '00000000-0000-4000-8000-000000000004', 'boot_id': self.boot,
                    'epoch': self.epoch, 'activated_at': self.activation if self.epoch else None})
            assert request.method == 'POST' and request.url.path == REPORTS
            self.entered.set()
            if self.report_gate is not None:
                await self.report_gate.wait()
            if self.report_status != 200:
                return httpx.Response(self.report_status)
            data = json.loads(request.content)
            ack = {'epoch': data['epoch'], 'sequence': data['sequence'],
                'state': 'committed' if data['chunk_index'] == data['chunk_count'] - 1 else 'staged',
                'accepted_chunk_indexes': list(range(data['chunk_index'] + 1))}
            return httpx.Response(200, json=self.ack_override if self.ack_override is not None else ack)
        finally:
            self.active -= 1

    def reports(self):
        return [request for request in self.requests if request.url.path == REPORTS]


@asynccontextmanager
async def running(signing_key_file, *, clock=None, receiver=None, **settings):
    # A missing feature fails an individual behavior test, not module collection.
    assert importlib.util.find_spec('app.status_reporter') is not None, 'bounded status reporter is required'
    from app.status_reporter import StatusReporter
    clock = clock or Clock()
    receiver = receiver or Receiver(clock)
    config = Settings(**settings)
    signer = ServiceSigner(signing_key_file, issuer='infrapulse-gateway',
        audience='infrapulse-management-internal', subject=config.gateway_id, kid=config.service_key_id)
    async with httpx.AsyncClient(transport=httpx.MockTransport(receiver), trust_env=False) as transport:
        client = SignedManagementClient(transport, signer, config.management_base_url,
            timeout_seconds=config.status_timeout_seconds)
        reporter = StatusReporter(config, client, utc_now_ms=lambda: clock.wall, monotonic=lambda: clock.mono)
        await reporter.start()
        try:
            yield reporter, receiver, clock
        finally:
            await reporter.close()


def test_status_settings_defaults_and_environment(monkeypatch):
    config = Settings()
    assert (getattr(config, 'status_interval_seconds', None), getattr(config, 'status_timeout_seconds', None),
            getattr(config, 'status_max_pending_agents', None)) == (10, 2, 1024)
    monkeypatch.setenv('INGEST_STATUS_INTERVAL_SECONDS', '1')
    monkeypatch.setenv('INGEST_STATUS_TIMEOUT_SECONDS', '0.5')
    monkeypatch.setenv('INGEST_STATUS_MAX_PENDING_AGENTS', '17')
    config = Settings()
    assert (config.status_interval_seconds, config.status_timeout_seconds, config.status_max_pending_agents) == (1, .5, 17)


@pytest.mark.parametrize('field,value', [('status_interval_seconds', 0), ('status_interval_seconds', 10.01),
    ('status_interval_seconds', float('nan')), ('status_timeout_seconds', 0), ('status_timeout_seconds', 2.01),
    ('status_timeout_seconds', float('inf')), ('status_max_pending_agents', 0), ('status_max_pending_agents', 1025)])
def test_status_settings_reject_protocol_expansion(field, value):
    with pytest.raises(ValidationError):
        Settings(**{field: value})


async def test_cap_latest_coalescing_four_bounded_chunks_and_exact_digests(signing_key_file):
    async with running(signing_key_file) as (reporter, receiver, clock):
        for i in range(1, 1026):
            assert reporter.record_success(proof(i), clock.wall) is None
        assert reporter.pending_count == 1024 and reporter.coverage_gap
        clock.advance(20)
        reporter.record_success(proof(1, credential=9001), clock.wall)
        await reporter._tick()
        bodies = [json.loads(request.content) for request in receiver.reports()]
        assert len(bodies) == 4
        assert [len(body['records']) for body in bodies] == [256] * 4
        assert all(len(request.content) <= 65536 for request in receiver.reports())
        records = [record for body in bodies for record in body['records']]
        assert len(records) == len({record['agent_id'] for record in records}) == 1024
        assert records[0] == {'agent_id': str(UUID(int=1)), 'server_id': str(UUID(int=8000)),
            'credential_id': str(UUID(int=9001)), 'last_success_at': stamp(BASE + 20)}
        logical = {key: bodies[0][key] for key in ('epoch', 'sequence', 'snapshot_start', 'snapshot_end', 'gap')}
        logical['records'] = records
        assert len(rfc8785.dumps(logical)) <= 262144
        digest = hashlib.sha256(rfc8785.dumps(logical)).hexdigest()
        for index, body in enumerate(bodies):
            assert set(body) == {'epoch', 'sequence', 'snapshot_start', 'snapshot_end', 'gap', 'records',
                                'chunk_index', 'chunk_count', 'snapshot_hash', 'chunk_hash'}
            assert (body['chunk_index'], body['chunk_count'], body['snapshot_hash']) == (index, 4, digest)
            assert body['chunk_hash'] == hashlib.sha256(rfc8785.dumps(body['records'])).hexdigest()
        assert reporter.pending_count == 0


async def test_empty_heartbeat_advances_completed_coverage_and_start_is_idempotent(signing_key_file):
    async with running(signing_key_file) as (reporter, receiver, clock):
        await reporter.start()
        await reporter._tick()
        clock.advance(10000)
        await reporter._tick()
        first, second = [json.loads(request.content) for request in receiver.reports()]
        assert first['records'] == second['records'] == []
        assert first['gap'] is True and second['gap'] is False
        assert second['snapshot_start'] == first['snapshot_end']
        assert second['sequence'] == first['sequence'] + 1
        assert receiver.peak == 1


async def test_retries_are_immutable_but_assertions_fresh_then_abandon_after_three(signing_key_file):
    async with running(signing_key_file) as (reporter, receiver, clock):
        receiver.report_status = 503
        reporter.record_success(proof(), clock.wall)
        for _ in range(3):
            await reporter._tick()
            clock.advance(9000)
            reporter.record_success(proof(), clock.wall)
        attempts = receiver.reports()
        assert len(attempts) == 3 and len({request.content for request in attempts}) == 1
        tokens = [request.headers['authorization'].removeprefix('Bearer ') for request in attempts]
        assert len({jwt.decode(token, options={'verify_signature': False})['jti'] for token in tokens}) == 3
        receiver.report_status = 200
        await reporter._tick()
        old, new = json.loads(attempts[0].content), json.loads(receiver.reports()[-1].content)
        assert new['sequence'] > old['sequence'] and new['gap'] is True
        assert new['records'][0]['last_success_at'] == stamp(clock.wall)


async def test_thirty_second_deadline_abandons_before_next_attempt(signing_key_file):
    async with running(signing_key_file) as (reporter, receiver, clock):
        receiver.report_status = 503
        reporter.record_success(proof(), clock.wall)
        await reporter._tick()
        old = json.loads(receiver.reports()[0].content)
        clock.advance(30000)
        receiver.report_status = 200
        await reporter._tick()
        new = json.loads(receiver.reports()[-1].content)
        assert new['sequence'] == old['sequence'] + 1 and new['gap']
        assert len(receiver.reports()) == 2


async def test_ack_barrier_retains_newer_proof_and_gap_generation(signing_key_file):
    async with running(signing_key_file, status_max_pending_agents=1) as (reporter, receiver, clock):
        reporter.record_success(proof(), clock.wall)
        gate = receiver.report_gate = asyncio.Event()
        sending = asyncio.create_task(reporter._tick())
        try:
            await asyncio.wait_for(receiver.entered.wait(), 1)
            clock.advance(1)
            reporter.record_success(proof(1, credential=9001), clock.wall)
            reporter.record_success(proof(2), clock.wall)  # overflow after snapshot capture
            await reporter._tick()  # no parallel request/snapshot
            assert receiver.peak == 1
            receiver.report_gate.set()
            await sending
            assert reporter.pending_count == 1 and reporter.coverage_gap
            receiver.report_gate = None
            await reporter._tick()
            new = json.loads(receiver.reports()[-1].content)
            assert new['gap'] and new['records'][0]['credential_id'] == str(UUID(int=9001))
            assert new['records'][0]['last_success_at'] == stamp(BASE + 1)
        finally:
            gate.set()
            await sending


async def test_delayed_initial_registration_keeps_truthful_boot_and_historical_success(signing_key_file):
    clock = Clock()
    receiver = Receiver(clock)
    receiver.fail = True
    async with running(signing_key_file, clock=clock, receiver=receiver) as (reporter, _, _):
        reporter.record_success(proof(), BASE)
        await reporter._tick()
        clock.advance(20000)
        receiver.fail = False
        await reporter._tick()
        opened = [json.loads(r.content) for r in receiver.requests if r.method == 'POST' and r.url.path == EPOCH]
        body = json.loads(receiver.reports()[0].content)
        assert len(opened) == 1 and opened[0]['boot_started_at'] == stamp(BASE)
        assert body['records'][0]['last_success_at'] == stamp(BASE)
        assert body['snapshot_end'] == stamp(BASE + 20000) and body['gap']
        assert receiver.activation == body['snapshot_end']


async def test_epoch_conflicts_have_at_most_three_refetches_and_no_fake_boot(signing_key_file):
    clock = Clock()
    receiver = Receiver(clock)
    receiver.epoch, receiver.boot, receiver.activation = 4, str(UUID(int=44)), stamp(BASE + 100)
    async with running(signing_key_file, clock=clock, receiver=receiver) as (reporter, _, _):
        await reporter._tick()
        assert len([r for r in receiver.requests if r.method == 'GET']) <= 3
        posts = [json.loads(r.content) for r in receiver.requests if r.method == 'POST']
        assert 1 <= len(posts) <= 3
        assert len({(p['boot_id'], p['boot_started_at']) for p in posts}) == 1
        clock.advance(10000)
        await reporter._tick()
        all_posts = [json.loads(r.content) for r in receiver.requests if r.method == 'POST']
        assert len({(p['boot_id'], p['boot_started_at']) for p in all_posts}) == 1
        assert receiver.reports() == []


async def test_old_epoch_report_recovery_preserves_boot_identity(signing_key_file):
    async with running(signing_key_file) as (reporter, receiver, clock):
        receiver.report_status = 409
        reporter.record_success(proof(), clock.wall)
        await reporter._tick()
        boot = receiver.boot
        receiver.report_status = 200
        clock.advance(10000)
        await reporter._tick()
        assert receiver.boot == boot
        assert len(receiver.reports()) == 2
        assert json.loads(receiver.reports()[-1].content)['gap']


async def test_expired_records_drop_with_gap_and_clock_regression_never_fakes_now(signing_key_file):
    async with running(signing_key_file) as (reporter, receiver, clock):
        await reporter._tick()
        reporter.record_success(proof(), clock.wall)
        clock.advance(600001)
        await reporter._tick()
        body = json.loads(receiver.reports()[-1].content)
        assert body['records'] == [] and body['gap']
        before = len(receiver.reports())
        clock.wall -= 10000
        clock.mono += 1
        reporter.record_success(proof(2), clock.wall)
        await reporter._tick()
        assert len(receiver.reports()) == before and reporter.coverage_gap
        clock.advance(20000)
        await reporter._tick()
        recovered = json.loads(receiver.reports()[-1].content)
        assert recovered['gap'] and recovered['records'][0]['last_success_at'] == stamp(BASE + 590001)


@pytest.mark.parametrize('ack', [{}, {'epoch': 1, 'sequence': 1, 'state': 'complete', 'accepted_chunk_indexes': [0]},
    {'epoch': 1, 'sequence': 1, 'state': 'committed', 'accepted_chunk_indexes': []},
    {'epoch': 1, 'sequence': 1, 'state': 'staged', 'accepted_chunk_indexes': [0]}])
async def test_incomplete_or_malformed_ack_never_clears_observation(signing_key_file, ack):
    async with running(signing_key_file) as (reporter, receiver, clock):
        reporter.record_success(proof(), clock.wall)
        receiver.ack_override = ack
        await reporter._tick()
        assert reporter.pending_count == 1


async def test_records_expiring_during_registration_drop_before_snapshot(signing_key_file):
    clock = Clock()
    class SlowRegistration(Receiver):
        async def __call__(self, request):
            __tracebackhide__ = True
            if request.method == 'POST' and request.url.path == EPOCH:
                clock.advance(20000)
            return await super().__call__(request)
    receiver = SlowRegistration(clock)
    async with running(signing_key_file, clock=clock, receiver=receiver) as (reporter, _, _):
        reporter.record_success(proof(), clock.wall)
        clock.advance(590000)
        await reporter._tick()
        body = json.loads(receiver.reports()[-1].content)
        assert body['records'] == [] and body['gap']
        assert reporter.pending_count == 0


async def test_periodic_worker_sends_without_manual_tick_and_never_overlaps(signing_key_file):
    clock = Clock()
    receiver = Receiver(clock)
    receiver.report_gate = asyncio.Event()
    async with running(signing_key_file, clock=clock, receiver=receiver,
                       status_interval_seconds=.01, status_timeout_seconds=.1) as (reporter, _, _):
        reporter.record_success(proof(), clock.wall)
        await asyncio.wait_for(receiver.entered.wait(), .5)
        assert reporter._task is not asyncio.current_task()
        await reporter._tick()
        assert receiver.peak == 1
        receiver.report_gate.set()
    assert reporter._task.done() and receiver.active == 0


async def test_future_success_drops_without_timestamp_repair(signing_key_file):
    async with running(signing_key_file) as (reporter, receiver, clock):
        reporter.record_success(proof(), clock.wall + 5001)
        await reporter._tick()
        assert json.loads(receiver.reports()[0].content)['records'] == []
        assert json.loads(receiver.reports()[0].content)['gap']


async def test_committed_replay_ack_of_only_supplied_index_is_not_new_delivery(signing_key_file):
    async with running(signing_key_file) as (reporter, receiver, clock):
        for i in range(1, 258):
            reporter.record_success(proof(i), clock.wall)
        receiver.report_status = 503
        await reporter._tick()
        original = receiver.reports()[0].content
        receiver.report_status = 200
        receiver.ack_override = {'epoch': 1, 'sequence': 1, 'state': 'committed', 'accepted_chunk_indexes': [0]}
        clock.advance(10000)
        await reporter._tick()
        assert len(receiver.reports()) == 2 and receiver.reports()[-1].content == original
        assert reporter.pending_count == 0
        receiver.ack_override = None
        await reporter._tick()
        body = json.loads(receiver.reports()[-1].content)
        assert body['records'] == [] and body['snapshot_start'] == stamp(BASE)
        assert body['snapshot_end'] == stamp(BASE + 10000)


async def test_shutdown_cancels_busy_periodic_worker_within_two_second_drain(signing_key_file):
    clock = Clock()
    receiver = Receiver(clock)
    receiver.report_gate = asyncio.Event()
    async with running(signing_key_file, clock=clock, receiver=receiver,
                       status_interval_seconds=.01) as (reporter, _, _):
        reporter.record_success(proof(), clock.wall)
        await asyncio.wait_for(receiver.entered.wait(), .5)
        loop = asyncio.get_running_loop()
        started = loop.time()
        closing = asyncio.create_task(reporter.close())
        await asyncio.sleep(0)
        closing.cancel()
        await asyncio.sleep(0)
        closing.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(closing, 2.5)
        assert loop.time() - started < 2.5
        assert reporter._task.done() and receiver.active == 0
        assert reporter.pending_count == 0


async def test_lost_epoch_open_response_recovers_same_boot_and_activation(signing_key_file):
    clock = Clock()
    class LostOpen(Receiver):
        lost = False
        async def __call__(self, request):
            __tracebackhide__ = True
            response = await super().__call__(request)
            if request.method == 'POST' and request.url.path == EPOCH and not self.lost:
                self.lost = True
                raise httpx.ReadError('private-status-lost-response')
            return response
    receiver = LostOpen(clock)
    async with running(signing_key_file, clock=clock, receiver=receiver) as (reporter, _, _):
        reporter.record_success(proof(), clock.wall)
        await reporter._tick()
        boot, activation = receiver.boot, receiver.activation
        clock.advance(20000)
        await reporter._tick()
        assert receiver.boot == boot and receiver.activation == activation == stamp(BASE)
        opens = [r for r in receiver.requests if r.method == 'POST' and r.url.path == EPOCH]
        assert len(opens) == 1
        assert json.loads(receiver.reports()[0].content)['records'][0]['last_success_at'] == stamp(BASE)


@pytest.mark.parametrize('advance_ms', [30000, 2000])
async def test_chunk_loop_rechecks_deadline_and_record_age_after_each_rpc(signing_key_file, advance_ms):
    clock = Clock()
    class AdvancingReport(Receiver):
        async def __call__(self, request):
            __tracebackhide__ = True
            response = await super().__call__(request)
            if request.url.path == REPORTS:
                clock.advance(advance_ms)
            return response
    receiver = AdvancingReport(clock)
    async with running(signing_key_file, clock=clock, receiver=receiver) as (reporter, _, _):
        for i in range(1, 258):
            reporter.record_success(proof(i), clock.wall)
        if advance_ms == 2000:
            clock.advance(599000)
        await reporter._tick()
        assert len(receiver.reports()) == 1
        assert reporter.coverage_gap
        receiver.requests.clear()
        await reporter._tick()
        body = json.loads(receiver.reports()[0].content)
        assert body['sequence'] == 2 and body['gap']
        if advance_ms == 2000:
            assert body['records'] == []


async def test_receiver_activation_may_precede_boot_within_allowed_future_skew(signing_key_file):
    clock = Clock()
    receiver = Receiver(clock)
    receiver.activation = stamp(BASE - 4000)
    async with running(signing_key_file, clock=clock, receiver=receiver) as (reporter, _, _):
        reporter.record_success(proof(), clock.wall)
        await reporter._tick()
        assert len(receiver.reports()) == 1
        body = json.loads(receiver.reports()[0].content)
        assert body['gap'] and body['snapshot_end'] == stamp(BASE)
        assert body['records'][0]['last_success_at'] == stamp(BASE)


async def test_request_total_deadline_and_close_are_bounded_and_join_worker(signing_key_file):
    async with running(signing_key_file, status_timeout_seconds=.02) as (reporter, receiver, clock):
        receiver.report_gate = asyncio.Event()
        reporter.record_success(proof(), clock.wall)
        await asyncio.wait_for(reporter._tick(), .5)
        assert reporter.pending_count == 1 and receiver.active == 0
        await asyncio.wait_for(reporter.close(), .5)
        await reporter.close()
        assert reporter._task.done() and receiver.active == 0
