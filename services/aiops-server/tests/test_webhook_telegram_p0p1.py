"""P0.3, P0.5, and P1.3 Tests: Grafana Contract, Domain Fingerprinting, Dedup, Telegram HITL, & API Auth."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from pydantic import SecretStr

from app.agent.sasa_agent import SaSaAgent
from app.approvals.telegram import (
    ApprovalStatus,
    TelegramCallbackPayload,
    TelegramHITLService,
    parse_telegram_update,
)
from app.config import AIOpsSettings
from app.decision.policy_gate import DeterministicPolicyGate
from app.main import create_app
from app.providers.deepseek import DeepSeekProvider
from app.providers.router import ProviderRouter
from app.schemas.alert import AlertItem, AlertWebhookPayload
from app.schemas.decision import ExecutionStrategy, JevDecisionResponse, PolicyDecision, SeverityTier
from app.schemas.rca import RCAReport
from app.tools.mcp_tools import MCPToolRegistry

TEST_ADMIN_ID = "100042"


def _mock_llm_transport(action_id: str | None = "restart-approved-service") -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status_code=200,
            json={
                "model": "deepseek-chat",
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "summary": "Structured RCA generated from AMP & management context.",
                                    "evidence": ["domain_metrics_checked=true"],
                                    "possible_causes": ["Threshold breach"],
                                    "recommended_action_id": action_id,
                                    "risk_level": "medium",
                                    "confidence": 0.91,
                                    "requires_approval": True,
                                    "understanding": "Validated incident telemetry.",
                                    "proposed_resolution": "Follow grounded SRE runbook.",
                                    "expected_impact": "Minimal disruption.",
                                    "intended_tools": ["query_domain_metrics", "search_runbook"],
                                }
                            )
                        }
                    }
                ],
                "usage": {"prompt_tokens": 90, "completion_tokens": 45},
            },
        )

    return httpx.MockTransport(handler)


def test_sasa_agent_defaults_to_provider_router(isolated_settings: AIOpsSettings) -> None:
    """Verify SaSaAgent uses ProviderRouter by default when llm_provider is not overridden."""
    agent = SaSaAgent(isolated_settings)
    assert isinstance(agent.llm_provider, ProviderRouter)


def test_grafana_camelcase_payload_merges_common_labels_and_annotations() -> None:
    """Verify Grafana Unified Alerting camelCase fields parse cleanly and merge defaults."""
    raw_grafana_payload: dict[str, Any] = {
        "receiver": "infrapulse-aiops-webhook",
        "status": "firing",
        "title": "[FIRING:2] Container alerts",
        "message": "Multiple container alerts firing",
        "externalURL": "https://grafana.internal.example/alerting",
        "groupLabels": {"alertname": "ContainerUnhealthy"},
        "commonLabels": {"severity": "warning", "platform": "linux"},
        "commonAnnotations": {"runbook": "docker-containers.md"},
        "alerts": [
            {
                "status": "firing",
                "labels": {"server_id": "srv-app-01", "container": "api-gw"},
                "annotations": {"summary": "api-gw unhealthy"},
                "startsAt": "2026-11-24T12:00:00Z",
                "endsAt": "",
                "generatorURL": "https://grafana.internal.example/alerting/grafana/rule-1/view",
            },
            {
                "status": "firing",
                "labels": {
                    "server_id": "srv-app-01",
                    "container": "worker-bg",
                    "severity": "critical",
                },
                "annotations": {"summary": "worker-bg unhealthy"},
                "startsAt": "2026-11-24T12:01:00Z",
                "endsAt": "0001-01-01T00:00:00Z",
                "generatorURL": "https://grafana.internal.example/alerting/grafana/rule-2/view",
            },
        ],
    }

    parsed = AlertWebhookPayload.model_validate(raw_grafana_payload)
    assert parsed.external_url == "https://grafana.internal.example/alerting"
    assert len(parsed.alerts) == 2

    first, second = parsed.alerts
    assert first.labels["alertname"] == "ContainerUnhealthy"
    assert first.labels["severity"] == "warning"
    assert first.labels["platform"] == "linux"
    assert first.annotations["runbook"] == "docker-containers.md"
    assert first.ends_at is None
    assert first.generator_url is not None

    # Alert-specific label overrides commonLabels
    assert second.labels["severity"] == "critical"
    assert second.labels["container"] == "worker-bg"
    assert first.domain == "container"
    assert first.target_id == "srv-app-01:api-gw"
    assert second.target_id == "srv-app-01:worker-bg"


def test_container_and_external_ssl_fingerprints_do_not_collide() -> None:
    """Verify distinct containers and external SSL targets produce unique fingerprints and target_ids."""
    c1 = AlertItem(
        labels={
            "alertname": "ContainerRestartLoop",
            "server_id": "srv-app-01",
            "container": "order-api",
            "severity": "warning",
        }
    )
    c2 = AlertItem(
        labels={
            "alertname": "ContainerRestartLoop",
            "server_id": "srv-app-01",
            "container": "billing-worker",
            "severity": "warning",
        }
    )
    assert c1.domain == "container"
    assert c2.domain == "container"
    assert c1.target_id == "srv-app-01:order-api"
    assert c2.target_id == "srv-app-01:billing-worker"
    assert c1.compute_fingerprint() != c2.compute_fingerprint()

    ssl_ext_1 = AlertItem(
        labels={
            "alertname": "SSLCertExpiringCritical",
            "instance": "management-ssl-prober",
            "source": "external",
            "endpoint": "api.infrapulse.example:443",
            "target_name": "api-edge",
            "severity": "critical",
        }
    )
    ssl_ext_2 = AlertItem(
        labels={
            "alertname": "SSLCertExpiringCritical",
            "instance": "management-ssl-prober",
            "source": "external",
            "endpoint": "auth.infrapulse.example:443",
            "target_name": "auth-edge",
            "severity": "critical",
        }
    )
    assert ssl_ext_1.domain == "ssl"
    assert ssl_ext_2.domain == "ssl"
    assert ssl_ext_1.server_id != "management-ssl-prober"
    assert ssl_ext_2.server_id != "management-ssl-prober"
    assert ssl_ext_1.target_id == "api.infrapulse.example:443"
    assert ssl_ext_2.target_id == "auth.infrapulse.example:443"
    assert ssl_ext_1.compute_fingerprint() != ssl_ext_2.compute_fingerprint()

    ssl_local = AlertItem(
        labels={
            "alertname": "SSLCertExpiringWarning",
            "server_id": "srv-nginx-01",
            "filepath": "/etc/ssl/certs/edge.pem",
            "severity": "warning",
        }
    )
    assert ssl_local.domain == "ssl"
    assert ssl_local.server_id == "srv-nginx-01"
    assert ssl_local.target_id == "srv-nginx-01:/etc/ssl/certs/edge.pem"


@pytest.mark.asyncio
async def test_multi_alert_batch_processes_all_alerts_and_dedup_preserves_strategy(
    isolated_settings: AIOpsSettings,
) -> None:
    """Verify multi-alert Grafana batches process EVERY alert and dedup preserves cached strategy."""
    async with httpx.AsyncClient(transport=_mock_llm_transport()) as http_client:
        provider = DeepSeekProvider(isolated_settings, http_client=http_client)
        agent = SaSaAgent(isolated_settings, llm_provider=provider)

        batch_payload = AlertWebhookPayload.model_validate(
            {
                "status": "firing",
                "title": "Batch of 2 alerts",
                "commonLabels": {"platform": "linux"},
                "alerts": [
                    {
                        "status": "firing",
                        "labels": {
                            "alertname": "VMHostDown",
                            "server_id": "srv-db-01",
                            "severity": "critical",
                        },
                        "annotations": {"summary": "Host unreachable"},
                    },
                    {
                        "status": "firing",
                        "labels": {
                            "alertname": "temp_cleanup_needed",
                            "server_id": "srv-web-02",
                            "severity": "low",
                        },
                        "annotations": {"summary": "/tmp usage rising"},
                    },
                ],
            }
        )

        first = await agent.process_webhook(batch_payload, correlation_id="batch-001")
        assert first.alerts_processed == 2
        assert len(first.batch_results) == 2

        # Primary top-level fields reflect alerts[0] (CRITICAL -> ESCALATE_NOTIFY_ONLY)
        assert first.server_id == "srv-db-01"
        assert first.strategy == ExecutionStrategy.ESCALATE_NOTIFY_ONLY
        assert first.batch_results[0].strategy == ExecutionStrategy.ESCALATE_NOTIFY_ONLY

        # Second alert in batch was ALSO processed (LOW allowlisted -> AUTO_EXECUTE_ALLOWLISTED)
        assert first.batch_results[1].server_id == "srv-web-02"
        assert first.batch_results[1].strategy == ExecutionStrategy.AUTO_EXECUTE_ALLOWLISTED

        # Resending the same batch must deduplicate AND preserve each alert's real strategy & policy!
        dup = await agent.process_webhook(batch_payload, correlation_id="batch-002")
        assert dup.alerts_processed == 2
        assert dup.deduplicated is True
        assert dup.strategy == ExecutionStrategy.ESCALATE_NOTIFY_ONLY
        assert dup.policy_decision is not None
        assert dup.policy_decision.severity == SeverityTier.CRITICAL

        assert dup.batch_results[1].deduplicated is True
        assert dup.batch_results[1].strategy == ExecutionStrategy.AUTO_EXECUTE_ALLOWLISTED
        assert dup.batch_results[1].policy_decision is not None
        assert dup.batch_results[1].policy_decision.severity == SeverityTier.LOW


@pytest.mark.asyncio
async def test_sasa_agent_executes_allowlisted_reprobe_ssl_target(
    isolated_settings: AIOpsSettings,
) -> None:
    """Verify Stage 6 invokes `get_ssl_target_context` and `reprobe_ssl_target` on allowlisted SSL alert."""
    isolated_settings.MANAGEMENT_API_BASE_URL = "https://mgmt.internal.example"
    isolated_settings.MANAGEMENT_API_TOKEN = SecretStr("mgmt-secret-token")

    calls: list[tuple[str, str]] = []

    def mgmt_handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, request.url.path))
        if request.method == "GET" and request.url.path == "/api/v1/ssl-targets":
            return httpx.Response(
                200,
                json={
                    "items": [
                        {
                            "id": "ssl-uuid-001",
                            "name": "edge-api",
                            "host": "api.infrapulse.example",
                            "port": 443,
                            "subjectCn": "api.infrapulse.example",
                            "authorized": True,
                            "notAfter": "2027-01-01T00:00:00Z",
                        }
                    ]
                },
            )
        if request.method == "POST" and request.url.path == "/api/v1/ssl-targets/ssl-uuid-001/probe":
            return httpx.Response(
                200,
                json={
                    "id": "ssl-uuid-001",
                    "name": "edge-api",
                    "host": "api.infrapulse.example",
                    "port": 443,
                    "authorized": True,
                    "notAfter": "2027-01-01T00:00:00Z",
                    "lastError": None,
                },
            )
        return httpx.Response(404, json={"error": "not found"})

    async with (
        httpx.AsyncClient(transport=_mock_llm_transport(action_id="reprobe-ssl-target")) as llm_client,
        httpx.AsyncClient(transport=httpx.MockTransport(mgmt_handler)) as mgmt_client,
    ):
        provider = DeepSeekProvider(isolated_settings, http_client=llm_client)
        mcp = MCPToolRegistry(settings=isolated_settings, http_client=mgmt_client)
        policy_gate = DeterministicPolicyGate()
        agent = SaSaAgent(
            isolated_settings,
            llm_provider=provider,
            mcp_tools=mcp,
            policy_gate=policy_gate,
        )

        ssl_payload = AlertWebhookPayload.model_validate(
            {
                "status": "firing",
                "alerts": [
                    {
                        "status": "firing",
                        "labels": {
                            "alertname": "SSLProbeOrReadError",
                            "source": "external",
                            "instance": "management-ssl-prober",
                            "endpoint": "api.infrapulse.example:443",
                            "severity": "low",
                            "action_id": "reprobe-ssl-target",
                        },
                        "annotations": {"summary": "Transient TLS probe timeout"},
                    }
                ],
            }
        )

        res = await agent.process_webhook(ssl_payload)
        assert res.strategy == ExecutionStrategy.AUTO_EXECUTE_ALLOWLISTED
        assert res.executed_action_result is not None
        assert res.executed_action_result["action_id"] == "reprobe-ssl-target"
        assert res.executed_action_result["target_id"] == "ssl-uuid-001"
        assert res.executed_action_result["success"] is True
        assert "get_ssl_target_context" in res.trace.mcp_tools_executed
        assert "reprobe_ssl_target" in res.trace.mcp_tools_executed
        assert ("POST", "/api/v1/ssl-targets/ssl-uuid-001/probe") in calls


@pytest.mark.asyncio
async def test_telegram_empty_admin_chat_id_rejected_and_native_update_polling() -> None:
    """Verify empty TELEGRAM_ADMIN_CHAT_ID fails closed, native Update parsing, answerCallbackQuery, & polling."""
    # 1. Empty TELEGRAM_ADMIN_CHAT_ID must NOT default to any hardcoded ID
    unconfigured_settings = AIOpsSettings(
        TELEGRAM_ADMIN_CHAT_ID="",
        TELEGRAM_BOT_TOKEN=SecretStr("123456:TEST-TOKEN"),
    )
    tg_unconfigured = TelegramHITLService(unconfigured_settings)
    assert tg_unconfigured.admin_chat_id == ""
    assert tg_unconfigured.is_bot_configured is False
    with pytest.raises(PermissionError, match="TELEGRAM_ADMIN_CHAT_ID is not configured"):
        tg_unconfigured.process_callback(
            TelegramCallbackPayload(
                callback_id="cb-empty",
                chat_id="999000111",
                user_id="999000111",
                data="approve|apr-123|restart-approved-service",
            )
        )

    # 2. Native Telegram Bot API Update + getUpdates long-polling + answerCallbackQuery
    bot_requests: list[tuple[str, str, dict[str, Any]]] = []
    approval_holder: dict[str, str] = {}

    def tg_api_handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/sendMessage"):
            body = json.loads(request.content.decode("utf-8"))
            bot_requests.append(("POST", "/sendMessage", body))
            return httpx.Response(200, json={"ok": True, "result": {"message_id": 777}})
        if path.endswith("/getUpdates"):
            bot_requests.append(("GET", "/getUpdates", dict(request.url.params)))
            approval_id = approval_holder["approval_id"]
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "result": [
                        {
                            "update_id": 5001,
                            "callback_query": {
                                "id": "cbq-poll-5001",
                                "from": {"id": int(TEST_ADMIN_ID)},
                                "message": {"chat": {"id": int(TEST_ADMIN_ID)}},
                                "data": f"approve|{approval_id}|restart-approved-container",
                            },
                        }
                    ],
                },
            )
        if path.endswith("/answerCallbackQuery"):
            body = json.loads(request.content.decode("utf-8"))
            bot_requests.append(("POST", "/answerCallbackQuery", body))
            return httpx.Response(200, json={"ok": True, "result": True})
        return httpx.Response(404, json={"ok": False})

    configured_settings = AIOpsSettings(
        TELEGRAM_ADMIN_CHAT_ID=TEST_ADMIN_ID,
        TELEGRAM_BOT_TOKEN=SecretStr("123456:TEST-TOKEN"),
        TELEGRAM_POLLING_ENABLED=True,
        TELEGRAM_POLL_INTERVAL_SECONDS=0.5,
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(tg_api_handler)) as tg_client:
        tg = TelegramHITLService(configured_settings, http_client=tg_client)
        assert tg.is_bot_configured is True

        alert = AlertItem(
            labels={"alertname": "ContainerUnhealthy", "server_id": "srv-app-01", "container": "web"}
        )
        policy = PolicyDecision(
            severity=SeverityTier.MEDIUM,
            strategy=ExecutionStrategy.REQUEST_HITL_APPROVAL,
            requires_human_approval=True,
            allow_automated_execution=False,
            policy_reason="MEDIUM requires HITL",
            jev_decision=JevDecisionResponse(
                severity=SeverityTier.MEDIUM,
                candidate_action_id="restart-approved-container",
            ),
        )
        rca = RCAReport(summary="Container web failing health checks.")
        receipt = await tg.notify_and_request_approval(alert, policy, rca, fingerprint="fp-poll-1")
        assert receipt.approval_id is not None
        approval_holder["approval_id"] = receipt.approval_id

        # Native Update parser test
        parsed_cb = parse_telegram_update(
            {
                "update_id": 100,
                "callback_query": {
                    "id": "cbq-100",
                    "from": {"id": int(TEST_ADMIN_ID)},
                    "message": {"chat": {"id": int(TEST_ADMIN_ID)}},
                    "data": f"reject|{receipt.approval_id}|none",
                },
            }
        )
        assert parsed_cb.callback_id == "cbq-100"
        assert parsed_cb.chat_id == TEST_ADMIN_ID
        assert parsed_cb.user_id == TEST_ADMIN_ID

        # Poll once -> processes update 5001, advances offset, calls answerCallbackQuery
        processed = await tg.poll_updates_once()
        assert len(processed) == 1
        assert processed[0].status == ApprovalStatus.APPROVED
        assert processed[0].decided_by == TEST_ADMIN_ID
        assert tg._last_update_id == 5001
        assert any(path == "/getUpdates" and params.get("offset") == "1" for _, path, params in bot_requests)
        assert any(
            path == "/answerCallbackQuery" and body.get("callback_query_id") == "cbq-poll-5001"
            for _, path, body in bot_requests
        )

        # Lifespan start_polling / stop_polling smoke check
        started = await tg.start_polling()
        assert started is True
        assert tg.is_polling_active is True
        await tg.stop_polling()
        assert tg.is_polling_active is False


@pytest.mark.asyncio
async def test_telegram_webhook_secret_header_and_native_update_route(
    isolated_settings: AIOpsSettings,
) -> None:
    """Verify `X-Telegram-Bot-Api-Secret-Token`, native Telegram Update JSON, and `answerCallbackQuery`."""
    isolated_settings.TELEGRAM_ADMIN_CHAT_ID = TEST_ADMIN_ID
    isolated_settings.TELEGRAM_BOT_TOKEN = SecretStr("123456:TEST-TOKEN")
    isolated_settings.TELEGRAM_WEBHOOK_SECRET = SecretStr("tg-webhook-secret-xyz")

    answered_callbacks: list[dict[str, Any]] = []

    def tg_handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/sendMessage"):
            return httpx.Response(200, json={"ok": True, "result": {"message_id": 888}})
        if request.url.path.endswith("/answerCallbackQuery"):
            answered_callbacks.append(json.loads(request.content.decode("utf-8")))
            return httpx.Response(200, json={"ok": True, "result": True})
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(tg_handler)) as tg_client:
        tg_service = TelegramHITLService(isolated_settings, http_client=tg_client)
        agent = SaSaAgent(isolated_settings, telegram_service=tg_service)
        app = create_app(isolated_settings, sasa_agent=agent)

        # Create pending approval
        alert = AlertItem(labels={"alertname": "HighMemoryUsage", "server_id": "srv-01"})
        policy = PolicyDecision(
            severity=SeverityTier.MEDIUM,
            strategy=ExecutionStrategy.REQUEST_HITL_APPROVAL,
            requires_human_approval=True,
            allow_automated_execution=False,
            policy_reason="HITL",
            jev_decision=JevDecisionResponse(severity=SeverityTier.MEDIUM),
        )
        receipt = await tg_service.notify_and_request_approval(alert, policy, None, fingerprint="fp-wh-1")
        assert receipt.approval_id is not None

        native_update = {
            "update_id": 9001,
            "callback_query": {
                "id": "cbq-native-9001",
                "from": {"id": int(TEST_ADMIN_ID)},
                "message": {"chat": {"id": int(TEST_ADMIN_ID)}},
                "data": f"approve|{receipt.approval_id}|restart-approved-service",
            },
        }

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://testserver",
        ) as api:
            # Missing secret header -> 401
            no_secret = await api.post("/api/v1/integrations/telegram/webhook", json=native_update)
            assert no_secret.status_code == 401

            # Wrong secret header -> 401
            bad_secret = await api.post(
                "/api/v1/integrations/telegram/webhook",
                json=native_update,
                headers={"X-Telegram-Bot-Api-Secret-Token": "wrong-secret"},
            )
            assert bad_secret.status_code == 401

            # Valid secret header -> 200 + answerCallbackQuery invoked
            ok_resp = await api.post(
                "/api/v1/integrations/telegram/webhook",
                json=native_update,
                headers={"X-Telegram-Bot-Api-Secret-Token": "tg-webhook-secret-xyz"},
            )
            assert ok_resp.status_code == 200
            assert ok_resp.json()["status"] == "approved"
            assert len(answered_callbacks) == 1
            assert answered_callbacks[0]["callback_query_id"] == "cbq-native-9001"


@pytest.mark.asyncio
async def test_internal_api_key_auth_and_production_fail_closed(
    isolated_settings: AIOpsSettings,
) -> None:
    """Verify internal routes require `AIOPS_INTERNAL_API_KEY` when set and fail closed in production."""
    isolated_settings.AIOPS_INTERNAL_API_KEY = SecretStr("internal-api-secret-123")
    async with httpx.AsyncClient(transport=_mock_llm_transport()) as llm_http:
        provider = DeepSeekProvider(isolated_settings, http_client=llm_http)
        agent = SaSaAgent(isolated_settings, llm_provider=provider)
        app = create_app(isolated_settings, sasa_agent=agent)

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://testserver",
        ) as api:
            # Missing API key -> 401 across all 5 protected internal routes
            assert (await api.get("/api/v1/mcp/tools")).status_code == 401
            assert (
                await api.post(
                    "/api/v1/mcp/call",
                    json={"tool_name": "get_server_context", "arguments": {"server_id": "srv-1"}},
                )
            ).status_code == 401
            assert (await api.post("/api/v1/rag/search", json={"query": "memory"})).status_code == 401
            assert (await api.post("/api/v1/agent/infer", json={"prompt": "ping"})).status_code == 401
            assert (
                await api.post(
                    "/api/v1/decision/evaluate",
                    json={
                        "fingerprint": "fp-1",
                        "server_id": "srv-1",
                        "alert_name": "CPUHigh",
                        "declared_severity": "warning",
                        "status": "firing",
                    },
                )
            ).status_code == 401

            # Wrong API key -> 401
            assert (
                await api.get("/api/v1/mcp/tools", headers={"X-AIOps-API-Key": "wrong-key"})
            ).status_code == 401

            # Valid X-AIOps-API-Key -> 200
            ok_header = await api.get(
                "/api/v1/mcp/tools",
                headers={"X-AIOps-API-Key": "internal-api-secret-123"},
            )
            assert ok_header.status_code == 200

            # Valid Authorization: Bearer <key> -> 200
            ok_bearer = await api.post(
                "/api/v1/rag/search",
                json={"query": "memory"},
                headers={"Authorization": "Bearer internal-api-secret-123"},
            )
            assert ok_bearer.status_code == 200

            ok_infer = await api.post(
                "/api/v1/agent/infer",
                json={"prompt": "Check system status"},
                headers={"X-AIOps-API-Key": "internal-api-secret-123"},
            )
            assert ok_infer.status_code == 200

    # Production fail-closed when AIOPS_INTERNAL_API_KEY and TELEGRAM_WEBHOOK_SECRET are empty
    prod_settings = AIOpsSettings(
        AIOPS_ENV="production",
        AIOPS_INTERNAL_API_KEY=SecretStr(""),
        TELEGRAM_WEBHOOK_SECRET=SecretStr(""),
        AIOPS_WEBHOOK_SECRET=SecretStr(""),
    )
    prod_app = create_app(prod_settings)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=prod_app),
        base_url="http://testserver",
    ) as prod_api:
        resp_tools = await prod_api.get("/api/v1/mcp/tools")
        assert resp_tools.status_code in {401, 503}

        resp_tg = await prod_api.post(
            "/api/v1/integrations/telegram/webhook",
            json={"chat_id": TEST_ADMIN_ID, "user_id": TEST_ADMIN_ID, "data": "approve|apr-1|x"},
        )
        assert resp_tg.status_code in {401, 503}
