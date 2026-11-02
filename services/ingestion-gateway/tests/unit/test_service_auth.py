"""Task8 signing and real HTTPX boundary tests (no running backend required)."""
import asyncio
import base64
from dataclasses import FrozenInstanceError
import hashlib
import time
from uuid import UUID

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519
import httpx
import jwt
import pytest

from app.errors import GatewayError
from app.service_auth import ServiceSigner
from app.management_client import ManagementResponse, SignedManagementClient


@pytest.fixture
def keypair(tmp_path):
    private = ed25519.Ed25519PrivateKey.generate()
    path = tmp_path / 'service-private.pem'
    path.write_bytes(private.private_bytes(serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    return path, private.public_key()


def signer_for(path, **kwargs):
    return ServiceSigner(path, issuer='infrapulse-gateway',
        audience='infrapulse-management-internal', subject='gateway-stable-id',
        kid='gateway-1', **kwargs)


def claims(token, public):
    # A merely decodable or unsigned JWT must not pass these tests.
    return jwt.decode(token, public, algorithms=['EdDSA'],
        issuer='infrapulse-gateway', audience='infrapulse-management-internal')


def test_signatures_bind_exact_bytes_raw_target_method_and_fresh_nonce(keypair):
    path, public = keypair
    signer = signer_for(path)
    body = b'{ "api_key" : "synthetic" }\n'
    tokens = [signer.sign('post', '/a%2fb?x=2&x=1', body) for _ in range(2)]
    decoded = [claims(token, public) for token in tokens]
    for token, value in zip(tokens, decoded):
        assert jwt.get_unverified_header(token) == {'alg': 'EdDSA', 'kid': 'gateway-1', 'typ': 'JWT'}
        assert value['m'] == 'POST'
        assert value['t'] == '/a%2fb?x=2&x=1'
        assert value['b'] == base64.urlsafe_b64encode(hashlib.sha256(body).digest()).rstrip(b'=').decode()
        assert value['sub'] == 'gateway-stable-id'
        assert value['kind'] == 'service'
        assert value['nbf'] == value['iat']
        assert 0 < value['exp'] - value['iat'] <= 60
        assert all(type(value[field]) is int for field in ('iat', 'nbf', 'exp'))
        assert str(UUID(value['jti'])) == value['jti']
        assert not {'scopes', 'ctx', 'grafana_role', 'display'} & value.keys()
    assert decoded[0]['jti'] != decoded[1]['jti']
    changed = claims(signer.sign('GET', '/a%2Fb?x=1&x=2', b''), public)
    assert changed['m'] != decoded[0]['m']
    assert changed['t'] != decoded[0]['t']
    assert changed['b'] == '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU'
    assert 'PRIVATE' not in repr(signer)
    assert 'gateway-stable-id' not in repr(signer)


@pytest.mark.parametrize('ttl', [0, 61, True, 1.5, float('nan')])
def test_signer_rejects_invalid_assertion_ttl(keypair, ttl):
    with pytest.raises(GatewayError) as caught:
        signer_for(keypair[0], ttl_seconds=ttl)
    assert caught.value.code == 'credential_verification_unavailable'


@pytest.mark.parametrize('kind', ['missing', 'malformed', 'ec', 'public'])
def test_signing_key_failures_are_sanitized_and_wrong_key_types_rejected(tmp_path, kind):
    path = tmp_path / 'sensitive-path.pem'
    if kind == 'malformed':
        path.write_bytes(b'private-material-not-a-pem')
    elif kind == 'ec':
        path.write_bytes(ec.generate_private_key(ec.SECP256R1()).private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    elif kind == 'public':
        path.write_bytes(ed25519.Ed25519PrivateKey.generate().public_key().public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))
    with pytest.raises(GatewayError) as caught:
        signer_for(path)
    assert (caught.value.status_code, caught.value.code) == (503, 'credential_verification_unavailable')
    assert 'sensitive-path' not in str(caught.value)
    assert 'private-material' not in repr(caught.value)
    assert caught.value.__cause__ is None
    assert caught.value.__suppress_context__


class Body(httpx.AsyncByteStream):
    def __init__(self, chunks=(), *, block=False, close_block=False, error=False):
        self.chunks = chunks
        self.block = block
        self.close_block = close_block
        self.error = error
        self.entered = asyncio.Event()
        self.closed = 0
        self.reads = 0

    async def __aiter__(self):
        self.entered.set()
        if self.block:
            await asyncio.Event().wait()
        if self.error:
            raise httpx.ReadError('private transport details')
        for chunk in self.chunks:
            self.reads += 1
            yield chunk

    async def aclose(self):
        self.closed += 1
        if self.close_block:
            await asyncio.Event().wait()


async def test_explicit_requests_do_not_merge_defaults_and_sign_wire_bytes(keypair):
    calls = []
    async def transport(request):
        calls.append(request)
        return httpx.Response(409, stream=Body([b'bounded-', b'conflict']), headers={'Set-Cookie': 'external=x'})
    async with httpx.AsyncClient(transport=httpx.MockTransport(transport), trust_env=False,
        auth=('private-user', 'private-password'), follow_redirects=True, timeout=99,
        headers={'X-Default': 'private', 'Authorization': 'Basic private'},
        cookies={'private': 'cookie'}, params={'private': 'query'}) as client:
        rpc = SignedManagementClient(client, signer_for(keypair[0]), 'http://management.example')
        body = b'{ "x": 1 }\n'
        for _ in range(2):
            result = await rpc.request('post', '/raw%2fpath?b=2&a=1', body)
            assert result == ManagementResponse(409, b'bounded-conflict')
            assert 'bounded-conflict' not in repr(result)
            with pytest.raises(FrozenInstanceError):
                result.status_code = 200
        assert not client.is_closed
        assert client.headers['X-Default'] == 'private'
    assert len(calls) == 2
    nonces = []
    for request in calls:
        assert request.content == body
        assert request.url.raw_path == b'/raw%2fpath?b=2&a=1'
        assert set(request.headers) == {'host', 'content-length', 'content-type', 'authorization'}
        assert request.headers['content-type'] == 'application/json'
        token = request.headers['authorization'].removeprefix('Bearer ')
        value = claims(token, keypair[1])
        assert value['m'] == request.method
        assert value['t'].encode() == request.url.raw_path
        assert value['b'] == base64.urlsafe_b64encode(hashlib.sha256(request.content).digest()).rstrip(b'=').decode()
        nonces.append(value['jti'])
        assert request.extensions['timeout'] == dict(connect=2, read=2, write=2, pool=2)
    assert nonces[0] != nonces[1]


@pytest.mark.parametrize('size,ok', [(8192, True), (8193, False)])
async def test_rpc_caps_actual_stream_bytes_and_closes(keypair, size, ok):
    stream = Body([b'a' * 4096, b'b' * (size - 4096), b'never-read'])
    # The exact cap case ends at 8192; overflow must stop before third chunk.
    if ok:
        stream.chunks = stream.chunks[:2]
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, stream=stream)), trust_env=False) as client:
        rpc = SignedManagementClient(client, signer_for(keypair[0]), 'http://management.example')
        if ok:
            assert len((await rpc.request('POST', '/verify', b'{}')).body) == 8192
        else:
            with pytest.raises(GatewayError) as caught:
                await rpc.request('POST', '/verify', b'{}')
            assert caught.value.status_code == 503
            assert stream.reads == 2
    assert stream.closed == 1


