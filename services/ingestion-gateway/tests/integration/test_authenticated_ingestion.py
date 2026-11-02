"""Authenticated boundary tests using the real provider, signer and codec."""
import asyncio
import base64
import hashlib
import threading
from pathlib import Path

import cramjam
import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization

from app.config import Settings
from app.proto.remote_write_pb2 import WriteRequest

PATH = '/api/v1/ingest/remote-write'


@pytest.mark.parametrize('omitted', [{b'x-server-id'}, {b'x-agent-id'}, {b'x-server-id', b'x-agent-id'}])
async def test_missing_claims_derive_trusted_identity(app_client, headers, make_write, pack_write, active_proof, omitted):
    calls = []
    without_claims = [(k, v) for k, v in headers if k not in omitted]
    async with app_client(upstream_transport=httpx.MockTransport(
            lambda request: calls.append(request) or httpx.Response(204))) as (_, client):
        response = await client.post(PATH, headers=without_claims, content=pack_write(make_write()))
    assert response.status_code == 204
    assert len(calls) == 1
    decoded = WriteRequest.FromString(bytes(cramjam.snappy.decompress_raw(calls[0].content)))
    assert [(label.name, label.value) for label in decoded.timeseries[0].labels] == [
        ('__name__', 'infrapulse_unit_value'), ('agent_id', active_proof['agent_id']),
        ('server_id', active_proof['server_id']),
    ]
    assert 'authorization' not in calls[0].headers


@pytest.mark.parametrize('claim', [b'x-server-id', b'x-agent-id'])
async def test_conflicting_claim_is_forbidden(app_client, headers, claim):
    calls, body_reads = [], []
    forged = [(k, b'forged-identity' if k == claim else v) for k, v in headers]
    async def body():
        body_reads.append(True)
        yield b'unread'

    async with app_client(upstream_transport=httpx.MockTransport(
            lambda request: calls.append(request) or httpx.Response(204))) as (_, client):
        response = await client.post(PATH, headers=forged, content=body())
    assert response.status_code == 403
    assert response.json()['code'] == 'identity_mismatch'
    assert calls == [] and body_reads == []


async def test_old_arbitrary_lab_bearer_is_not_authenticated(app_client, headers, make_write, pack_write):
    calls = []
    old = [(k, b'Bearer arbitrary-lab-token-not-a-secret' if k == b'authorization' else v) for k, v in headers]
    async with app_client(upstream_transport=httpx.MockTransport(
            lambda request: calls.append(request) or httpx.Response(204))) as (_, client):
        response = await client.post(PATH, headers=old, content=pack_write(make_write()))
    assert response.status_code == 401
    assert response.json()['code'] == 'invalid_authorization'
    assert calls == []


@pytest.mark.parametrize('outcome,status,code', [
    ('inactive', 401, 'invalid_authorization'), ('malformed', 503, 'credential_verification_unavailable'),
    (401, 503, 'credential_verification_unavailable'), (403, 503, 'credential_verification_unavailable'),
    (429, 503, 'credential_verification_unavailable'), (503, 503, 'credential_verification_unavailable'),
    (302, 503, 'credential_verification_unavailable'), ('network', 503, 'credential_verification_unavailable'),
    ('timeout', 503, 'credential_verification_unavailable'), ('unexpected', 503, 'credential_verification_unavailable'),
])
async def test_auth_failure_precedes_body_and_worker(app_client, headers, outcome, status, code, monkeypatch):
    calls, bodies = [], []
    block = asyncio.Event()
    async def management(request):
        calls.append(request)
        if outcome == 'network':
            raise httpx.ConnectError('private-auth-sentinel')
        if outcome == 'unexpected':
            raise RuntimeError('private-auth-sentinel')
        if outcome == 'timeout':
            await block.wait()
        if outcome == 'inactive':
            return httpx.Response(200, json={'active': False})
        if outcome == 'malformed':
            return httpx.Response(200, json={'active': True})
        return httpx.Response(outcome, headers={'Location': 'http://other.test/'})
    async def body():
        bodies.append(True)
        raise AssertionError('unauthenticated body must not be read')
        yield b''
    def worker(*args):
        raise AssertionError('unauthenticated worker must not run')
    monkeypatch.setattr('app.pipeline.decode_write', worker)
    async with app_client(Settings(credential_timeout_seconds=0.02),
            management_transport=httpx.MockTransport(management),
            upstream_transport=httpx.MockTransport(lambda request: pytest.fail('must not forward'))) as (app, client):
        response = await client.post(PATH, headers=headers, content=body())
        assert app.state.pipeline.admission.inflight == 0
    assert response.status_code == status
    assert response.json()['code'] == code
    assert response.headers.get('www-authenticate') == ('Bearer' if status == 401 else None)
    assert len(calls) == 1 and bodies == []


