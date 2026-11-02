"""Strict credential proof and non-sliding monotonic positive-cache contracts."""
import asyncio
from dataclasses import FrozenInstanceError
from datetime import datetime, timedelta, timezone
import json
from uuid import uuid4

import pytest

from app.credentials import CredentialConfig, CredentialProvider, VerifiedCredential
from app.errors import GatewayError
from app.identity import Identity
from app.management_client import ManagementResponse


CID = '11111111-1111-4111-8111-111111111111'
SID = '22222222-2222-4222-8222-222222222222'
AID = '33333333-3333-4333-8333-333333333333'
KEY = CID + '.' + 'A' * 43
OTHER = CID + '.' + 'B' * 43
NOW = datetime(2026, 11, 1, tzinfo=timezone.utc)


class Clock:
    def __init__(self):
        self.ms = 0
    def monotonic(self):
        return self.ms / 1000
    def now(self):
        return NOW + timedelta(milliseconds=self.ms)
    def advance(self, ms):
        self.ms += ms


def active(**changes):
    return dict(active=True, credential_id=CID, server_id=SID, agent_id=AID,
        scopes=['metrics:write', 'provisioning:read'], expires_at='2026-11-01T00:10:00.000Z',
        cache_ttl_ms=30000) | changes


def response(value, status=200):
    return ManagementResponse(status, json.dumps(value).encode())


class Backend:
    """External RPC only is doubled; real provider serialization/parsing/cache run."""
    def __init__(self, clock, value=None, delay=0):
        self.clock = clock
        self.value = response(active()) if value is None else value
        self.delay = delay
        self.calls = []
    async def request(self, method, path, body=b''):
        __tracebackhide__ = True  # Hide synthetic key/body arguments, not errors.
        # Keep only non-secret metadata in the fixture too.
        assert method == 'POST'
        assert path == '/internal/v1/credentials/verify'
        parsed = json.loads(body)
        assert set(parsed) == {'api_key'}
        self.calls.append(parsed['api_key'] == KEY)
        self.clock.advance(self.delay)
        if isinstance(self.value, BaseException):
            raise self.value
        return self.value


def provider_for(backend, clock, **config):
    return CredentialProvider(CredentialConfig('http://management.example', **config),
        backend, monotonic=clock.monotonic, wall_clock=clock.now)


async def test_proof_is_immutable_token_free_and_cache_expires_at_exact_boundary():
    clock = Clock()
    backend = Backend(clock)
    provider = provider_for(backend, clock)
    proof = await provider.verify(KEY)
    assert proof == VerifiedCredential(CID, Identity(SID, AID),
        frozenset({'metrics:write', 'provisioning:read'}), datetime(2026, 11, 1, 0, 10, tzinfo=timezone.utc))
    with pytest.raises(FrozenInstanceError):
        proof.credential_id = SID
    backend.value = GatewayError(503, 'credential_verification_unavailable')
    clock.advance(29999)
    assert await provider.verify(KEY) == proof
    assert len(backend.calls) == 1
    clock.advance(1)
    with pytest.raises(GatewayError) as caught:
        await provider.verify(KEY)
    assert (caught.value.status_code, caught.value.code) == (503, 'credential_verification_unavailable')
    assert len(backend.calls) == 2
    assert KEY not in repr(provider.__dict__)
    assert KEY not in repr(proof)
    assert not hasattr(proof, 'api_key')


async def test_whole_credential_fingerprint_no_negative_cache_and_no_shared_process_key():
    clock = Clock()
    backend = Backend(clock)
    provider = provider_for(backend, clock)
    proof = await provider.verify(KEY)
    backend.value = response({'active': False})
    for _ in range(2):
        with pytest.raises(GatewayError) as caught:
            await provider.verify(OTHER)
        assert (caught.value.status_code, caught.value.code) == (401, 'invalid_authorization')
    assert await provider.verify(KEY) == proof
    assert len(backend.calls) == 3
    other = provider_for(Backend(clock), clock)
    await other.verify(KEY)
    # Inspect state as a token-leak probe, not a public testing-only API.
    assert KEY not in repr(provider.__dict__)
    assert OTHER not in repr(provider.__dict__)
    assert set(provider._cache) != set(other._cache)
    assert all(isinstance(item, bytes) and len(item) == 32 for item in provider._cache)


