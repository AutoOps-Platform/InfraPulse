"""Health is independent of admission, ingestion pool, and upstream body reads."""

import asyncio
import importlib

import httpx
import pytest

from app.config import Settings
from app.main import create_app


async def test_health_bypasses_saturated_ingestion(app_client, headers, make_write, pack_write):
    blocked, release = asyncio.Event(), asyncio.Event()
    calls, ready_calls = [], []

    async def upstream(request):
        calls.append(request)
        if len(calls) == 2:
            blocked.set()
        await release.wait()
        return httpx.Response(204)

    def ready(request):
        ready_calls.append(request)
        return httpx.Response(200)

    async with app_client(upstream_transport=httpx.MockTransport(upstream), ready_transport=httpx.MockTransport(ready)) as (app, client):
        payload = pack_write(make_write())
        tasks = [asyncio.create_task(client.post("/api/v1/ingest/remote-write", headers=headers, content=payload)) for _ in range(2)]
        try:
            await asyncio.wait_for(blocked.wait(), 2)
            for path in ("/health/live", "/health/ready"):
                assert (await asyncio.wait_for(client.get(path), 0.5)).status_code == 200
            response = await client.post("/api/v1/ingest/remote-write", headers=headers, content=payload)
            assert response.status_code == 429
            assert app.state.pipeline.admission.inflight == 2
        finally:
            release.set()
            responses = await asyncio.gather(*tasks)
        assert all(response.status_code == 204 for response in responses)
    assert len(calls) == 2
    assert len(ready_calls) == 1
    assert str(ready_calls[0].url) == "http://prometheus:9090/-/ready"
    assert "authorization" not in ready_calls[0].headers


@pytest.mark.parametrize("outcome,expected", [(200, 200), (204, 503), (500, 503), (302, 503), ("network", 503), ("timeout", 503), ("unexpected", 503)])
async def test_health_mapping_and_deadline(app_client, outcome, expected):
    calls = []
    block = asyncio.Event()

    async def ready(request):
        calls.append(request)
        if outcome == "network":
            raise httpx.ConnectError("private-health-sentinel")
        if outcome == "unexpected":
            raise RuntimeError("private-health-sentinel")
        if outcome == "timeout":
            await block.wait()
        return httpx.Response(outcome, headers={"Location": "http://[invalid"}, content=b"private-health-sentinel")

    async with app_client(Settings(ready_timeout_seconds=0.02), ready_transport=httpx.MockTransport(ready)) as (_, client):
        response = await asyncio.wait_for(client.get("/health/ready"), 0.5)
        assert response.status_code == expected
        assert "private-health-sentinel" not in response.text
        assert (await client.get("/health/live")).status_code == 200
    assert len(calls) == 1


async def test_readiness_does_not_read_body_and_closes_response(app_client):
    class Body(httpx.AsyncByteStream):
        closed = False
        async def __aiter__(self):
            raise AssertionError("readiness must never consume response body")
            yield b""  # an async generator with intentionally forbidden iteration
        async def aclose(self):
            self.closed = True

    body = Body()
    async with app_client(ready_transport=httpx.MockTransport(lambda request: httpx.Response(200, stream=body))) as (_, client):
        assert (await client.get("/health/ready")).status_code == 200
        assert body.closed


async def test_lifespan_closes_clients():
    class Transport(httpx.AsyncBaseTransport):
        closed = False
        async def handle_async_request(self, request):
            return httpx.Response(200)
        async def aclose(self):
            self.closed = True

    upstream, ready = Transport(), Transport()
    app = create_app(Settings(), upstream_transport=upstream, ready_transport=ready)
    assert not app.state.initialized
    async with app.router.lifespan_context(app):
        ready_client = app.state.ready_client
        assert app.state.initialized
        assert not ready_client.is_closed
    assert not app.state.initialized
    assert ready_client.is_closed
    assert upstream.closed and ready.closed


async def test_clients_close_if_lifespan_body_fails():
    class Transport(httpx.MockTransport):
        closed = False
        async def aclose(self):
            self.closed = True
            await super().aclose()

    upstream = Transport(lambda request: httpx.Response(204))
    ready = Transport(lambda request: httpx.Response(200))
    app = create_app(Settings(), upstream_transport=upstream, ready_transport=ready)
    with pytest.raises(RuntimeError, match="owner failure"):
        async with app.router.lifespan_context(app):
            raise RuntimeError("owner failure")
    assert upstream.closed and ready.closed
    assert not app.state.initialized


async def test_startup_invalid_config_is_sanitized(monkeypatch, capsys):
    monkeypatch.setenv("INGEST_PROMETHEUS_WRITE_URL", "http://user:private-startup-sentinel@prometheus:9090/api/v1/write")
    app = create_app()
    with pytest.raises(RuntimeError) as failure:
        async with app.router.lifespan_context(app):
            pytest.fail("startup must fail")
    assert str(failure.value) == "Invalid ingestion gateway configuration."
    assert failure.value.__suppress_context__
    assert "private-startup-sentinel" not in str(failure.value) + capsys.readouterr().err
    assert not app.state.initialized


def test_import_and_factory_perform_no_io(monkeypatch):
    import app.main as main

    def forbidden(*args, **kwargs):
        raise AssertionError("clients and settings must be deferred to lifespan")

    with monkeypatch.context() as patch:
        patch.setattr(httpx, "AsyncClient", forbidden)
        patch.setenv("INGEST_MAX_INFLIGHT", "private-invalid-setting")
        reloaded = importlib.reload(main)
        patch.setattr(reloaded, "Settings", forbidden)
        created = reloaded.create_app()
        assert not created.state.initialized
    importlib.reload(main)


async def test_production_client_and_transport_bounds(monkeypatch):
    clients, transports = [], []
    original_client, original_transport = httpx.AsyncClient, httpx.AsyncHTTPTransport

    def client_factory(*args, **kwargs):
        instance = original_client(*args, **kwargs)
        clients.append((instance, kwargs))
        return instance

    def transport_factory(*args, **kwargs):
        instance = original_transport(*args, **kwargs)
        transports.append((instance, kwargs))
        return instance

    monkeypatch.setattr(httpx, "AsyncClient", client_factory)
    monkeypatch.setattr(httpx, "AsyncHTTPTransport", transport_factory)
    app = create_app(Settings(max_inflight=3))
    async with app.router.lifespan_context(app):
        assert app.state.initialized
    assert len(clients) == len(transports) == 2
    assert all(instance.is_closed for instance, _ in clients)
    assert clients[0][0] is not clients[1][0]
    for _, options in clients:
        assert options["trust_env"] is False
        assert options["follow_redirects"] is False
    for (_, options), expected_limit in zip(transports, (3, 2), strict=True):
        assert options["retries"] == 0
        assert options["trust_env"] is False
        assert options["limits"].max_connections == expected_limit
        assert options["limits"].max_keepalive_connections == expected_limit


async def test_readiness_cancellation_propagates(app_client):
    entered, block = asyncio.Event(), asyncio.Event()

    async def ready(request):
        entered.set()
        await block.wait()
        return httpx.Response(200)

    async with app_client(ready_transport=httpx.MockTransport(ready)) as (_, client):
        task = asyncio.create_task(client.get("/health/ready"))
        try:
            await asyncio.wait_for(entered.wait(), 1)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        finally:
            block.set()
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
