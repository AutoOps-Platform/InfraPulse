"""Bounded signed RPC over an externally-owned, dedicated HTTPX pool.

The owner must supply a no-retry transport and trust_env=False, and keep this
pool separate from forwarding, readiness, and reporting pools. No app wiring
is performed here. HTTPX's redirect validation is intentionally preserved:
malformed Location fails closed and HTTPX closes its still-unread response.
"""
import asyncio
from dataclasses import dataclass, field
import math
import re

import httpx

from app.errors import GatewayError
from app.service_auth import ServiceSigner


@dataclass(frozen=True)
class ManagementResponse:
    status_code: int
    body: bytes = field(repr=False)


def _base_url(value: str) -> httpx.URL:
    url = httpx.URL(value)
    if (url.scheme not in ('http', 'https') or not url.host or url.userinfo
            or url.raw_path != b'/' or url.query or url.fragment):
        raise ValueError()
    return url


class SignedManagementClient:
    def __init__(self, client: httpx.AsyncClient, signer: ServiceSigner,
                 base_url: str, *, timeout_seconds: float = 2):
        try:
            if (client.trust_env or isinstance(timeout_seconds, bool)
                    or not math.isfinite(timeout_seconds) or not 0 < timeout_seconds <= 2):
                raise ValueError()
            self._base = _base_url(base_url)
        except Exception:
            raise GatewayError(503, 'credential_verification_unavailable') from None
        self._client = client
        self._signer = signer
        self._timeout = timeout_seconds

    async def request(self, method: str, path: str, body: bytes = b'') -> ManagementResponse:
        try:
            async with asyncio.timeout(self._timeout) as total:
                if (not isinstance(path, str) or not path.startswith('/') or path.startswith('//')
                        or re.search(r'[\x00-\x20\x7f#]', path) or type(body) is not bytes):
                    raise ValueError()
                # Construct first, then bind precisely the target and bytes actually sent.
                url = self._base.copy_with(raw_path=path.encode('ascii'))
                if url.raw_path != path.encode('ascii'):
                    raise ValueError()
                request = httpx.Request(method, url, content=body,
                    headers={'Content-Type': 'application/json'},
                    extensions={'timeout': httpx.Timeout(self._timeout).as_dict()})
                if request.url.raw_path != path.encode('ascii'):
                    raise ValueError()
                request.headers['Authorization'] = 'Bearer ' + self._signer.sign(
                    request.method, request.url.raw_path.decode('ascii'), body)
                response = await self._client.send(request, stream=True, auth=None, follow_redirects=False)
                try:
                    # Reject encoding before iteration to prevent decompression
                    # amplification. aiter_bytes also accepts already-empty 204s.
                    if response.headers.get('Content-Encoding', 'identity').lower() != 'identity':
                        raise ValueError()
                    chunks = bytearray()
                    async for chunk in response.aiter_bytes():
                        if len(chunk) > 8192 - len(chunks):
                            raise ValueError()
                        chunks.extend(chunk)
                    result = ManagementResponse(response.status_code, bytes(chunks))
                finally:
                    # Even when the read consumes the deadline or the caller cancels,
                    # attempt close, but never turn cleanup into an unbounded wait.
                    remaining = max(0, total.when() - asyncio.get_running_loop().time())
                    async with asyncio.timeout(remaining):
                        await response.aclose()
                return result
        except asyncio.CancelledError:
            raise
        except Exception:
            # Never retain HTTPX request URLs, tokens, response bodies or PEM errors.
            raise GatewayError(503, 'credential_verification_unavailable') from None
