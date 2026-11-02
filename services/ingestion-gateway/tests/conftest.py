"""Shared fixtures; signed HTTP boundaries never use the real network."""

import os
import json
from datetime import datetime, timedelta, timezone

import pytest


@pytest.fixture(scope='session')
def signing_key_file(tmp_path_factory):
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives import serialization
    path = tmp_path_factory.mktemp('signer') / 'private.pem'
    key = Ed25519PrivateKey.generate()
    path.write_bytes(key.private_bytes(serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    return path


@pytest.fixture(autouse=True)
def isolated_ingest_environment(request, monkeypatch):
    if request.node.get_closest_marker('e2e') is not None:
        return
    for name in tuple(os.environ):
        if name.upper().startswith('INGEST_'):
            monkeypatch.delenv(name)
    path = request.getfixturevalue('signing_key_file')
    for name, value in {
        'MANAGEMENT_BASE_URL': 'http://management:3000',
        'GATEWAY_ID': '00000000-0000-4000-8000-000000000004',
        'SERVICE_KEY_ID': 'test-gateway-1',
        'SERVICE_SIGNING_KEY_FILE': str(path),
    }.items():
        monkeypatch.setenv('INGEST_' + name, value)


@pytest.fixture
def settings():
    from app.config import Settings
    return Settings()


@pytest.fixture
def identity():
    from app.identity import Identity
    return Identity('srv-lab', 'agent-lab')


@pytest.fixture
def active_proof():
    return {
        'active': True,
        'credential_id': '00000000-0000-4000-8000-000000000001',
        'server_id': '00000000-0000-4000-8000-000000000002',
        'agent_id': '00000000-0000-4000-8000-000000000003',
        'scopes': ['metrics:write'],
        'expires_at': (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
        'cache_ttl_ms': 30000,
    }


@pytest.fixture
def api_key():
    return '00000000-0000-4000-8000-000000000001.' + 'a' * 43


@pytest.fixture
def management_reply(active_proof, api_key):
    """A test external service, not a provider or pipeline authentication stub."""
    import httpx
    def reply(request):
        assert request.method == 'POST'
        assert request.url.raw_path == b'/internal/v1/credentials/verify'
        assert set(json.loads(request.content)) == {'api_key'}
        proof = active_proof if json.loads(request.content)['api_key'] == api_key else {'active': False}
        return httpx.Response(200, json=proof)
    return reply


@pytest.fixture
def received_at_ms():
    return 1800000000000


@pytest.fixture
def headers(api_key, active_proof):
    return [
        (b'authorization', ('Bearer ' + api_key).encode()),
        (b'x-server-id', active_proof['server_id'].encode()),
        (b'x-agent-id', active_proof['agent_id'].encode()),
        (b'content-type', b'application/x-protobuf'),
        (b'content-encoding', b'snappy'),
        (b'x-prometheus-remote-write-version', b'0.1.0'),
        (b'user-agent', b'infrapulse-test/0.1.0'),
    ]


@pytest.fixture
def make_write(received_at_ms):
    from app.proto.remote_write_pb2 import WriteRequest

    def make(labels=None, samples=None):
        message = WriteRequest()
        series = message.timeseries.add()
        for name, value in labels if labels is not None else [('__name__', 'infrapulse_unit_value')]:
            series.labels.add(name=name, value=value)
        for value, timestamp in samples if samples is not None else [(1.0, received_at_ms)]:
            series.samples.add(value=value, timestamp=timestamp)
        return message
    return make


@pytest.fixture
def pack_write():
    import cramjam
    def pack(message):
        return bytes(cramjam.snappy.compress_raw(message.SerializeToString()))
    return pack


@pytest.fixture
def app_client(monkeypatch, received_at_ms, management_reply):
    from contextlib import asynccontextmanager
    import httpx
    from app.main import create_app

    monkeypatch.setattr('app.routes.ingest.utc_now_ms', lambda: received_at_ms)

    @asynccontextmanager
    async def open_client(settings=None, upstream_transport=None, ready_transport=None,
                          management_transport=None, management_ready_transport=None, reporter_transport=None):
        app = create_app(settings,
            upstream_transport=upstream_transport or httpx.MockTransport(lambda request: httpx.Response(204)),
            ready_transport=ready_transport or httpx.MockTransport(lambda request: httpx.Response(200)),
            management_transport=management_transport or httpx.MockTransport(management_reply),
            management_ready_transport=management_ready_transport or httpx.MockTransport(lambda request: httpx.Response(204)),
            reporter_transport=reporter_transport or httpx.MockTransport(lambda request: httpx.Response(503)),
        )
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://gateway.test') as client:
                yield app, client
    return open_client