@pytest.mark.parametrize('ttl,remaining_ok', [(30000, True), (1000, False)])
async def test_slow_rpc_deadline_is_measured_before_call(ttl, remaining_ok):
    clock = Clock()
    backend = Backend(clock, response(active(cache_ttl_ms=ttl)), delay=1900)
    provider = provider_for(backend, clock)
    if remaining_ok:
        proof = await provider.verify(KEY)
        backend.value = GatewayError(503, 'credential_verification_unavailable')
        clock.advance(28099)
        assert await provider.verify(KEY) == proof
        clock.advance(1)
    with pytest.raises(GatewayError) as caught:
        await provider.verify(KEY)
    assert caught.value.status_code == 503
    assert not provider._cache


async def test_effective_expiry_is_conservative_without_wall_clock_extension():
    clock = Clock()
    backend = Backend(clock, response(active(expires_at='2026-11-01T00:00:00.500Z')))
    provider = provider_for(backend, clock)
    proof = await provider.verify(KEY)
    backend.value = GatewayError(503, 'credential_verification_unavailable')
    clock.advance(499)
    assert await provider.verify(KEY) == proof
    clock.advance(1)
    with pytest.raises(GatewayError) as caught:
        await provider.verify(KEY)
    assert caught.value.status_code == 503


async def test_configured_ttl_is_shorter_never_sliding():
    clock = Clock()
    backend = Backend(clock)
    provider = provider_for(backend, clock, ttl_seconds=1)
    proof = await provider.verify(KEY)
    clock.advance(999)
    assert await provider.verify(KEY) == proof
    clock.advance(1)
    backend.value = response({'active': False})
    with pytest.raises(GatewayError) as caught:
        await provider.verify(KEY)
    assert caught.value.status_code == 401


@pytest.mark.parametrize('status', [199, 201, 204, 301, 302, 307, 400, 401, 403, 409, 429, 500, 503])
async def test_every_non200_is_dependency_unavailable_never_invalid_key(status):
    clock = Clock()
    backend = Backend(clock, response({'active': False}, status))
    provider = provider_for(backend, clock)
    for _ in range(2):
        with pytest.raises(GatewayError) as caught:
            await provider.verify(KEY)
        assert (caught.value.status_code, caught.value.code) == (503, 'credential_verification_unavailable')
    assert len(backend.calls) == 2
    assert not provider._cache


INVALID = [
    b'', b'not-json', b'[]', b'null', b'{"active":false,"active":false}',
    b'{"active":NaN}', b'{"active":false,"secret":"private-value"}',
    b'{"active":0}', b'{"active":1}', b'{"active":"true"}',
    b'\xff', b'{"active":true}',
]
INVALID += [json.dumps(active(**{field: value})).encode() for field, value in [
    ('cache_ttl_ms', 0), ('cache_ttl_ms', 30001), ('cache_ttl_ms', True),
    ('cache_ttl_ms', '30000'), ('cache_ttl_ms', 1.1), ('cache_ttl_ms', float('nan')),
    ('cache_ttl_ms', float('inf')), ('credential_id', CID.upper().replace('1', 'A', 1)),
    ('credential_id', 'bad'), ('server_id', None), ('agent_id', True),
    ('scopes', []), ('scopes', ['metrics:write', 'metrics:write']),
    ('scopes', ['admin']), ('scopes', 'metrics:write'), ('scopes', [True]),
    ('expires_at', '2026-11-01T00:10:00'), ('expires_at', '2026-11-01T01:10:00+01:00'),
    ('expires_at', '2026-11-01'), ('expires_at', '2026-11-01T00:00:00.000Z'),
    ('expires_at', '2026-11-01T24:10:00Z'), ('expires_at', True),
    ('secret_hash', 'private-value'), ('api_key', 'private-value'),
]]
INVALID += [json.dumps({k: v for k, v in active().items() if k != field}).encode()
    for field in active()]
INVALID += [b'{' + b'"active":true,' + json.dumps(active())[1:].encode(), b' ' * 8193]


