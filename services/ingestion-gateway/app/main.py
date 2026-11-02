"""Application factory with lifespan-owned, isolated HTTP connection pools."""

from contextlib import AsyncExitStack, asynccontextmanager
import asyncio
import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import httpx

from app.config import Settings
from app.credentials import CredentialConfig, CredentialProvider
from app.errors import GatewayError
from app.management_client import SignedManagementClient
from app.service_auth import ServiceSigner
from app.forwarder import Forwarder
from app.observability import Observability, configure_logging, install_observability, log_event, new_request_id
from app.pipeline import AdmissionController, IngestionPipeline
from app.routes import health, ingest
from app.status_reporter import StatusReporter


async def _finish_cleanup(stack: AsyncExitStack) -> None:
    # Raw repeated Task.cancel() must not interrupt one client's close and skip
    # the rest. Own one cleanup task and join it before propagating cancellation.
    task = asyncio.create_task(stack.aclose(), name='ingest-lifespan-cleanup')
    cancellation = None
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError as exc:
            cancellation = exc
    task.result()
    if cancellation is not None:
        raise cancellation


@asynccontextmanager
async def _owned_stack():
    stack = AsyncExitStack()
    try:
        yield stack
    finally:
        await _finish_cleanup(stack)


def create_app(
    settings: Settings | None = None, *,
    upstream_transport: httpx.AsyncBaseTransport | None = None,
    ready_transport: httpx.AsyncBaseTransport | None = None,
    management_transport: httpx.AsyncBaseTransport | None = None,
    management_ready_transport: httpx.AsyncBaseTransport | None = None,
    reporter_transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI):
        try:
            resolved = settings if settings is not None else Settings()
            signer = ServiceSigner(resolved.service_signing_key_file,
                issuer='infrapulse-gateway', audience='infrapulse-management-internal',
                subject=resolved.gateway_id, kid=resolved.service_key_id)
            credential_config = CredentialConfig(resolved.management_base_url,
                timeout_seconds=resolved.credential_timeout_seconds,
                ttl_seconds=resolved.credential_cache_ttl_seconds,
                max_entries=resolved.credential_cache_max_entries)
        except Exception:
            # Configuration and private-key failures never expose values or causes.
            raise RuntimeError("Invalid ingestion gateway configuration.") from None
        configure_logging(resolved.log_level)
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
        async def owned_client(stack, transport, limits, deadline):
            return await stack.enter_async_context(httpx.AsyncClient(
                transport=transport if transport is not None else httpx.AsyncHTTPTransport(
                    retries=0, limits=limits, trust_env=False),
                limits=limits, timeout=deadline, trust_env=False, follow_redirects=False,
            ))

        try:
            async with _owned_stack() as stack:
                forward_client = await owned_client(stack, upstream_transport, forward_limits, timeout)
                ready_client = await owned_client(stack, ready_transport, ready_limits, resolved.ready_timeout_seconds)
                credential_client = await owned_client(stack, management_transport, forward_limits,
                    resolved.credential_timeout_seconds)
                management_ready_client = await owned_client(stack, management_ready_transport, ready_limits,
                    resolved.ready_timeout_seconds)
                reporter_client = await owned_client(stack, reporter_transport,
                    httpx.Limits(max_connections=1, max_keepalive_connections=1), resolved.status_timeout_seconds)
                reporter = StatusReporter(resolved, SignedManagementClient(
                    reporter_client, signer, resolved.management_base_url,
                    timeout_seconds=resolved.status_timeout_seconds))
                reporter.observer = application.state.observability
                # LIFO: drain/cancel/join the worker before closing any client.
                stack.push_async_callback(reporter.close)
                await reporter.start()
                application.state.status_reporter = reporter
                application.state.reporter_client = reporter_client
                credentials = CredentialProvider(credential_config, SignedManagementClient(
                    credential_client, signer, resolved.management_base_url,
                    timeout_seconds=resolved.credential_timeout_seconds))
                application.state.management_ready = SignedManagementClient(
                    management_ready_client, signer, resolved.management_base_url,
                    timeout_seconds=resolved.ready_timeout_seconds)
                application.state.pipeline = IngestionPipeline(
                    resolved, AdmissionController(resolved, monotonic=time.monotonic),
                    Forwarder(forward_client, resolved), credentials, reporter,
                )
                application.state.pipeline.observer = application.state.observability
                application.state.pipeline.forwarder.observer = application.state.observability
                application.state.ready_client = ready_client
                application.state.credential_client = credential_client
                application.state.management_ready_client = management_ready_client
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
