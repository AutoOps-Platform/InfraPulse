"""Per-app bounded metrics and allowlisted JSON logging at the ASGI boundary."""

from contextvars import ContextVar
from datetime import datetime, timezone
import json
import logging
import math
import sys
import time
from uuid import UUID, uuid4

from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram, generate_latest
from prometheus_client.exposition import CONTENT_TYPE_LATEST

from app.errors import ERROR_CODES, ERROR_MESSAGES
from app.forwarder import FORWARD_RESULTS


_INGEST_ROUTE = "/api/v1/ingest/remote-write"
_ROUTES = frozenset({_INGEST_ROUTE, "/health/live", "/health/ready", "/metrics"})
_STATUSES = frozenset({204, 400, 401, 408, 413, 415, 429, 500, 502, 503, 504})
_EVENTS = frozenset({"request_completed", "identity_unverified", "lab_only", "server_error"})
_LOGGER = logging.getLogger("infrapulse.ingest")


def new_request_id() -> str:
    return uuid4().hex


def _uuid(value: object) -> str | None:
    if isinstance(value, str):
        try:
            parsed = UUID(value)
            if parsed.version == 4:
                return parsed.hex
        except ValueError:
            pass
    return None


def _number(value: object) -> bool:
    return type(value) in {int, float} and math.isfinite(value) and value >= 0


class _JSONFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        # Never format msg/args, exception text, stack info or arbitrary extras.
        fields = getattr(record, "gateway_fields", {})
        data = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "event": fields.get("event") if fields.get("event") in _EVENTS else "server_error",
            "request_id": _uuid(fields.get("request_id")),
            "route": fields.get("route") if fields.get("route") in _ROUTES else "unmatched",
        }
        for name in ("status", "duration_ms", "series_count", "sample_count", "upstream_status"):
            value = fields.get(name)
            if _number(value):
                data[name] = value
        if fields.get("error_code") in ERROR_CODES:
            data["error_code"] = fields["error_code"]
        return json.dumps(data, allow_nan=False, separators=(",", ":"))


class _StdoutHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        # Resolve stdout at emission time (also works across lifespan/test captures).
        sys.stdout.write(self.format(record) + "\n")
        sys.stdout.flush()


_HANDLER = _StdoutHandler()
_HANDLER.setFormatter(_JSONFormatter())


def configure_logging(level: str) -> None:
    for name in ("infrapulse.ingest", "httpx", "httpcore", "uvicorn", "uvicorn.error", "uvicorn.access"):
        logger = logging.getLogger(name)
        logger.handlers[:] = [_HANDLER]
        logger.propagate = False
        logger.setLevel(max(logging.WARNING, logging.getLevelName(level))
                        if name in {"httpx", "httpcore"} else level)


def log_event(
    event: str, *, request_id: str | None = None, route: str,
    status: int | None = None, duration_ms: float | None = None,
    series_count: int | None = None, sample_count: int | None = None,
    upstream_status: int | None = None, error_code: str | None = None,
) -> None:
    fields = {
        "event": event, "request_id": request_id, "route": route, "status": status,
        "duration_ms": duration_ms, "series_count": series_count, "sample_count": sample_count,
        "upstream_status": upstream_status, "error_code": error_code,
    }
    if event in {"identity_unverified", "lab_only"}:
        level = logging.WARNING
    else:
        level = logging.ERROR if status == 500 else logging.INFO
    _LOGGER.log(level, "", extra={"gateway_fields": fields})