@pytest.mark.parametrize('body', INVALID, ids=lambda value: 'invalid-proof')
async def test_malformed_duplicate_private_or_noncanonical_proof_is_never_cached(body):
    clock = Clock()
    backend = Backend(clock, ManagementResponse(200, body))
    provider = provider_for(backend, clock)
    for _ in range(2):
        with pytest.raises(GatewayError) as caught:
            await provider.verify(KEY)
        assert (caught.value.status_code, caught.value.code) == (503, 'credential_verification_unavailable')
        assert 'private-value' not in repr(caught.value)
        assert caught.value.__cause__ is None
    assert len(backend.calls) == 2
    assert not provider._cache


async def test_metric_scope_missing_is_inconsistent_dependency_proof_not_invalid_key():
    clock = Clock()
    backend = Backend(clock, response(active(scopes=['provisioning:read'])))
    provider = provider_for(backend, clock)
    with pytest.raises(GatewayError) as caught:
        await provider.verify(KEY)
    assert caught.value.status_code == 503
    assert not provider._cache


async def test_lru_eviction_and_expired_entry_removal_never_offer_stale_fallback():
    clock = Clock()
    backend = Backend(clock)
    provider = provider_for(backend, clock, max_entries=2)
    second = str(uuid4()) + '.' + 'C' * 43
    third = str(uuid4()) + '.' + 'D' * 43
    await provider.verify(KEY)
    clock.advance(100)
    await provider.verify(second)
    await provider.verify(KEY)  # LRU touch, no deadline refresh.
    await provider.verify(third)
    assert len(provider._cache) == 2
    backend.value = GatewayError(503, 'credential_verification_unavailable')
    with pytest.raises(GatewayError):
        await provider.verify(second)
    clock.advance(29900)
    with pytest.raises(GatewayError):
        await provider.verify(KEY)
    assert await provider.verify(third)
    assert len(provider._cache) == 1
    clock.advance(100)
    with pytest.raises(GatewayError):
        await provider.verify(third)
    assert not provider._cache


async def test_cancel_propagates_and_is_not_cached():
    clock = Clock()
    backend = Backend(clock, asyncio.CancelledError())
    provider = provider_for(backend, clock)
    with pytest.raises(asyncio.CancelledError):
        await provider.verify(KEY)
    assert not provider._cache
    backend.value = response(active())
    assert await provider.verify(KEY)
    assert len(backend.calls) == 2


async def test_provider_configured_timeout_bounds_even_an_unresponsive_port():
    clock = Clock()
    class StalledBackend:
        async def request(self, method, path, body=b''):
            __tracebackhide__ = True  # Do not render RPC body arguments on failure.
            await asyncio.Event().wait()
    provider = provider_for(StalledBackend(), clock, timeout_seconds=0.02)
    try:
        with pytest.raises(GatewayError) as caught:
            await asyncio.wait_for(provider.verify(KEY), 0.3)
        assert caught.value.status_code == 503
    finally:
        assert not provider._cache


@pytest.mark.parametrize('overrides', [
    {'max_entries': 0}, {'max_entries': 10001}, {'max_entries': True},
    {'ttl_seconds': 0}, {'ttl_seconds': 31}, {'ttl_seconds': float('nan')},
    {'ttl_seconds': True}, {'timeout_seconds': 0}, {'timeout_seconds': 2.1},
    {'timeout_seconds': float('inf')}, {'timeout_seconds': True},
])
def test_config_bounds_are_finite_strict_and_separate_from_global_settings(overrides):
    with pytest.raises(ValueError) as caught:
        CredentialConfig('http://management.example', **overrides)
    assert 'management.example' not in str(caught.value)


@pytest.mark.parametrize('key', ['', 'x' * 4097, 'bad\ud800', 'bad\nkey', None])
async def test_invalid_local_key_input_has_finite_error_without_outbound_lookup(key):
    clock = Clock()
    backend = Backend(clock)
    provider = provider_for(backend, clock)
    with pytest.raises(GatewayError) as caught:
        await provider.verify(key)
    assert (caught.value.status_code, caught.value.code) == (401, 'invalid_authorization')
    assert not backend.calls


def test_config_defaults_are_frozen_and_cache_cap_can_reach_10000():
    config = CredentialConfig('http://management.example')
    assert 'management.example' not in repr(config)
    assert (config.timeout_seconds, config.ttl_seconds, config.max_entries) == (2, 30, 1024)
    assert CredentialConfig('http://management.example', max_entries=10000).max_entries == 10000
    with pytest.raises(FrozenInstanceError):
        config.ttl_seconds = 99
