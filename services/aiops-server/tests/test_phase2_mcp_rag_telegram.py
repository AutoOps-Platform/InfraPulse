"""Phase 2 Tests: Multi-Stage Runbook RAG, MCP Diagnostic Tools, and Telegram HITL."""

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

TEST_ADMIN_CHAT_ID = "100001"


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
    assert any("memory" in m.chunk.title.lower() for m in matches)

    grounded = rag.format_grounded_context(matches)
    assert "<grounded_runbook_context>" in grounded

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
    """Verify MCP tools enforce parameterized PromQL template allowlist and execute tools."""
    mcp = MCPToolRegistry()
    tools = mcp.list_tools()
    tool_names = {t.name for t in tools}
    assert {
        "query_prometheus",
        "get_server_context",
        "get_ssl_target_context",
        "reprobe_ssl_target",
        "search_runbook",
        "query_logs",
    }.issubset(tool_names)
    read_only_map = {t.name: t.read_only for t in tools}
    assert read_only_map["query_prometheus"] is True
    assert read_only_map["get_server_context"] is True
    assert read_only_map["get_ssl_target_context"] is True
    assert read_only_map["search_runbook"] is True
    assert read_only_map["query_logs"] is True

    prom_ok = await mcp.invoke_tool(
        "query_prometheus",
        {"template": "linux_memory_usage_pct", "server_id": "srv-vm2-linux-01", "window_minutes": 15},
    )
    assert prom_ok.success is True
    assert "node_memory_MemAvailable_bytes" in prom_ok.data["promql"]

    with pytest.raises(ValueError, match="ALLOWLISTED_PROMQL"):
        await mcp.invoke_tool(
            "query_prometheus",
            {"template": "forbidden_secret_metric", "server_id": "srv-vm2-linux-01"},
        )


@pytest.mark.asyncio
async def test_telegram_hitl_approval_for_configured_admin() -> None:
    """Verify Telegram HITL formatting, configured admin ID check, and idempotency."""
    settings = AIOpsSettings(
        TELEGRAM_ADMIN_CHAT_ID=TEST_ADMIN_CHAT_ID,
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
            intended_tools=["query_domain_metrics", "search_runbook"],
        )

        receipt = await tg.notify_and_request_approval(
            alert, policy, rca, fingerprint="fp-tg-001"
        )
        assert receipt.admin_chat_id == TEST_ADMIN_CHAT_ID
        assert receipt.sent_live is True
        assert receipt.approval_id is not None
        assert len(receipt.inline_keyboard) == 1

        # 1. Unauthorized Telegram user must be rejected
        with pytest.raises(PermissionError, match="Unauthorized Telegram actor"):
            tg.process_callback(
                TelegramCallbackPayload(
                    callback_id="cb-unauth",
                    chat_id="999999999",
                    user_id="999999999",
                    data=f"approve|{receipt.approval_id}|restart-approved-service",
                )
            )

        # 2. Authorized Admin approves
        approved = tg.process_callback(
            TelegramCallbackPayload(
                callback_id="cb-auth-1",
                chat_id=TEST_ADMIN_CHAT_ID,
                user_id=TEST_ADMIN_CHAT_ID,
                data=f"approve|{receipt.approval_id}|restart-approved-service",
            )
        )
        assert approved.status == ApprovalStatus.APPROVED
        assert approved.decided_by == TEST_ADMIN_CHAT_ID

        # 3. Duplicate callback click must be rejected (idempotency)
        with pytest.raises(ValueError, match="already"):
            tg.process_callback(
                TelegramCallbackPayload(
                    callback_id="cb-auth-2",
                    chat_id=TEST_ADMIN_CHAT_ID,
                    user_id=TEST_ADMIN_CHAT_ID,
                    data=f"approve|{receipt.approval_id}|restart-approved-service",
                )
            )


@pytest.mark.asyncio
async def test_phase2_fastapi_routes_mcp_rag_and_telegram(
    isolated_settings: AIOpsSettings,
) -> None:
    """Verify `/api/v1/mcp/tools`, `/api/v1/rag/search`, and `/api/v1/integrations/telegram/webhook`."""
    isolated_settings.TELEGRAM_ADMIN_CHAT_ID = TEST_ADMIN_CHAT_ID
    app = create_app(isolated_settings)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
    ) as client:
        tools_resp = await client.get("/api/v1/mcp/tools")
        assert tools_resp.status_code == 200
        assert len(tools_resp.json()) >= 6

        rag_resp = await client.post(
            "/api/v1/rag/search",
            json={"query": "HighMemoryAndSwapPressure order-worker", "os_type": "linux"},
        )
        assert rag_resp.status_code == 200
        assert len(rag_resp.json()) >= 1
