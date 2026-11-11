"""Phase 2 Tests: Multi-Stage Runbook RAG, MCP Read-Only Tools, and Telegram HITL (`5841901091`)."""

from __future__ import annotations

import httpx
import pytest
from pydantic import SecretStr

from app.approvals.telegram import (
    ApprovalStatus,
    TelegramCallbackPayload,
    TelegramHITLService,
)
from app.config import AIOpsSettings
from app.main import create_app
from app.rag.runbook_rag import RunbookRAGPipeline
from app.schemas.alert import AlertItem, AlertStatus
from app.schemas.decision import (
    ExecutionStrategy,
    JevDecisionResponse,
    PolicyDecision,
    SeverityTier,
)
from app.schemas.rca import RCAReport
from app.tools.mcp_tools import MCPToolRegistry


def test_runbook_rag_pipeline_retrieval_and_markdown_chunking() -> None:
    """Verify Phase 2.2 Runbook RAG retrieves memory runbook and indexes custom Markdown."""
    rag = RunbookRAGPipeline()
    matches = rag.retrieve(
        "HighMemoryAndSwapPressure order-worker RSS swap memory",
        os_type="linux",
        service="order-worker",
        top_k=2,
    )
    assert len(matches) >= 1
    assert matches[0].chunk.chunk_id == "rb-mem-001"
    assert matches[0].chunk.action_id == "restart-approved-service"

    grounded = rag.format_grounded_context(matches)
    assert "<grounded_runbook_context>" in grounded
    assert "Linux High Memory & Swap Pressure Runbook" in grounded

    # Ingest a new custom markdown runbook with multiple sections
    custom_md = """
## Redis Cache Eviction Spike
1. Check `redis_evicted_keys_total` in Prometheus.
2. Verify memory cap before scaling cache pool.
"""
    added = rag.ingest_markdown_text(custom_md, source="docs/runbooks/redis.md", os_type="linux")
    assert len(added) == 1
    redis_hits = rag.retrieve("Redis Cache Eviction Spike", os_type="linux", top_k=1)
    assert redis_hits[0].chunk.title == "Redis Cache Eviction Spike"


@pytest.mark.asyncio
async def test_mcp_tool_registry_allowlist_and_execution() -> None:
    """Verify Phase 2.1 MCP tools enforce PromQL allowlist and execute read-only tools."""
    mcp = MCPToolRegistry()
    tools = mcp.list_tools()
    assert {t.name for t in tools} == {
        "query_prometheus",
        "get_server_context",
        "search_runbook",
        "query_logs",
    }
    assert all(t.read_only is True for t in tools)

    prom_ok = await mcp.invoke_tool(
        "query_prometheus",
        {"metric": "mem_used_percent", "server_id": "srv-vm2-linux-01", "window_minutes": 15},
    )
    assert prom_ok.success is True
    assert "mem_used_percent" in prom_ok.data["promql"]

    with pytest.raises(ValueError, match="ALLOWLISTED_PROMQL_METRICS"):
        await mcp.invoke_tool(
            "query_prometheus",
            {"metric": "forbidden_secret_metric", "server_id": "srv-vm2-linux-01"},
        )


@pytest.mark.asyncio
async def test_telegram_hitl_approval_for_admin_5841901091() -> None:
    """Verify Phase 2.3 Telegram HITL formatting, admin ID 5841901091 check, and idempotency."""
    settings = AIOpsSettings(
        TELEGRAM_ADMIN_CHAT_ID="5841901091",
        TELEGRAM_BOT_TOKEN=SecretStr("123456:TEST-BOT-TOKEN-DO-NOT-COMMIT"),
    )

    def tg_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status_code=200,
            json={"ok": True, "result": {"message_id": 9001}},
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(tg_handler)) as client:
        tg = TelegramHITLService(settings, http_client=client)
        alert = AlertItem(
            status=AlertStatus.FIRING,
            labels={"alertname": "HighMemoryPressure", "server_id": "srv-vm2-01"},
        )
        jev_resp = JevDecisionResponse(
            severity=SeverityTier.MEDIUM,
            candidate_action_id="restart-approved-service",
        )
        policy = PolicyDecision(
            severity=SeverityTier.MEDIUM,
            strategy=ExecutionStrategy.REQUEST_HITL_APPROVAL,
            requires_human_approval=True,
            allow_automated_execution=False,
            policy_reason="MEDIUM requires HITL",
            jev_decision=jev_resp,
        )
        rca = RCAReport(
            summary="Memory at 94%",
            recommended_action_id="restart-approved-service",
            understanding="Worker leak",
            proposed_resolution="Restart worker",
            expected_impact="5s drain",
            intended_tools=["query_prometheus", "search_runbook"],
        )

        receipt = await tg.notify_and_request_approval(
            alert, policy, rca, fingerprint="fp-tg-001"
        )
        assert receipt.admin_chat_id == "5841901091"
        assert receipt.sent_live is True
        assert receipt.approval_id is not None
        assert len(receipt.inline_keyboard) == 1

        # 1. Unauthorized Telegram user must be rejected
        with pytest.raises(PermissionError, match="5841901091"):
            tg.process_callback(
                TelegramCallbackPayload(
                    callback_id="cb-unauth",
                    chat_id="999999999",
                    user_id="999999999",
                    data=f"approve|{receipt.approval_id}|restart-approved-service",
                )
            )

        # 2. Authorized Admin (5841901091) approves
        approved = tg.process_callback(
            TelegramCallbackPayload(
                callback_id="cb-auth-1",
                chat_id="5841901091",
                user_id="5841901091",
                data=f"approve|{receipt.approval_id}|restart-approved-service",
            )
        )
        assert approved.status == ApprovalStatus.APPROVED
        assert approved.decided_by == "5841901091"

        # 3. Duplicate callback click must be rejected (idempotency)
        with pytest.raises(ValueError, match="already"):
            tg.process_callback(
                TelegramCallbackPayload(
                    callback_id="cb-auth-2",
                    chat_id="5841901091",
                    user_id="5841901091",
                    data=f"approve|{receipt.approval_id}|restart-approved-service",
                )
            )


@pytest.mark.asyncio
async def test_phase2_fastapi_routes_mcp_rag_and_telegram(
    isolated_settings: AIOpsSettings,
) -> None:
    """Verify `/api/v1/mcp/tools`, `/api/v1/rag/search`, and `/api/v1/integrations/telegram/webhook`."""
    isolated_settings.TELEGRAM_ADMIN_CHAT_ID = "5841901091"
    app = create_app(isolated_settings)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
    ) as client:
        tools_resp = await client.get("/api/v1/mcp/tools")
        assert tools_resp.status_code == 200
        assert len(tools_resp.json()) == 4

        rag_resp = await client.post(
            "/api/v1/rag/search",
            json={"query": "HighMemoryAndSwapPressure order-worker", "os_type": "linux"},
        )
        assert rag_resp.status_code == 200
        assert rag_resp.json()[0]["chunk"]["chunk_id"] == "rb-mem-001"
