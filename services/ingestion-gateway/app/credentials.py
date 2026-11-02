"""Strict token-free proof and bounded, non-sliding positive credential cache."""
import asyncio
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import hmac
import json
import math
import re
import secrets
import time
from typing import Callable, Protocol

from app.errors import GatewayError
from app.identity import Identity
from app.management_client import ManagementResponse, _base_url


@dataclass(frozen=True)
class CredentialConfig:
    # Deliberately independent of Settings until the Task9 integration gate.
    base_url: str = field(repr=False)
    timeout_seconds: float = 2
    ttl_seconds: float = 30
    max_entries: int = 1024

    def __post_init__(self):
        try:
            _base_url(self.base_url)
            if (type(self.max_entries) is not int or not 1 <= self.max_entries <= 10000
                    or any(isinstance(value, bool) or not math.isfinite(value)
                           or not 0 < value <= maximum
                           for value, maximum in ((self.timeout_seconds, 2), (self.ttl_seconds, 30)))):
                raise ValueError()
        except Exception:
            raise ValueError('Invalid credential configuration') from None


@dataclass(frozen=True)
class VerifiedCredential:
    credential_id: str
    identity: Identity
    scopes: frozenset[str]
    expires_at: datetime


@dataclass(frozen=True)
class _Entry:
    proof: VerifiedCredential
    deadline: float


class _ManagementPort(Protocol):
    async def request(self, method: str, path: str, body: bytes = b'') -> ManagementResponse: ...


_UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
_UTC = re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)')
_SCOPES = frozenset({'metrics:write', 'provisioning:read', 'config:report'})
_FIELDS = frozenset({'active', 'credential_id', 'server_id', 'agent_id', 'scopes', 'expires_at', 'cache_ttl_ms'})


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError()
        result[key] = value
    return result


def _reject_constant(value):
    raise ValueError()


def _parse(body: bytes) -> tuple[VerifiedCredential, int] | None:
    if type(body) is not bytes or len(body) > 8192:
        raise ValueError()
    data = json.loads(body.decode('utf-8'), object_pairs_hook=_object, parse_constant=_reject_constant)
    if type(data) is not dict or type(data.get('active')) is not bool:
        raise ValueError()
    if data['active'] is False:
        if set(data) != {'active'}:
            raise ValueError()
        return None
    if set(data) != _FIELDS:
        raise ValueError()
    for name in ('credential_id', 'server_id', 'agent_id'):
        if type(data[name]) is not str or _UUID.fullmatch(data[name]) is None:
            raise ValueError()
    ttl = data['cache_ttl_ms']
    if type(ttl) is not int or not 1 <= ttl <= 30000:
        raise ValueError()
    scopes = data['scopes']
    if (type(scopes) is not list or not 1 <= len(scopes) <= 3
            or any(type(scope) is not str or scope not in _SCOPES for scope in scopes)
            or len(set(scopes)) != len(scopes) or 'metrics:write' not in scopes):
        raise ValueError()
    expiry = data['expires_at']
    if type(expiry) is not str or _UTC.fullmatch(expiry) is None:
        raise ValueError()
    expires_at = datetime.fromisoformat(expiry.replace('Z', '+00:00'))
    return VerifiedCredential(data['credential_id'], Identity(data['server_id'], data['agent_id']),
                              frozenset(scopes), expires_at), ttl


class CredentialProvider:
    """Caller admission bounds cold misses; no singleflight table or negative cache.

    Each lifespan provider has a process-local CSPRNG HMAC key, never persisted.
    Wall time can only shorten the server's TTL; cache decisions are monotonic.
    """
    def __init__(self, config: CredentialConfig, client: _ManagementPort, *,
                 monotonic: Callable[[], float] = time.monotonic,
                 wall_clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc)):
        self._config = config
        self._client = client
        self._monotonic = monotonic
        self._wall_clock = wall_clock
        self._fingerprint_key = secrets.token_bytes(32)
        self._cache: OrderedDict[bytes, _Entry] = OrderedDict()

    async def verify(self, api_key: str) -> VerifiedCredential:
        if (not isinstance(api_key, str) or not 1 <= len(api_key) <= 4096 or not api_key.isascii()
                or re.search(r'[\x00-\x20\x7f]', api_key)):
            raise GatewayError(401, 'invalid_authorization')
        fingerprint = hmac.digest(self._fingerprint_key, api_key.encode('utf-8'), hashlib.sha256)
        t0 = self._monotonic()
        for key, entry in list(self._cache.items()):
            if t0 >= entry.deadline:
                del self._cache[key]
        entry = self._cache.get(fingerprint)
        if entry is not None:
            self._cache.move_to_end(fingerprint)
            return entry.proof
        try:
            wall_start = self._wall_clock()
            body = json.dumps({'api_key': api_key}, separators=(',', ':'), ensure_ascii=True).encode('utf-8')
            if len(body) > 8192:
                raise ValueError()
            async with asyncio.timeout(self._config.timeout_seconds):
                response = await self._client.request('POST', '/internal/v1/credentials/verify', body)
            if response.status_code != 200:
                raise ValueError()
            parsed = _parse(response.body)
            if parsed is not None:
                proof, ttl_ms = parsed
                deadline = t0 + min(ttl_ms / 1000, self._config.ttl_seconds,
                                    (proof.expires_at - wall_start).total_seconds())
                if self._monotonic() >= deadline:
                    raise ValueError()
        except Exception:
            raise GatewayError(503, 'credential_verification_unavailable') from None
        if parsed is None:
            raise GatewayError(401, 'invalid_authorization')
        self._cache[fingerprint] = _Entry(proof, deadline)
        self._cache.move_to_end(fingerprint)
        while len(self._cache) > self._config.max_entries:
            self._cache.popitem(last=False)
        return proof
