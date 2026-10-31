"""Shared unit fixtures; never clear a real app or E2E environment."""

import os

import pytest


@pytest.fixture(autouse=True)
def isolated_ingest_environment(request, monkeypatch):
    if request.node.get_closest_marker("e2e") is not None:
        return
    for name in tuple(os.environ):
        if name.upper().startswith("INGEST_"):
            monkeypatch.delenv(name)


@pytest.fixture
def settings():
    from app.config import Settings

    return Settings()


@pytest.fixture
def identity():
    from app.identity import Identity

    return Identity("srv-lab", "agent-lab")


@pytest.fixture
def received_at_ms():
    return 1800000000000


@pytest.fixture
def headers():
    return [
        (b"authorization", b"Bearer arbitrary-lab-token-not-a-secret"),
        (b"x-server-id", b"srv-lab"),
        (b"x-agent-id", b"agent-lab"),
        (b"content-type", b"application/x-protobuf"),
        (b"content-encoding", b"snappy"),
        (b"x-prometheus-remote-write-version", b"0.1.0"),
        (b"user-agent", b"infrapulse-test/0.1.0"),
    ]


@pytest.fixture
def make_write(received_at_ms):
    from app.proto.remote_write_pb2 import WriteRequest

    def make(
        labels: list[tuple[str, str]] | None = None,
        samples: list[tuple[float, int]] | None = None,
    ) -> WriteRequest:
        message = WriteRequest()
        series = message.timeseries.add()
        for name, value in (
            labels if labels is not None else [("__name__", "infrapulse_unit_value")]
        ):
            series.labels.add(name=name, value=value)
        for value, timestamp in (
            samples if samples is not None else [(1.0, received_at_ms)]
        ):
            series.samples.add(value=value, timestamp=timestamp)
        return message

    return make


@pytest.fixture
def pack_write():
    import cramjam

    from app.proto.remote_write_pb2 import WriteRequest

    def pack(message: WriteRequest) -> bytes:
        return bytes(cramjam.snappy.compress_raw(message.SerializeToString()))

    return pack


@pytest.fixture
def app_client(monkeypatch, received_at_ms):
    from contextlib import asynccontextmanager

    import httpx

    from app.main import create_app

    monkeypatch.setattr("app.routes.ingest.utc_now_ms", lambda: received_at_ms)

    @asynccontextmanager
    async def open_client(settings=None, upstream_transport=None, ready_transport=None):
        app = create_app(
            settings,
            upstream_transport=upstream_transport or httpx.MockTransport(
                lambda request: httpx.Response(204)
            ),
            ready_transport=ready_transport or httpx.MockTransport(
                lambda request: httpx.Response(200)
            ),
        )
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://gateway.test"
            ) as client:
                yield app, client

    return open_client
