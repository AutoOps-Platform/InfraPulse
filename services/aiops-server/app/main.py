"""FastAPI entrypoint for InfraPulse AIOps Server (`services/aiops-server/`)."""

from __future__ import annotations

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
    """Create and configure the FastAPI application instance."""
    resolved_settings = settings or AIOpsSettings.from_env()
    agent = sasa_agent or SaSaAgent(resolved_settings)

    application = FastAPI(
        title="InfraPulse AIOps Server (SaSa AI)",
        version="0.1.0",
        description=(
            "Webhook-driven AIOps backend integrating DeepSeek (Cloud API & Ollama Local), "
            "Gemini, and the Jev Decision Model with Human-in-the-Loop (HITL) policy guardrails."
        ),
    )
    application.state.settings = resolved_settings
    application.state.sasa_agent = agent

    application.include_router(health_router)
    application.include_router(webhooks_router)
    return application


app = create_app()
