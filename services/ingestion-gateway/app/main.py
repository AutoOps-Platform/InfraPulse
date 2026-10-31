"""Application factory with lifespan-owned, isolated HTTP connection pools."""

from contextlib import asynccontextmanager
import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import httpx
from pydantic import ValidationError

from app.config import Settings
from app.errors import GatewayError
from app.forwarder import Forwarder
from app.observability import Observability, configure_logging, install_observability, log_event, new_request_id
from app.pipeline import AdmissionController, IngestionPipeline
from app.routes import health, ingest


def create_app(
    settings: Settings | None = None, *,
    upstream_transport: httpx.AsyncBaseTransport | None = None,
    ready_transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI):
        try:
            resolved = settings if settings is not None else Settings()
        except ValidationError:
            raise RuntimeError("Invalid ingestion gateway configuration.") from None
        configure_logging(resolved.log_level)
        log_event("identity_unverified", route="unmatched")
        log_event("lab_only", route="unmatched")
        application.state.settings = resolved
        forward_limits = httpx.Limits(
            max_connections=resolved.max_inflight, max_keepalive_connections=resolved.max_inflight,
        )
        ready_limits = httpx.Limits(max_connections=2, max_keepalive_connections=2)
        timeout = httpx.Timeout(
            connect=resolved.connect_timeout_seconds, read=resolved.read_timeout_seconds,
            write=resolved.write_timeout_seconds, pool=resolved.pool_timeout_seconds,
        )
        try:
            async with httpx.AsyncClient(
                transport=upstream_transport if upstream_transport is not None else httpx.AsyncHTTPTransport(
                    retries=0, limits=forward_limits, trust_env=False,
                ),
                limits=forward_limits, timeout=timeout, trust_env=False, follow_redirects=False,
            ) as forward_client:
                async with httpx.AsyncClient(
                    transport=ready_transport if ready_transport is not None else httpx.AsyncHTTPTransport(
                        retries=0, limits=ready_limits, trust_env=False,
                    ),
                    limits=ready_limits, timeout=resolved.ready_timeout_seconds,
                    trust_env=False, follow_redirects=False,
                ) as ready_client:
                    application.state.pipeline = IngestionPipeline(
                        resolved, AdmissionController(resolved, monotonic=time.monotonic),
                        Forwarder(forward_client, resolved),
                    )
                    application.state.pipeline.observer = application.state.observability
                    application.state.pipeline.forwarder.observer = application.state.observability
                    application.state.ready_client = ready_client
                    application.state.initialized = True
                    yield
        finally:
            application.state.initialized = False

    application = FastAPI(lifespan=lifespan)
    application.state.initialized = False
    install_observability(application, Observability())

    @application.exception_handler(GatewayError)
    async def gateway_error(request: Request, error: GatewayError) -> JSONResponse:
        request_id = getattr(request.state, "request_id", None) or new_request_id()
        request.state.error_code = error.code
        headers = {"X-Request-ID": request_id}
        if error.status_code == 401:
            headers["WWW-Authenticate"] = "Bearer"
        if error.retry_after is not None:
            headers["Retry-After"] = str(error.retry_after)
        return JSONResponse(
            status_code=error.status_code,
            content={"code": error.code, "message": error.message, "request_id": request_id},
            headers=headers,
        )

    application.include_router(ingest.router)
    application.include_router(health.router)
    return application


app = create_app()
