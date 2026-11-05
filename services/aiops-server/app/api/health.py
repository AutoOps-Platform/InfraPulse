"""Liveness and readiness endpoints matching InfraPulse operational standards."""

from __future__ import annotations

from fastapi import APIRouter, Request

router = APIRouter(tags=["health"])


@router.get("/health/live")
async def health_live(request: Request) -> dict[str, object]:
    """Process-level liveness check (no external network calls)."""
    agent = request.app.state.sasa_agent
    return {
        "status": "ok",
        "service": agent.settings.AIOPS_SERVICE_NAME,
        "agent_name": agent.settings.AIOPS_AGENT_NAME,
    }


@router.get("/health/ready")
async def health_ready(request: Request) -> dict[str, object]:
    """Readiness probe reporting LLM provider and Jev Decision Model configuration."""
    agent = request.app.state.sasa_agent
    llm_health = await agent.llm_provider.health_check()
    jev_health = await agent.jev_client.health_check()
    return {
        "status": "ready" if (llm_health.get("configured") and jev_health.get("configured")) else "degraded",
        "service": agent.settings.AIOPS_SERVICE_NAME,
        "agent_name": agent.settings.AIOPS_AGENT_NAME,
        "llm_provider": llm_health,
        "jev_decision_model": jev_health,
    }
