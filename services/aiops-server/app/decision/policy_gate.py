"""Step 7 & INTRODUCT.md 11.3: Deterministic Policy Gate for HITL Decision-Making.

Enforces hard code-level operational boundaries on top of `Jev` classifications:
- `Low`: Auto-execution is allowed ONLY if `candidate_action_id` is in the strict
  `ALLOWLISTED_LOW_RISK_ACTIONS` set; otherwise escalated to HITL approval.
- `Medium`: Generates proposed resolution, impact, and intended tools, and
  ALWAYS requests administrator approval (HITL) before execution.
- `Critical`: Immediately notifies the administrator AND runs Read-Only RCA,
  while strictly prohibiting any automated action execution.
"""

from __future__ import annotations

from app.schemas.alert import AlertStatus
from app.schemas.decision import (
    ExecutionStrategy,
    JevDecisionResponse,
    PolicyDecision,
    SeverityTier,
)

# Pre-registered safe actions eligible for LOW-severity automation (INTRODUCT.md 11.3 & 11.6)
ALLOWLISTED_LOW_RISK_ACTIONS: frozenset[str] = frozenset(
    {
        "cleanup-temp-directory",
        "rotate-noncritical-logs",
        "refresh-metrics-collector-cache",
    }
)


class DeterministicPolicyGate:
    """Enforces hard safety and HITL rules on Jev Decision Model outputs."""

    def __init__(self, allowlisted_actions: frozenset[str] | None = None) -> None:
        self.allowlisted_actions = allowlisted_actions or ALLOWLISTED_LOW_RISK_ACTIONS

    def enforce(
        self,
        jev_decision: JevDecisionResponse,
        *,
        alert_status: AlertStatus = AlertStatus.FIRING,
    ) -> PolicyDecision:
        """Apply deterministic safety rules to produce an authoritative `PolicyDecision`."""
        if alert_status == AlertStatus.RESOLVED:
            return PolicyDecision(
                severity=jev_decision.severity,
                strategy=ExecutionStrategy.NO_ACTION_RESOLVED,
                requires_human_approval=False,
                allow_automated_execution=False,
                run_readonly_rca=False,
                approved_action_id=None,
                routing_model_tier="none",
                policy_reason="Alert status is RESOLVED; no automated action or LLM inference required.",
                jev_decision=jev_decision,
            )

        # CRITICAL: Immediate administrator notification + Read-Only RCA; NEVER auto-execute
        if jev_decision.severity == SeverityTier.CRITICAL:
            return PolicyDecision(
                severity=SeverityTier.CRITICAL,
                strategy=ExecutionStrategy.ESCALATE_NOTIFY_ONLY,
                requires_human_approval=True,
                allow_automated_execution=False,
                run_readonly_rca=True,
                approved_action_id=None,
                routing_model_tier="reasoning",
                policy_reason=(
                    "CRITICAL severity: autonomous execution is strictly forbidden. "
                    "Escalating immediately to administrator with read-only RCA evidence."
                ),
                jev_decision=jev_decision,
            )

        # LOW: Eligible for lightweight processing and auto-execution ONLY if allowlisted
        if jev_decision.severity == SeverityTier.LOW:
            candidate = (jev_decision.candidate_action_id or "").strip()
            if candidate and candidate in self.allowlisted_actions:
                return PolicyDecision(
                    severity=SeverityTier.LOW,
                    strategy=ExecutionStrategy.AUTO_EXECUTE_ALLOWLISTED,
                    requires_human_approval=False,
                    allow_automated_execution=True,
                    run_readonly_rca=True,
                    approved_action_id=candidate,
                    routing_model_tier="lightweight",
                    policy_reason=(
                        f"LOW severity with allowlisted action '{candidate}': "
                        "authorized for lightweight model processing and bounded execution."
                    ),
                    jev_decision=jev_decision,
                )

            return PolicyDecision(
                severity=SeverityTier.LOW,
                strategy=ExecutionStrategy.REQUEST_HITL_APPROVAL,
                requires_human_approval=True,
                allow_automated_execution=False,
                run_readonly_rca=True,
                approved_action_id=None,
                routing_model_tier="lightweight",
                policy_reason=(
                    f"LOW severity candidate action '{candidate or 'none'}' is not in the "
                    "deterministic allowlist; downgraded to require human approval (HITL)."
                ),
                jev_decision=jev_decision,
            )

        # MEDIUM (default): Generate full RCA proposal and require administrator HITL approval
        return PolicyDecision(
            severity=SeverityTier.MEDIUM,
            strategy=ExecutionStrategy.REQUEST_HITL_APPROVAL,
            requires_human_approval=True,
            allow_automated_execution=False,
            run_readonly_rca=True,
            approved_action_id=None,
            routing_model_tier=jev_decision.recommended_model_tier or "standard",
            policy_reason=(
                "MEDIUM severity: SaSa AI must generate understanding, proposed resolution, "
                "expected impact, and intended tools, then await administrator approval."
            ),
            jev_decision=jev_decision,
        )
