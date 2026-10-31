"""One-attempt, status-only forwarding through a lifespan-owned HTTPX client."""

import asyncio
from dataclasses import dataclass
import time

import httpx

from app.config import Settings
from app.errors import GatewayError


_STATUS_ONLY_EXTENSION = "infrapulse.ingestion_gateway.status_only"
_STATUS_ONLY_MARKER = object()


async def _ignore_redirect_location(response: httpx.Response) -> None:
    # HTTPX prepares redirect URLs even when follow_redirects=False. Location
    # is irrelevant to our status-only contract; never parse an untrusted value.
    if (
        response.request.extensions.get(_STATUS_ONLY_EXTENSION) is _STATUS_ONLY_MARKER
        and 300 <= response.status_code < 400
    ):
        response.headers.pop("Location", None)


FORWARD_RESULTS = frozenset({
    "accepted", "rejected", "too_large", "rate_limited", "unavailable", "timeout", "bad_status",
})


@dataclass(frozen=True)
class ForwardResult:
    status_code: int
    result: str
    upstream_status: int | None = None
    error_code: str | None = None
    retry_after: int | None = None


def _retry_after(headers: httpx.Headers) -> int:
    values = headers.get_list("Retry-After")
    if len(values) != 1:
        return 1
    value = values[0]
    if not value.isascii() or not value.isdigit():
        return 1
    # Bound integer conversion too, including arbitrarily long numeric headers.
    significant = value.lstrip("0")
    if not 1 <= len(significant) <= 2:
        return 1
    seconds = int(significant)
    return seconds if 1 <= seconds <= 60 else 1


def _classify(response: httpx.Response) -> ForwardResult:
    status = response.status_code
    if 200 <= status < 300:
        return ForwardResult(204, "accepted", status)
    if status == 400:
        return ForwardResult(400, "rejected", status, "upstream_rejected")
    if status == 413:
        return ForwardResult(413, "too_large", status, "upstream_too_large")
    if status == 429:
        return ForwardResult(
            429, "rate_limited", status, "upstream_rate_limited", _retry_after(response.headers),
        )
    if 500 <= status < 600:
        return ForwardResult(503, "unavailable", status, "upstream_unavailable")
    return ForwardResult(502, "bad_status", status, "upstream_bad_status")


class Forwarder:
    def __init__(self, client: httpx.AsyncClient, settings: Settings):
        self._client = client
        self._settings = settings
        self.observer = None
        # Install once per shared client, not during individual attempts. Keep
        # existing hooks intact; the internal marker isolates unrelated traffic.
        response_hooks = client.event_hooks["response"]
        if _ignore_redirect_location not in response_hooks:
            response_hooks.append(_ignore_redirect_location)

    async def forward(self, payload: bytes) -> ForwardResult:
        started = None
        observed_result = "bad_status"
        try:
            async with asyncio.timeout(self._settings.upstream_deadline_seconds):
                timeout = httpx.Timeout(
                    connect=self._settings.connect_timeout_seconds,
                    read=self._settings.read_timeout_seconds,
                    write=self._settings.write_timeout_seconds,
                    pool=self._settings.pool_timeout_seconds,
                )
                # An explicit Request avoids merging shared-client headers,
                # cookies or query parameters. Do not mutate shared defaults.
                request = httpx.Request(
                    "POST",
                    self._settings.prometheus_write_url,
                    content=payload,
                    headers={
                        "Content-Type": "application/x-protobuf",
                        "Content-Encoding": "snappy",
                        "X-Prometheus-Remote-Write-Version": "0.1.0",
                        "User-Agent": "infrapulse-ingestion-gateway/0.1.0",
                    },
                    extensions={
                        "timeout": timeout.as_dict(),
                        _STATUS_ONLY_EXTENSION: _STATUS_ONLY_MARKER,
                    },
                )
                started = time.monotonic()
                response = await self._client.send(
                    request, stream=True, auth=None, follow_redirects=False,
                )
                try:
                    if self.observer is not None:
                        self.observer._upstream_status(response.status_code)
                    result = _classify(response)
                finally:
                    await response.aclose()
                observed_result = result.result
                return result
        except (TimeoutError, httpx.TimeoutException):
            observed_result = "timeout"
            return ForwardResult(504, "timeout", error_code="upstream_timeout")
        except (httpx.NetworkError, httpx.RemoteProtocolError):
            observed_result = "unavailable"
            return ForwardResult(503, "unavailable", error_code="upstream_unavailable")
        except asyncio.CancelledError:
            observed_result = "unavailable"
            raise
        except Exception:
            # Cancellation is a BaseException and intentionally propagates.
            # Unexpected failures use the existing finite public error boundary.
            raise GatewayError(500, "internal_error") from None
        finally:
            if self.observer is not None and started is not None:
                self.observer.record_forward(
                    result=observed_result, duration_seconds=time.monotonic() - started,
                )