async def test_auth_lease_no_queue_cancel_and_independent_readiness(app_client, headers, management_reply, make_write, pack_write):
    entered, release = asyncio.Event(), asyncio.Event()
    auth_calls, ready_calls, body_reads = [], [], []
    loop_thread = threading.get_ident()
    async def management(request):
        auth_calls.append(request)
        assert threading.get_ident() == loop_thread
        if len(auth_calls) == 2:
            entered.set()
        await release.wait()
        return management_reply(request)
    def ready(request):
        ready_calls.append(request)
        return httpx.Response(204)
    async def body():
        body_reads.append(True)
        yield pack_write(make_write())
    async with app_client(management_transport=httpx.MockTransport(management),
            management_ready_transport=httpx.MockTransport(ready)) as (app, client):
        tasks = [asyncio.create_task(client.post(PATH, headers=headers, content=body())) for _ in range(2)]
        try:
            await asyncio.wait_for(entered.wait(), 1)
            assert app.state.pipeline.admission.inflight == 2
            assert app.state.pipeline.codec_limiter.borrowed_tokens == 0
            assert body_reads == []
            assert (await client.post(PATH, headers=headers, content=b'unread')).status_code == 429
            assert len(auth_calls) == 2
            assert (await client.get('/health/live')).status_code == 200
            assert (await asyncio.wait_for(client.get('/health/ready'), 0.5)).status_code == 200
            assert len(ready_calls) == 1
            tasks[0].cancel()
            with pytest.raises(asyncio.CancelledError):
                await tasks[0]
            assert app.state.pipeline.admission.inflight == 1
        finally:
            release.set()
            results = await asyncio.gather(*tasks, return_exceptions=True)
        assert isinstance(results[0], asyncio.CancelledError)
        assert results[1].status_code == 204
        assert app.state.pipeline.admission.inflight == 0
        assert body_reads == [True]
        assert (await client.post(PATH, headers=headers, content=pack_write(make_write()))).status_code == 204
        assert len(auth_calls) == 2  # positive cache from second request, not an anonymous fallback


async def test_signature_binding_once_loaded_signer_and_positive_cache(app_client, headers, signing_key_file,
        management_reply, make_write, pack_write, monkeypatch):
    public_key = serialization.load_pem_private_key(signing_key_file.read_bytes(), password=None).public_key()
    calls, assertions = [], []
    def verify(request):
        token = request.headers['authorization'].removeprefix('Bearer ')
        claims = jwt.decode(token, public_key, algorithms=['EdDSA'],
            issuer='infrapulse-gateway', audience='infrapulse-management-internal')
        assert jwt.get_unverified_header(token) == {'alg': 'EdDSA', 'kid': 'test-gateway-1', 'typ': 'JWT'}
        assert claims['sub'] == '00000000-0000-4000-8000-000000000004'
        assert claims['kind'] == 'service' and not {'scopes', 'role', 'grafana_role'} & claims.keys()
        assert claims['m'] == request.method
        assert claims['t'] == request.url.raw_path.decode('ascii')
        assert claims['b'] == base64.urlsafe_b64encode(hashlib.sha256(request.content).digest()).rstrip(b'=').decode()
        assertions.append(claims['jti'])
        calls.append(request)
        return httpx.Response(204) if request.method == 'GET' else management_reply(request)
    async with app_client(management_transport=httpx.MockTransport(verify),
            management_ready_transport=httpx.MockTransport(verify)) as (_, client):
        def forbidden_open(*args, **kwargs):
            raise AssertionError('signer must load key only at lifespan startup')
        with monkeypatch.context() as patch:
            patch.setattr(Path, 'open', forbidden_open)
            payload = pack_write(make_write())
            for _ in range(2):
                assert (await client.post(PATH, headers=headers, content=payload)).status_code == 204
                assert (await client.get('/health/ready')).status_code == 200
    assert len(calls) == 3  # one verify plus two independently signed readiness probes
    assert len(set(assertions)) == 3


@pytest.mark.parametrize('bad', ['malformed', 'duplicate'])
async def test_claim_syntax_fails_before_lookup_or_body(app_client, headers, bad):
    from tests.integration.test_ingestion import raw_request
    raw = ([(k, b'invalid/claim' if k == b'x-agent-id' else v) for k, v in headers]
           if bad == 'malformed' else headers + [(b'X-Agent-ID', b'duplicate')])
    async def receive():
        pytest.fail('invalid claim must not read body')
    async with app_client(management_transport=httpx.MockTransport(
            lambda request: pytest.fail('invalid claim must not reach credential lookup'))) as (app, _):
        status, _, body = await raw_request(app, raw, receive=receive)
        assert status == 400 and body['code'] == 'invalid_identity'
        assert app.state.pipeline.admission.inflight == 0


async def test_cache_outage_boundary_and_readiness_are_independent(app_client, headers, management_reply, make_write, pack_write):
    calls, forwarded = [], []
    def management(request):
        calls.append(request)
        return management_reply(request) if len(calls) == 1 else httpx.Response(503)
    async with app_client(Settings(credential_cache_ttl_seconds=0.2),
            management_transport=httpx.MockTransport(management),
            management_ready_transport=httpx.MockTransport(lambda request: httpx.Response(503)),
            upstream_transport=httpx.MockTransport(lambda request: forwarded.append(request) or httpx.Response(204))) as (app, client):
        payload = pack_write(make_write())
        assert (await client.post(PATH, headers=headers, content=payload)).status_code == 204
        assert (await client.get('/health/ready')).status_code == 503
        assert (await client.post(PATH, headers=headers, content=payload)).status_code == 204
        assert len(calls) == 1
        loop = asyncio.get_running_loop()
        expired = loop.create_future()
        timer = loop.call_later(0.25, expired.set_result, None)
        try:
            await expired
        finally:
            timer.cancel()
        response = await client.post(PATH, headers=headers, content=payload)
        assert response.status_code == 503 and response.json()['code'] == 'credential_verification_unavailable'
        assert app.state.pipeline.admission.inflight == 0
    assert len(calls) == len(forwarded) == 2


async def test_direct_legacy_identity_cannot_bypass_provider(app_client, identity, received_at_ms):
    bodies = []
    async def body():
        bodies.append(True)
        yield b'never'
    async with app_client(upstream_transport=httpx.MockTransport(lambda request: pytest.fail('must not forward'))) as (app, _):
        with pytest.raises((TypeError, AttributeError)):
            await app.state.pipeline.handle(body(), identity, received_at_ms=received_at_ms)
        assert app.state.pipeline.admission.inflight == 0
    assert bodies == []
