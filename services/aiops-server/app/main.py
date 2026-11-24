"""FastAPI entrypoint for InfraPulse AIOps Server (`services/aiops-server/`)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.agent.sasa_agent import SaSaAgent
from app.api.health import router as health_router
from app.api.webhooks import router as webhooks_router
from app.config import AIOpsSettings


def create_app(
    settings: AIOpsSettings | None = None,
    *,
    sasa_agent: SaSaAgent | None = None,
) -> FastAPI:
    """Create and configure the FastAPI application instance with optional Telegram polling lifespan."""
    resolved_settings = settings or AIOpsSettings.from_env()
    agent = sasa_agent or SaSaAgent(resolved_settings)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        if (
            bool(getattr(agent.settings, "TELEGRAM_POLLING_ENABLED", False))
            and agent.telegram_service.is_bot_configured
        ):
            await agent.telegram_service.start_polling()
        try:
            yield
        finally:
            await agent.telegram_service.stop_polling()

    application = FastAPI(
        title="InfraPulse AIOps Server (SaSa AI)",
        version="0.2.0",
        description=(
            "Webhook-driven AIOps backend integrating Amazon Managed Prometheus (AMP), "
            "DeepSeek/Gemini ProviderRouter, Jev Decision Model, Runbook RAG, and Telegram HITL."
        ),
        lifespan=lifespan,
    )
    application.state.settings = resolved_settings
    application.state.sasa_agent = agent

    application.include_router(health_router)
    application.include_router(webhooks_router)
    return application


app = create_app()
