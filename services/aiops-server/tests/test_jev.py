"""Task 2 Tests: Jev Decision Model and Deterministic Policy Gate."""

from __future__ import annotations

import os

import httpx
import pytest
from pydantic import SecretStr

from app.config import AIOpsSettings
from app.decision.jev_client import JevDecisionClient, JevDecisionError
from app.decision.policy_gate import DeterministicPolicyGate
from app.schemas.decision import (
    ExecutionStrategy,
    JevDecisionRequest,
    SeverityTier,
)


@pytest.mark.asyncio
async def test_jev_api_mode_decision_evaluation() -> None:
    """Verify JevDecisionClient sends authenticated decision requests in API mode."""
    captured_headers: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured_headers.update(dict(request.headers))
        return httpx.Response(
            status_code=200,
            json={
                "model_name": "jev-decision-v1",
                "severity": "medium",
                "complexity_score": 0.65,
                "confidence": 0.93,
                "candidate_action_id": "restart-approved-service",
                "recommended_model_tier": "standard",
                "rationale": "Jev classified service latency spike as MEDIUM requiring HITL.",
            },
        )

    settings = AIOpsSettings(
        JEV_MODE="api",
        JEV_API_URL="https://jev.internal/v1/decision/evaluate",
        JEV_API_KEY=SecretStr("jev-test-token-placeholder"),
        JEV_MODEL="jev-decision-v1",
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        jev = JevDecisionClient(settings, http_client=client)
        decision = await jev.evaluate(
            JevDecisionRequest(
                fingerprint="fp-001",
                server_id="srv-001",
                alert_name="HighServiceLatency",
                declared_severity="warning",
                status="firing",
            )
        )

    assert captured_headers.get("authorization") == "Bearer jev-test-token-placeholder"
    assert decision.backend_mode == "api"
    assert decision.severity == SeverityTier.MEDIUM
    assert decision.candidate_action_id == "restart-approved-service"
    assert decision.confidence == 0.93


@pytest.mark.asyncio
async def test_jev_api_mode_requires_credentials() -> None:
    """Verify Jev API mode fails cleanly if JEV_API_KEY is missing."""
    settings = AIOpsSettings(JEV_MODE="api", JEV_API_KEY=SecretStr(""))
    jev = JevDecisionClient(settings)
    with pytest.raises(JevDecisionError, match="JEV_API_KEY"):
        await jev.evaluate(
            JevDecisionRequest(
                fingerprint="fp-002",
                server_id="srv-001",
                alert_name="TestAlert",
                declared_severity="warning",
                status="firing",
            )
        )


def test_policy_gate_enforces_low_medium_critical_contracts() -> None:
    """Verify Step 7 classification rules for Low, Medium (HITL), and Critical."""
    jev = JevDecisionClient(AIOpsSettings(JEV_MODE="heuristic"))
    gate = DeterministicPolicyGate()

    # 1. LOW with allowlisted action -> auto_execute_allowlisted
    low_req = JevDecisionRequest(
        fingerprint="fp-low",
        server_id="srv-01",
        alert_name="Temp_Cleanup_Needed",
        declared_severity="low",
        status="firing",
        labels={"action_id": "cleanup-temp-directory"},
    )
    low_decision = gate.enforce(jev.evaluate_heuristic(low_req))
    assert low_decision.severity == SeverityTier.LOW
    assert low_decision.strategy == ExecutionStrategy.AUTO_EXECUTE_ALLOWLISTED
    assert low_decision.allow_automated_execution is True
    assert low_decision.requires_human_approval is False

    # 2. LOW with non-allowlisted action -> downgraded to request_hitl_approval
    unapproved_low_req = JevDecisionRequest(
        fingerprint="fp-low-unapproved",
        server_id="srv-01",
        alert_name="Temp_Cleanup_Needed",
        declared_severity="low",
        status="firing",
        labels={"action_id": "arbitrary-unapproved-script"},
    )
    downgraded = gate.enforce(jev.evaluate_heuristic(unapproved_low_req))
    assert downgraded.strategy == ExecutionStrategy.REQUEST_HITL_APPROVAL
    assert downgraded.allow_automated_execution is False
    assert downgraded.requires_human_approval is True

    # 3. MEDIUM -> request_hitl_approval (never auto-executes)
    med_req = JevDecisionRequest(
        fingerprint="fp-med",
        server_id="srv-02",
        alert_name="HighMemoryPressure",
        declared_severity="warning",
        status="firing",
    )
    med_decision = gate.enforce(jev.evaluate_heuristic(med_req))
    assert med_decision.severity == SeverityTier.MEDIUM
    assert med_decision.strategy == ExecutionStrategy.REQUEST_HITL_APPROVAL
    assert med_decision.allow_automated_execution is False
    assert med_decision.requires_human_approval is True
    assert med_decision.run_readonly_rca is True

    # 4. CRITICAL -> escalate_notify_only + read-only RCA (strictly no auto-execution)
    crit_req = JevDecisionRequest(
        fingerprint="fp-crit",
        server_id="srv-03",
        alert_name="DatabaseServiceDown",
        declared_severity="critical",
        status="firing",
    )
    crit_decision = gate.enforce(jev.evaluate_heuristic(crit_req))
    assert crit_decision.severity == SeverityTier.CRITICAL
    assert crit_decision.strategy == ExecutionStrategy.ESCALATE_NOTIFY_ONLY
    assert crit_decision.allow_automated_execution is False
    assert crit_decision.requires_human_approval is True
    assert crit_decision.run_readonly_rca is True


@pytest.mark.live
@pytest.mark.skipif(
    os.environ.get("AIOPS_RUN_LIVE_TESTS") != "1",
    reason="Set AIOPS_RUN_LIVE_TESTS=1 to run live Jev Decision Model connectivity tests.",
)
@pytest.mark.asyncio
async def test_live_jev_connectivity() -> None:
    """Opt-in live test for checking real Jev Decision Model connectivity."""
    jev = JevDecisionClient(AIOpsSettings.from_env())
    health = await jev.health_check()
    assert health["configured"] is True
    assert health["reachable"] is True
