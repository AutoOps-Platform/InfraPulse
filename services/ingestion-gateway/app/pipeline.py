"""No-queue admission and bounded, whole-batch ingestion processing."""

import asyncio
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass

import anyio

from app.codec import decode_write, encode_write
from app.config import Settings
from app.errors import GatewayError
from app.forwarder import Forwarder, ForwardResult
from app.identity import Identity
from app.validation import validate_and_normalize


class AdmissionLease:
    def __init__(self, controller: "AdmissionController"):
        self._controller = controller
        self._released = False

    def release(self) -> None:
        if not self._released:
            self._released = True
            self._controller.inflight -= 1


class AdmissionController:
    """Only used on the app event loop; acquisition has no await or queue."""

    def __init__(self, settings: Settings, *, monotonic: Callable[[], float]):
        self._settings = settings
        self._monotonic = monotonic
        self._updated_at = monotonic()
        self._tokens = float(settings.rate_burst)
        self.inflight = 0

    def acquire(self) -> AdmissionLease:
        if self.inflight >= self._settings.max_inflight:
            raise GatewayError(429, "concurrency_limited", retry_after=1)
        now = self._monotonic()
        self._tokens = min(
            self._settings.rate_burst,
            self._tokens + max(0.0, now - self._updated_at) * self._settings.rate_per_second,
        )
        self._updated_at = now
        if self._tokens < 1:
            raise GatewayError(429, "rate_limited", retry_after=1)
        self._tokens -= 1
        self.inflight += 1
        return AdmissionLease(self)


@dataclass(frozen=True)
class PipelineResult:
    forward: ForwardResult
    series_count: int
    sample_count: int


class IngestionPipeline:
    def __init__(self, settings: Settings, admission: AdmissionController, forwarder: Forwarder):
        self.settings = settings
        self.admission = admission
        self.forwarder = forwarder
        self.codec_limiter = anyio.CapacityLimiter(settings.max_inflight)
        self.observer = None

    def _decode_validate_encode(
        self, payload: bytes, identity: Identity, received_at_ms: int,
    ) -> tuple[bytes, int, int]:
        message = decode_write(payload, self.settings)
        batch = validate_and_normalize(
            message, identity, self.settings, received_at_ms=received_at_ms,
        )
        encoded = encode_write(batch.message, self.settings)
        return encoded, batch.series_count, batch.sample_count

    async def _run_codec(
        self, payload: bytes, identity: Identity, received_at_ms: int,
    ) -> tuple[bytes, int, int]:
        # AnyIO shielding alone does not protect against raw asyncio.Task.cancel().
        # Keep a strong reference to a shielded child and join it even on repeated
        # cancellation. The lease cannot be released while its thread is running.
        worker = asyncio.create_task(anyio.to_thread.run_sync(
            self._decode_validate_encode, payload, identity, received_at_ms,
            abandon_on_cancel=False, limiter=self.codec_limiter,
        ))
        cancellation = None
        while not worker.done():
            try:
                await asyncio.shield(worker)
            except asyncio.CancelledError as exc:
                cancellation = exc
            except Exception:
                if cancellation is not None:
                    raise cancellation from None
                raise
        if cancellation is not None:
            if not worker.cancelled():
                worker.exception()  # retrieve an error without forwarding after cancellation
            raise cancellation
        return worker.result()

    async def handle(
        self, stream: AsyncIterator[bytes], identity: Identity, *, received_at_ms: int,
    ) -> PipelineResult:
        lease = self.admission.acquire()
        if self.observer is not None:
            self.observer.inflight(1)
        try:
            payload = bytearray()
            try:
                async with asyncio.timeout(self.settings.body_read_timeout_seconds):
                    async for chunk in stream:
                        if len(payload) + len(chunk) > self.settings.max_compressed_bytes:
                            raise GatewayError(413, "payload_too_large")
                        payload.extend(chunk)
            except TimeoutError:
                raise GatewayError(408, "body_timeout") from None
            encoded, series_count, sample_count = await self._run_codec(
                bytes(payload), identity, received_at_ms,
            )
            if self.observer is not None:
                self.observer._parsed(series_count, sample_count)
            result = await self.forwarder.forward(encoded)
            return PipelineResult(result, series_count, sample_count)
        finally:
            lease.release()
            if self.observer is not None:
                self.observer.inflight(-1)
