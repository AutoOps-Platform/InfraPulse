"""Liveness has no IO; readiness uses its own bounded client and deadline."""

import asyncio

from fastapi import APIRouter, Request, Response
import httpx


router = APIRouter()


@router.get("/health/live")
async def live() -> Response:
    return Response(status_code=200)


@router.get("/health/ready")
async def ready(request: Request) -> Response:
    if not request.app.state.initialized:
        return Response(status_code=503)
    settings = request.app.state.settings
    try:
        async with asyncio.timeout(settings.ready_timeout_seconds):
            probe = httpx.Request(
                "GET", settings.prometheus_ready_url,
                extensions={"timeout": httpx.Timeout(settings.ready_timeout_seconds).as_dict()},
            )
            response = await request.app.state.ready_client.send(
                probe, stream=True, auth=None, follow_redirects=False,
            )
            try:
                status = 200 if response.status_code == 200 else 503
            finally:
                await response.aclose()
            if status == 200:
                credential_health = await request.app.state.management_ready.request(
                    'GET', '/internal/v1/credentials/health')
                status = 200 if credential_health.status_code == 204 else 503
        return Response(status_code=status)
    except Exception:
        # Includes total/HTTPX timeouts and malformed redirect locations. No
        # untrusted exception/body is returned, and cancellation is not swallowed.
        return Response(status_code=503)