@pytest.mark.parametrize('location', ['http://redirect.example/target', 'http://bad:invalid/private', 'http://[::gg]/private'])
async def test_redirects_never_follow_and_malformed_location_is_safe_unavailable(keypair, location):
    stream = Body([b'redirect body'])
    calls = []
    def transport(request):
        calls.append(request)
        return httpx.Response(307, stream=stream, headers={'Location': location})
    async with httpx.AsyncClient(transport=httpx.MockTransport(transport), trust_env=False, follow_redirects=True) as client:
        rpc = SignedManagementClient(client, signer_for(keypair[0]), 'http://management.example')
        if location.startswith('http://redirect'):
            assert (await rpc.request('GET', '/health')).status_code == 307
        else:
            with pytest.raises(GatewayError) as caught:
                await rpc.request('GET', '/health')
            assert caught.value.status_code == 503
            assert 'private' not in str(caught.value)
            assert stream.reads == 0
    assert len(calls) == 1
    assert stream.closed == 1


@pytest.mark.parametrize('phase', ['send', 'read', 'close'])
async def test_total_deadline_includes_send_read_and_close(keypair, phase):
    stream = Body([b'{}'], block=phase == 'read', close_block=phase == 'close')
    async def transport(request):
        if phase == 'send':
            await asyncio.Event().wait()
        return httpx.Response(200, stream=stream)
    async with httpx.AsyncClient(transport=httpx.MockTransport(transport), trust_env=False) as client:
        rpc = SignedManagementClient(client, signer_for(keypair[0]), 'http://management.example', timeout_seconds=0.03)
        started = time.monotonic()
        with pytest.raises(GatewayError) as caught:
            await asyncio.wait_for(rpc.request('POST', '/verify'), 0.5)
        assert time.monotonic() - started < 0.5
        assert caught.value.status_code == 503
    if phase != 'send':
        assert stream.closed == 1