class Observability:
    def __init__(self, registry: CollectorRegistry | None = None):
        self.registry = registry if registry is not None else CollectorRegistry()
        self._context: ContextVar[dict | None] = ContextVar("ingestion_observation", default=None)
        prefix = "infrapulse_ingest_"
        self._requests = Counter(prefix + "requests_total", "Completed ingestion requests.", ["status"], registry=self.registry)
        self._request_duration = Histogram(prefix + "request_duration_seconds", "Ingestion duration.", ["status_class"], registry=self.registry)
        self._inflight = Gauge(prefix + "inflight_requests", "Active ingestion admission leases.", registry=self.registry)
        self._rejections = Counter(prefix + "rejections_total", "Ingestion failures by finite code.", ["reason"], registry=self.registry)
        self._forwards = Counter(prefix + "forward_attempts_total", "Completed upstream attempts.", ["result"], registry=self.registry)
        self._upstream_duration = Histogram(prefix + "upstream_duration_seconds", "Upstream attempt duration.", ["result"], registry=self.registry)

    def record_request(self, *, status: int, duration_seconds: float, reason: str | None) -> None:
        status = status if status in _STATUSES else 500
        self._requests.labels(str(status)).inc()
        self._request_duration.labels(f"{status // 100}xx").observe(duration_seconds)
        if reason is not None:
            self._rejections.labels(reason if reason in ERROR_CODES else "internal_error").inc()

    def record_forward(self, *, result: str, duration_seconds: float) -> None:
        result = result if result in FORWARD_RESULTS else "bad_status"
        self._forwards.labels(result).inc()
        self._upstream_duration.labels(result).observe(duration_seconds)

    def inflight(self, delta: int) -> None:
        self._inflight.inc(delta)

    def _parsed(self, series_count: int, sample_count: int) -> None:
        fields = self._context.get()
        if fields is not None:
            fields.update(series_count=series_count, sample_count=sample_count)

    def _upstream_status(self, status: int) -> None:
        fields = self._context.get()
        if fields is not None:
            fields["upstream_status"] = status


class _ObservationMiddleware:
    def __init__(self, app, observer: Observability):
        self.app = app
        self.observer = observer

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        started = time.monotonic()
        state = scope.setdefault("state", {})
        state["request_id"] = new_request_id()
        fields = {}
        token = self.observer._context.set(fields)
        status, response_started = 500, False

        async def observed_send(message):
            nonlocal status, response_started
            if message["type"] == "http.response.start":
                status, response_started = message["status"], True
                # Task 5's route generates its own internal UUID before any await.
                # Adopt that ID for both response and completion; never read client headers.
                state["request_id"] = _uuid(state.get("request_id")) or new_request_id()
                message = {**message, "headers": [
                    (name, value) for name, value in message.get("headers", []) if name.lower() != b"x-request-id"
                ] + [(b"x-request-id", state["request_id"].encode("ascii"))]}
            await send(message)

        try:
            try:
                await self.app(scope, receive, observed_send)
            except Exception:
                # No exception object/traceback crosses into ServerErrorMiddleware/Uvicorn.
                status = 500
                state["error_code"] = "internal_error"
                if not response_started:
                    response = JSONResponse(status_code=500, content={
                        "code": "internal_error", "message": ERROR_MESSAGES["internal_error"],
                        "request_id": state["request_id"],
                    })
                    await response(scope, receive, observed_send)
        finally:
            try:
                duration = time.monotonic() - started
                reason = state.get("error_code")
                if not response_started:
                    reason = "internal_error"  # Includes cancellation; never swallow BaseException.
                route = getattr(scope.get("route"), "path", None)
                route = route if route in _ROUTES else "unmatched"
                if scope["method"] == "POST" and scope["path"] == _INGEST_ROUTE:
                    self.observer.record_request(status=status, duration_seconds=duration, reason=reason)
                log_event("request_completed", request_id=state["request_id"], route=route,
                          status=status, duration_ms=duration * 1000, error_code=reason, **fields)
            finally:
                self.observer._context.reset(token)


def install_observability(app: FastAPI, observer: Observability) -> None:
    app.state.observability = observer

    @app.get("/metrics", include_in_schema=False)
    async def metrics() -> Response:
        return Response(generate_latest(observer.registry), headers={"Content-Type": CONTENT_TYPE_LATEST})

    app.add_middleware(_ObservationMiddleware, observer=observer)
