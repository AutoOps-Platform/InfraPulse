

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

# Ensure `services/aiops-server/` root is on sys.path when invoked directly
SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from app.config import AIOpsSettings  # noqa: E402
from app.decision.jev_client import JevDecisionClient  # noqa: E402
from app.decision.policy_gate import DeterministicPolicyGate  # noqa: E402
from app.providers.deepseek import DeepSeekProvider  # noqa: E402
from app.schemas.decision import JevDecisionRequest  # noqa: E402


async def main() -> int:
    settings = AIOpsSettings.from_env(SERVICE_ROOT / ".env")
    print(f"=== {settings.AIOPS_SERVICE_NAME} ({settings.AIOPS_AGENT_NAME}) Connectivity Check ===")
    print(f"DeepSeek resolved mode : {settings.resolved_deepseek_backend()}")
    print(f"Jev resolved mode      : {settings.resolved_jev_backend()}")

    deepseek = DeepSeekProvider(settings)
    jev = JevDecisionClient(settings)
    gate = DeterministicPolicyGate()

    ds_health = await deepseek.health_check()
    jev_health = await jev.health_check()
    print(f"DeepSeek health        : {ds_health}")
    print(f"Jev health             : {jev_health}")

    sample_request = JevDecisionRequest(
        fingerprint="smoke-test-fp",
        server_id="srv-smoke-01",
        alert_name="HighMemoryPressure",
        declared_severity="warning",
        status="firing",
        summary="Smoke test alert evaluation",
    )
    jev_decision = await jev.evaluate(sample_request)
    policy_decision = gate.enforce(jev_decision)
    print(
        f"Policy Gate sample     : severity={policy_decision.severity.value}, "
        f"strategy={policy_decision.strategy.value}, "
        f"requires_hitl={policy_decision.requires_human_approval}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