async def test_cancellation_propagates_after_closing_unread_response(keypair):
    stream = Body(block=True)
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, stream=stream)), trust_env=False) as client:
        rpc = SignedManagementClient(client, signer_for(keypair[0]), 'http://management.example')
        task = asyncio.create_task(rpc.request('POST', '/verify'))
        await asyncio.wait_for(stream.entered.wait(), 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert stream.closed == 1
        assert not client.is_closed


async def test_transport_and_read_failure_are_single_attempt_sanitized(keypair):
    for fail_send in (True, False):
        calls = []
        stream = Body(error=True)
        def transport(request):
            calls.append(request)
            if fail_send:
                raise httpx.ConnectError('private details', request=request)
            return httpx.Response(200, stream=stream)
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport), trust_env=False) as client:
            rpc = SignedManagementClient(client, signer_for(keypair[0]), 'http://management.example')
            with pytest.raises(GatewayError) as caught:
                await rpc.request('POST', '/verify')
            assert caught.value.status_code == 503
            assert 'private' not in repr(caught.value)
        assert len(calls) == 1
        assert stream.closed == (0 if fail_send else 1)


@pytest.mark.parametrize('base', ['http://user:password@host', 'http://host?secret=x', 'http://host/prefix', 'ftp://host', 'http://host#fragment'])
def test_client_rejects_unsafe_base_url(keypair, base):
    client = httpx.AsyncClient(trust_env=False)
    with pytest.raises(GatewayError):
        SignedManagementClient(client, signer_for(keypair[0]), base)


async def test_client_requires_no_environment_proxy_and_rejects_target_normalization(keypair):
    async with httpx.AsyncClient(trust_env=True) as client:
        with pytest.raises(GatewayError):
            SignedManagementClient(client, signer_for(keypair[0]), 'http://management.example')
    health_calls = []
    def health_transport(request):
        __tracebackhide__ = True
        health_calls.append(request.url.raw_path == b'/internal/v1/credentials/health')
        assert request.method == 'GET'
        assert request.url.raw_path == b'/internal/v1/credentials/health'
        assert request.content == b''
        verified = claims(request.headers['authorization'].removeprefix('Bearer '), keypair[1])
        assert verified['kind'] == 'service'
        assert verified['b'] == '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU'
        return httpx.Response(204)
    async with httpx.AsyncClient(transport=httpx.MockTransport(health_transport), trust_env=False) as client:
        rpc = SignedManagementClient(client, signer_for(keypair[0]), 'http://management.example')
        for target in ('//other.example/x', 'http://other.example/x', '/a/../b', '/x#fragment', '/x y', '/\nprivate'):
            with pytest.raises(GatewayError):
                await rpc.request('GET', target)
        # Health is a separate signed request with no real API key payload.
        assert (await rpc.request('GET', '/internal/v1/credentials/health')).status_code == 204
        assert health_calls == [True]  # Invalid raw targets never reached transport.
