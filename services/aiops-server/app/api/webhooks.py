"""Webhook ingestion, Jev evaluation, and direct inference endpoints."""

from __future__ import annotations

import hmac
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Request, status
from pydantic import BaseModel, Field

from app.agent.prompts import build_system_prompt
from app.guardrails.sanitizer import GuardrailViolationError, InputSanitizer
from app.providers.base import InferenceRequest, InferenceResponse, ProviderError
from app.schemas.alert import AlertWebhookPayload
from app.schemas.decision import JevDecisionRequest, PolicyDecision
from app.schemas.rca import WebhookProcessingResult

router = APIRouter(prefix="/api/v1", tags=["aiops"])


class DirectInferencePayload(BaseModel):
    """Request body for testing direct LLM connectivity via `/api/v1/agent/infer`."""

    prompt: str = Field(min_length=1, max_length=4096)
    system_prompt: str | None = None
    temperature: float = Field(default=0.1, ge=0.0, le=2.0)
    max_tokens: int = Field(default=512, ge=1, le=4096)
    response_json: bool = False


def _verify_webhook_secret(request: Request, x_aiops_webhook_token: str | None) -> None:
    """Verify optional shared webhook token when `AIOPS_WEBHOOK_SECRET` is configured."""
    expected = request.app.state.sasa_agent.settings.AIOPS_WEBHOOK_SECRET.get_secret_value().strip()
    if not expected:
        return
    provided = (x_aiops_webhook_token or "").strip()
    if not provided or not hmac.compare_digest(expected, provided):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing X-AIOps-Webhook-Token header.",
        )


@router.post("/webhooks/grafana", response_model=WebhookProcessingResult)
async def receive_grafana_webhook(
    payload: AlertWebhookPayload,
    request: Request,
    x_aiops_webhook_token: str | None = Header(default=None),
    x_correlation_id: str | None = Header(default=None),
) -> WebhookProcessingResult:
    """Ingest a Grafana alert webhook and run the full Jev + SaSa AI pipeline."""
    _verify_webhook_secret(request, x_aiops_webhook_token)
    agent = request.app.state.sasa_agent
    try:
        return await agent.process_webhook(payload, correlation_id=x_correlation_id)
    except GuardrailViolationError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc


@router.post("/decision/evaluate", response_model=PolicyDecision)
async def evaluate_decision(
    payload: JevDecisionRequest,
    request: Request,
) -> PolicyDecision:
    """Directly test Task 2: Jev Decision Model + Deterministic Policy Gate."""
    agent = request.app.state.sasa_agent
    try:
        InputSanitizer.inspect_text(payload.alert_name, field_name="alert_name")
        InputSanitizer.inspect_text(payload.summary, field_name="summary")
        jev_resp = await agent.jev_client.evaluate(payload)
        return agent.policy_gate.enforce(jev_resp)
    except GuardrailViolationError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Jev decision evaluation failed: {exc}",
        ) from exc


@router.post("/agent/infer", response_model=InferenceResponse)
async def direct_agent_infer(
    payload: DirectInferencePayload,
    request: Request,
) -> dict[str, Any] | InferenceResponse:
    """Directly test Task 1: DeepSeek (Ollama or Cloud API) / Gemini inference."""
    agent = request.app.state.sasa_agent
    try:
        clean_prompt = InputSanitizer.inspect_text(payload.prompt, field_name="prompt")
        sys_prompt = payload.system_prompt or build_system_prompt(agent.settings.AIOPS_AGENT_NAME)
        return await agent.llm_provider.generate(
            InferenceRequest(
                system_prompt=sys_prompt,
                user_prompt=clean_prompt,
                temperature=payload.temperature,
                max_tokens=payload.max_tokens,
                response_json=payload.response_json,
            )
        )
    except GuardrailViolationError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except ProviderError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc
