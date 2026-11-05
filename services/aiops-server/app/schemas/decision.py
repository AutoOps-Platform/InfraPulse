"""Decision schemas for the Jev Decision Model and Deterministic Policy Gate."""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, Field


class SeverityTier(StrEnum):
    """Normalized incident classification tier (Step 7 & INTRODUCT.md Section 11.3)."""

    LOW = "low"
    MEDIUM = "medium"
    CRITICAL = "critical"


class ExecutionStrategy(StrEnum):
    """Operational strategy enforced by the Policy Gate."""

    AUTO_EXECUTE_ALLOWLISTED = "auto_execute_allowlisted"
    REQUEST_HITL_APPROVAL = "request_hitl_approval"
    ESCALATE_NOTIFY_ONLY = "escalate_notify_only"
    NO_ACTION_RESOLVED = "no_action_resolved"


class JevDecisionRequest(BaseModel):
    """Input payload sent to the Jev Decision Model."""

    fingerprint: str
    server_id: str
    alert_name: str
    declared_severity: str
    status: str
    summary: str = ""
    labels: dict[str, str] = Field(default_factory=dict)
    annotations: dict[str, str] = Field(default_factory=dict)


class JevDecisionResponse(BaseModel):
    """Structured classification returned by the Jev Decision Model."""

    model_name: str = "jev-decision-v1"
    backend_mode: str = "heuristic"
    severity: SeverityTier
    complexity_score: float = Field(default=0.5, ge=0.0, le=1.0)
    confidence: float = Field(default=0.85, ge=0.0, le=1.0)
    candidate_action_id: str | None = None
    recommended_model_tier: str = "lightweight"
    rationale: str = ""


class PolicyDecision(BaseModel):
    """Final deterministic decision combining Jev output with InfraPulse safety rules."""

    severity: SeverityTier
    strategy: ExecutionStrategy
    requires_human_approval: bool
    allow_automated_execution: bool
    run_readonly_rca: bool = True
    approved_action_id: str | None = None
    routing_model_tier: str = "lightweight"
    policy_reason: str
    jev_decision: JevDecisionResponse
