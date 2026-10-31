"""Raw-header and streaming HTTP boundary; never buffer an uncapped body."""

from collections.abc import AsyncIterator
import time
from uuid import uuid4

from fastapi import APIRouter, Request, Response

from app.errors import GatewayError
from app.identity import parse_ingest_headers


router = APIRouter()


def utc_now_ms() -> int:
    return time.time_ns() // 1_000_000


def _content_length(raw_headers: list[tuple[bytes, bytes]], cap: int) -> int | None:
    lengths = [value.strip(b" \t") for name, value in raw_headers if name.lower() == b"content-length"]
    if not lengths:
        return None
    if len(lengths) != 1 or not lengths[0] or any(byte < 48 or byte > 57 for byte in lengths[0]):
        raise GatewayError(400, "invalid_content_length")
    # Compare before int conversion: arbitrary digit counts cannot bypass the cap
    # or trigger Python's integer-string limit (including leading-zero lengths).
    significant = lengths[0].lstrip(b"0") or b"0"
    limit = str(cap).encode("ascii")
    if len(significant) > len(limit) or (len(significant) == len(limit) and significant > limit):
        raise GatewayError(413, "payload_too_large")
    return int(significant)


@router.post("/api/v1/ingest/remote-write")
async def ingest_remote_write(request: Request) -> Response:
    request.state.request_id = uuid4().hex
    try:
        received_at_ms = utc_now_ms()
        raw_headers = request.scope["headers"]
        identity = parse_ingest_headers(raw_headers)
        declared = _content_length(raw_headers, request.app.state.settings.max_compressed_bytes)

        async def stream() -> AsyncIterator[bytes]:
            actual = 0
            async for chunk in request.stream():
                actual += len(chunk)
                yield chunk  # pipeline independently enforces cap before appending
            if declared is not None and actual != declared:
                raise GatewayError(400, "invalid_content_length")

        result = await request.app.state.pipeline.handle(
            stream(), identity, received_at_ms=received_at_ms,
        )
        if result.forward.error_code is not None:
            raise GatewayError(
                result.forward.status_code, result.forward.error_code,
                retry_after=result.forward.retry_after,
            )
        return Response(status_code=204, headers={"X-Request-ID": request.state.request_id})
    except GatewayError:
        raise
    except Exception:
        # Convert here rather than leaking through ServerErrorMiddleware/Uvicorn.
        # BaseException (notably asyncio cancellation) deliberately propagates.
        raise GatewayError(500, "internal_error") from None
