"""P1.2 & P1.3 Tests: Domain-Complete Jev, PolicyGate, Runbook RAG, and ProviderRouter."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
from pydantic import SecretStr

from app.config import AIOpsSettings
from app.decision.jev_client import JevDecisionClient
from app.decision.policy_gate import ALLOWLISTED_LOW_RISK_ACTIONS, DeterministicPolicyGate
from app.providers import (
    DeepSeekProvider,
    GeminiProvider,
    InferenceRequest,
    ProviderError,
    ProviderRouter,
)
from app.rag.runbook_rag import DEFAULT_RUNBOOKS_DIR, RunbookRAGPipeline
from app.schemas.decision import ExecutionStrategy, JevDecisionRequest, SeverityTier


def _make_req(
    alert_name: str,
    *,
    server_id: str = "srv-01",
    declared_severity: str = "warning",
    summary: str = "",
    labels: dict[str, str] | None = None,
    annotations: dict[str, str] | None = None,
) -> JevDecisionRequest:
    return JevDecisionRequest(
        fingerprint=f"fp-{alert_name.lower()}",
        server_id=server_id,
        alert_name=alert_name,
        declared_severity=declared_severity,
        status="firing",
        summary=summary,
        labels=labels or {},
        annotations=annotations or {},
    )


# ---------------------------------------------------------------------------
# P1.2: Jev Heuristic Classification & PolicyGate Enforcement
# ---------------------------------------------------------------------------


def test_policy_gate_allowlist_contains_only_safe_actions() -> None:
    expected = {
        "reprobe-ssl-target",
        "collect-container-diagnostics",
        "cleanup-temp-directory",
        "rotate-noncritical-logs",
        "refresh-metrics-collector-cache",
    }
    assert expected.issubset(ALLOWLISTED_LOW_RISK_ACTIONS)
    assert "restart-approved-container" not in ALLOWLISTED_LOW_RISK_ACTIONS
    assert "restart-approved-service" not in ALLOWLISTED_LOW_RISK_ACTIONS


@pytest.mark.parametrize(
    ("alert_name", "labels", "annotations"),
    [
        ("SSLCertExpired", {"endpoint": "api.example.com:443"}, {}),
        ("ssl_expired", {"source": "external", "endpoint": "app.example.com:443"}, {}),
        ("cert_expired", {"filepath": "/etc/nginx/ssl/site.crt"}, {}),
        ("SSLCertExpiringCritical", {"endpoint": "api.example.com:443", "days_remaining": "4"}, {}),
        ("SSLCheck", {"endpoint": "api.example.com:443"}, {"summary": "Certificate expires in <7d"}),
        ("SSLCritical", {"subject_CN": "api.example.com"}, {}),
    ],
)
def test_jev_and_policy_ssl_critical(
    isolated_settings: AIOpsSettings,
    alert_name: str,
    labels: dict[str, str],
    annotations: dict[str, str],
) -> None:
    jev = JevDecisionClient(isolated_settings)
    gate = DeterministicPolicyGate()

    decision = jev.evaluate_heuristic(_make_req(alert_name, labels=labels, annotations=annotations))
    assert decision.severity == SeverityTier.CRITICAL
    assert decision.candidate_action_id == "reprobe-ssl-target"
    assert decision.recommended_model_tier == "reasoning"

    policy = gate.enforce(decision)
    assert policy.strategy == ExecutionStrategy.ESCALATE_NOTIFY_ONLY
    assert policy.allow_automated_execution is False
    assert policy.approved_action_id is None
    assert policy.requires_human_approval is True
    assert policy.routing_model_tier == "reasoning"


@pytest.mark.parametrize(
    ("alert_name", "declared_sev", "labels", "expected_tier", "expected_strategy"),
    [
        (
            "SSLCertExpiringWarning",
            "warning",
            {"endpoint": "api.example.com:443", "days_remaining": "18"},
            SeverityTier.MEDIUM,
            ExecutionStrategy.REQUEST_HITL_APPROVAL,
        ),
        (
            "SSLWarning",
            "warning",
            {"endpoint": "api.example.com:443"},
            SeverityTier.MEDIUM,
            ExecutionStrategy.REQUEST_HITL_APPROVAL,
        ),
        (
            "x509_read_errors",
            "warning",
            {"filepath": "/etc/nginx/ssl/app.pem"},
            SeverityTier.MEDIUM,
            ExecutionStrategy.REQUEST_HITL_APPROVAL,
        ),
        (
            "DNS_TIMEOUT",
            "warning",
            {"endpoint": "api.example.com:443"},
            SeverityTier.MEDIUM,
            ExecutionStrategy.REQUEST_HITL_APPROVAL,
        ),
        (
            "PRIVATE_ADDRESS_BLOCKED",
            "warning",
            {"endpoint": "10.0.0.5:443"},
            SeverityTier.MEDIUM,
            ExecutionStrategy.REQUEST_HITL_APPROVAL,
        ),
        (
            "TLS_TIMEOUT",
            "low",
            {"endpoint": "api.example.com:443"},
            SeverityTier.LOW,
            ExecutionStrategy.AUTO_EXECUTE_ALLOWLISTED,
        ),
        (
            "TLS_PROBE_FAILED",
            "info",
            {"endpoint": "api.example.com:443"},
            SeverityTier.LOW,
            ExecutionStrategy.AUTO_EXECUTE_ALLOWLISTED,
        ),
    ],
)
def test_jev_and_policy_ssl_medium_and_low_reprobe(
    isolated_settings: AIOpsSettings,
    alert_name: str,
    declared_sev: str,
    labels: dict[str, str],
    expected_tier: SeverityTier,
    expected_strategy: ExecutionStrategy,
) -> None:
    jev = JevDecisionClient(isolated_settings)
    gate = DeterministicPolicyGate()

    decision = jev.evaluate_heuristic(
        _make_req(alert_name, declared_severity=declared_sev, labels=labels)
    )
    assert decision.severity == expected_tier
    policy = gate.enforce(decision)
    assert policy.strategy == expected_strategy
    if expected_tier == SeverityTier.LOW:
        assert decision.candidate_action_id == "reprobe-ssl-target"
        assert decision.recommended_model_tier == "lightweight"
        assert policy.allow_automated_execution is True
        assert policy.approved_action_id == "reprobe-ssl-target"
    else:
        assert policy.allow_automated_execution is False
        assert policy.requires_human_approval is True


@pytest.mark.parametrize(
    "alert_name",
    ["ContainerOOMKilled", "oom_killed", "ContainerDown", "ContainerStopped", "ContainerDead"],
)
def test_jev_and_policy_container_critical(
    isolated_settings: AIOpsSettings,
    alert_name: str,
) -> None:
    jev = JevDecisionClient(isolated_settings)
    gate = DeterministicPolicyGate()

    decision = jev.evaluate_heuristic(
        _make_req(alert_name, labels={"container": "payments-api"})
    )
    assert decision.severity == SeverityTier.CRITICAL
    assert decision.candidate_action_id is None
    assert decision.recommended_model_tier == "reasoning"

    policy = gate.enforce(decision)
    assert policy.strategy == ExecutionStrategy.ESCALATE_NOTIFY_ONLY
    assert policy.allow_automated_execution is False
    assert policy.approved_action_id is None


@pytest.mark.parametrize(
    "alert_name",
    [
        "ContainerUnhealthy",
        "ContainerRestarting",
        "ContainerRestartLoop",
        "ContainerExited",
        "ContainerCPUThrottled",
        "ContainerHighMemory",
        "ContainerHighCPU",
    ],
)
def test_jev_and_policy_container_medium_requires_hitl(
    isolated_settings: AIOpsSettings,
    alert_name: str,
) -> None:
    jev = JevDecisionClient(isolated_settings)
    gate = DeterministicPolicyGate()

    decision = jev.evaluate_heuristic(
        _make_req(alert_name, labels={"container": "orders-worker"})
    )
    assert decision.severity == SeverityTier.MEDIUM
    assert decision.candidate_action_id == "restart-approved-container"
    assert decision.recommended_model_tier == "standard"

    policy = gate.enforce(decision)
    assert policy.strategy == ExecutionStrategy.REQUEST_HITL_APPROVAL
    assert policy.requires_human_approval is True
    assert policy.allow_automated_execution is False


@pytest.mark.parametrize("alert_name", ["container_diagnostics", "collect_container_diagnostics"])
def test_jev_and_policy_container_low_diagnostics_allowlisted(
    isolated_settings: AIOpsSettings,
    alert_name: str,
) -> None:
    jev = JevDecisionClient(isolated_settings)
    gate = DeterministicPolicyGate()

    decision = jev.evaluate_heuristic(
        _make_req(alert_name, labels={"container": "orders-worker"})
    )
    assert decision.severity == SeverityTier.LOW
    assert decision.candidate_action_id == "collect-container-diagnostics"
    assert decision.recommended_model_tier == "lightweight"

    policy = gate.enforce(decision)
    assert policy.strategy == ExecutionStrategy.AUTO_EXECUTE_ALLOWLISTED
    assert policy.allow_automated_execution is True
    assert policy.approved_action_id == "collect-container-diagnostics"


@pytest.mark.parametrize(
    ("alert_name", "labels", "expected_sev"),
    [
        ("WindowsCPUHigh", {"platform": "windows"}, SeverityTier.MEDIUM),
        ("windows_memory_pressure", {"platform": "windows"}, SeverityTier.MEDIUM),
        ("windows_logical_disk_low", {"platform": "windows"}, SeverityTier.MEDIUM),
        ("processor_queue_length_high", {"platform": "windows"}, SeverityTier.MEDIUM),
        ("HostDown", {"platform": "windows"}, SeverityTier.CRITICAL),
        ("alloy_down", {"platform": "linux"}, SeverityTier.CRITICAL),
        ("temp_cleanup_needed", {"platform": "linux"}, SeverityTier.LOW),
    ],
)
def test_jev_vm_linux_and_windows_signals(
    isolated_settings: AIOpsSettings,
    alert_name: str,
    labels: dict[str, str],
    expected_sev: SeverityTier,
) -> None:
    jev = JevDecisionClient(isolated_settings)
    decision = jev.evaluate_heuristic(_make_req(alert_name, labels=labels))
    assert decision.severity == expected_sev
    if labels.get("platform") == "windows":
        assert "Windows VM" in decision.rationale


# ---------------------------------------------------------------------------
# P1.2: Curated Runbooks Auto-Loading & Domain-Aware RAG Retrieval
# ---------------------------------------------------------------------------


def test_rag_autoloads_all_four_runbooks_without_duplicates_or_legacy_text() -> None:
    assert (DEFAULT_RUNBOOKS_DIR / "linux-vm.md").is_file()
    assert (DEFAULT_RUNBOOKS_DIR / "windows-vm.md").is_file()
    assert (DEFAULT_RUNBOOKS_DIR / "docker-containers.md").is_file()
    assert (DEFAULT_RUNBOOKS_DIR / "ssl-certificates.md").is_file()

    rag = RunbookRAGPipeline()
    sources = {c.source for c in rag.chunks}
    assert "runbooks/linux-vm.md" in sources
    assert "runbooks/windows-vm.md" in sources
    assert "runbooks/docker-containers.md" in sources
    assert "runbooks/ssl-certificates.md" in sources

    # Re-loading the same directory must cleanly skip duplicates
    before_count = len(rag.chunks)
    added_again = rag.load_runbooks_directory(DEFAULT_RUNBOOKS_DIR)
    assert added_again == []
    assert len(rag.chunks) == before_count

    # Ensure zero legacy Telegraf metric names or Docker Compose volume text remain
    legacy_terms = (
        "mem_used_percent",
        "cpu_usage_active",
        "disk_used_percent",
        "postgres_data",
        "prometheus_data",
        "grafana_data",
        "telegraf",
    )
    for chunk in rag.chunks:
        lower_blob = f"{chunk.title}\n{chunk.content}".lower()
        for legacy in legacy_terms:
            assert legacy not in lower_blob, f"Legacy term '{legacy}' found in {chunk.chunk_id}"


def test_rag_retrieves_accurate_chunks_for_all_four_domains() -> None:
    rag = RunbookRAGPipeline()

    # 1. Linux VM
    linux_hits = rag.retrieve(
        "LinuxCPUHigh node_cpu_seconds_total node_pressure_cpu_waiting_seconds_total",
        os_type="linux",
        domain="vm",
        top_k=2,
    )
    assert linux_hits
    assert linux_hits[0].chunk.os_type == "linux"
    assert "node_cpu_seconds_total" in linux_hits[0].chunk.content

    # 2. Windows VM
    win_hits = rag.retrieve(
        "WindowsCPUHigh windows_system_processor_queue_length windows_cpu_time_total",
        os_type="windows",
        domain="vm",
        top_k=2,
    )
    assert win_hits
    assert win_hits[0].chunk.os_type == "windows"
    assert win_hits[0].chunk.source == "runbooks/windows-vm.md"

    # 3. Docker Containers
    ctr_hits = rag.retrieve(
        "ContainerOOMKilled infrapulse_container_oom_killed exit code 137",
        domain="container",
        top_k=2,
    )
    assert ctr_hits
    assert ctr_hits[0].chunk.domain == "container"
    assert ctr_hits[0].chunk.source == "runbooks/docker-containers.md"
    assert "oom" in ctr_hits[0].chunk.title.lower()

    # 4. SSL Certificates
    ssl_hits = rag.retrieve(
        "PRIVATE_ADDRESS_BLOCKED TLS_TIMEOUT x509_read_errors reprobe-ssl-target",
        domain="ssl",
        top_k=2,
    )
    assert ssl_hits
    assert ssl_hits[0].chunk.domain == "ssl"
    assert ssl_hits[0].chunk.source == "runbooks/ssl-certificates.md"
    assert "PRIVATE_ADDRESS_BLOCKED" in ssl_hits[0].chunk.content


def test_rag_custom_runbooks_dir(tmp_path: Path) -> None:
    custom_file = tmp_path / "ssl-custom.md"
    custom_file.write_text(
        "## Custom Mutual TLS Handshake Error\n"
        "- **Domain:** `ssl` | **OS:** `any` | **Recommended Action:** `reprobe-ssl-target`\n"
        "Verify client certificate CA chain.\n",
        encoding="utf-8",
    )
    rag = RunbookRAGPipeline(chunks=[], runbooks_dir=tmp_path)
    hits = rag.retrieve("Mutual TLS Handshake Error", domain="ssl", top_k=1)
    assert len(hits) == 1
    assert hits[0].chunk.domain == "ssl"
    assert hits[0].chunk.action_id == "reprobe-ssl-target"


# ---------------------------------------------------------------------------
# P1.3: DeepSeek Tier Routing, Gemini JSON & Live Health Probe, ProviderRouter
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_deepseek_model_tier_routing_api_and_ollama() -> None:
    captured_models: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode("utf-8"))
        captured_models.append(body["model"])
        return httpx.Response(
            status_code=200,
            json={
                "model": body["model"],
                "choices": [{"message": {"content": '{"summary":"ok"}'}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5},
            },
        )

    api_settings = AIOpsSettings(
        DEEPSEEK_MODE="api",
        DEEPSEEK_API_KEY=SecretStr("test-deepseek-key"),
        DEEPSEEK_MODEL="deepseek-v4.1-flash",
    )
    req = InferenceRequest(system_prompt="sys", user_prompt="usr", response_json=True)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        ds = DeepSeekProvider(api_settings, http_client=client)
        r_light = await ds.generate(req, model_tier="lightweight")
        r_std = await ds.generate(req, model_tier="standard")
        r_reason = await ds.generate(req, model_tier="reasoning")
        r_override = await ds.generate(
            req.model_copy(update={"model_override": "deepseek-custom-override"}),
            model_tier="lightweight",
        )

    assert captured_models == [
        getattr(api_settings, "DEEPSEEK_LIGHTWEIGHT_MODEL", "deepseek-chat"),
        "deepseek-v4.1-flash",
        getattr(api_settings, "DEEPSEEK_REASONING_MODEL", "deepseek-reasoner"),
        "deepseek-custom-override",
    ]
    assert r_light.model_name == captured_models[0]
    assert r_std.model_name == captured_models[1]
    assert r_reason.model_name == captured_models[2]
    assert r_override.model_name == "deepseek-custom-override"

    # Ollama mode always uses OLLAMA_MODEL for tiers
    ollama_settings = AIOpsSettings(DEEPSEEK_MODE="ollama", OLLAMA_MODEL="deepseek-r1:latest")
    ds_ollama = DeepSeekProvider(ollama_settings)
    assert ds_ollama.resolve_model(model_tier="lightweight") == "deepseek-r1:latest"
    assert ds_ollama.resolve_model(model_tier="reasoning") == "deepseek-r1:latest"


@pytest.mark.asyncio
async def test_gemini_response_format_and_live_models_health_probe() -> None:
    seen_requests: list[tuple[str, str, dict | None]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode("utf-8")) if request.content else None
        seen_requests.append((request.method, str(request.url), body))
        if request.url.path.endswith("/models"):
            return httpx.Response(status_code=200, json={"data": [{"id": "gemini-2.5-flash"}]})
        return httpx.Response(
            status_code=200,
            json={
                "model": body["model"],
                "choices": [{"message": {"content": '{"summary":"gemini ok"}'}}],
                "usage": {"prompt_tokens": 12, "completion_tokens": 8},
            },
        )

    settings = AIOpsSettings(
        GEMINI_API_KEY=SecretStr("test-gemini-key"),
        GEMINI_BASE_URL="https://generativelanguage.googleapis.com/v1beta/openai",
        GEMINI_MODEL="gemini-2.5-flash",
    )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        gemini = GeminiProvider(settings, http_client=client)

        resp_json = await gemini.generate(
            InferenceRequest(system_prompt="sys", user_prompt="usr", response_json=True)
        )
        resp_plain = await gemini.generate(
            InferenceRequest(system_prompt="sys", user_prompt="usr", response_json=False)
        )
        health = await gemini.health_check()

    assert resp_json.provider_name == "gemini"
    assert resp_plain.provider_name == "gemini"
    assert seen_requests[0][2] is not None
    assert seen_requests[0][2]["response_format"] == {"type": "json_object"}
    assert seen_requests[1][2] is not None
    assert "response_format" not in seen_requests[1][2]

    # Live GET /models probe check
    assert seen_requests[2][0] == "GET"
    assert seen_requests[2][1].endswith("/models")
    assert health["configured"] is True
    assert health["reachable"] is True
    assert health["status_code"] == 200

    # Verify HTTP 503 makes reachable=False even when key is present
    def failing_models(_: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code=503, text="Service Unavailable")

    async with httpx.AsyncClient(transport=httpx.MockTransport(failing_models)) as bad_client:
        bad_health = await GeminiProvider(settings, http_client=bad_client).health_check()
    assert bad_health["configured"] is True
    assert bad_health["reachable"] is False
    assert bad_health["status_code"] == 503


@pytest.mark.asyncio
async def test_provider_router_deepseek_to_gemini_fallback() -> None:
    def failing_deepseek(_: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code=503, text="DeepSeek overloaded")

    def healthy_gemini(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/models"):
            return httpx.Response(status_code=200, json={"data": []})
        body = json.loads(request.content.decode("utf-8"))
        assert body["model"] == "gemini-2.5-flash"
        assert body["response_format"] == {"type": "json_object"}
        return httpx.Response(
            status_code=200,
            json={
                "model": "gemini-2.5-flash",
                "choices": [{"message": {"content": '{"summary":"served by gemini fallback"}'}}],
                "usage": {"prompt_tokens": 20, "completion_tokens": 10},
            },
        )

    settings = AIOpsSettings(
        AIOPS_DEFAULT_PROVIDER="deepseek",
        DEEPSEEK_MODE="api",
        DEEPSEEK_API_KEY=SecretStr("test-deepseek-key"),
        GEMINI_API_KEY=SecretStr("test-gemini-key"),
    )

    async with (
        httpx.AsyncClient(transport=httpx.MockTransport(failing_deepseek)) as ds_client,
        httpx.AsyncClient(transport=httpx.MockTransport(healthy_gemini)) as gem_client,
    ):
        router = ProviderRouter(
            settings,
            deepseek_provider=DeepSeekProvider(settings, http_client=ds_client),
            gemini_provider=GeminiProvider(settings, http_client=gem_client),
        )
        resp = await router.generate(
            InferenceRequest(system_prompt="sys", user_prompt="usr", response_json=True),
            model_tier="reasoning",
        )
        health = await router.health_check()

    assert resp.provider_name == "gemini"
    assert resp.fallback_used is True
    assert router.last_served_provider == "gemini"
    assert router.last_fallback_used is True
    assert health["primary"]["provider"] == "deepseek"  # type: ignore[index]
    assert health["primary"]["reachable"] is False  # type: ignore[index]
    assert health["fallback"]["provider"] == "gemini"  # type: ignore[index]
    assert health["fallback"]["reachable"] is True  # type: ignore[index]
    assert health["reachable"] is True


@pytest.mark.asyncio
async def test_provider_router_gemini_to_deepseek_fallback_and_tier_routing() -> None:
    seen_ds_models: list[str] = []

    def failing_gemini(_: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code=429, text="Rate limited")

    def healthy_deepseek(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode("utf-8"))
        seen_ds_models.append(body["model"])
        return httpx.Response(
            status_code=200,
            json={
                "model": body["model"],
                "choices": [{"message": {"content": '{"summary":"served by deepseek fallback"}'}}],
                "usage": {"prompt_tokens": 18, "completion_tokens": 9},
            },
        )

    settings = AIOpsSettings(
        AIOPS_DEFAULT_PROVIDER="gemini",
        DEEPSEEK_MODE="api",
        DEEPSEEK_API_KEY=SecretStr("test-deepseek-key"),
        GEMINI_API_KEY=SecretStr("test-gemini-key"),
    )

    async with (
        httpx.AsyncClient(transport=httpx.MockTransport(healthy_deepseek)) as ds_client,
        httpx.AsyncClient(transport=httpx.MockTransport(failing_gemini)) as gem_client,
    ):
        router = ProviderRouter(
            settings,
            deepseek_provider=DeepSeekProvider(settings, http_client=ds_client),
            gemini_provider=GeminiProvider(settings, http_client=gem_client),
        )
        resp = await router.generate(
            InferenceRequest(system_prompt="sys", user_prompt="usr", response_json=True),
            model_tier="reasoning",
        )

    assert resp.provider_name == "deepseek"
    assert resp.fallback_used is True
    assert seen_ds_models == [getattr(settings, "DEEPSEEK_REASONING_MODEL", "deepseek-reasoner")]
    assert router.last_served_provider == "deepseek"


@pytest.mark.asyncio
async def test_provider_router_raises_when_fallback_disabled_or_unconfigured() -> None:
    def failing_deepseek(_: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code=500, text="Internal error")

    settings_no_gemini = AIOpsSettings(
        AIOPS_DEFAULT_PROVIDER="deepseek",
        DEEPSEEK_MODE="api",
        DEEPSEEK_API_KEY=SecretStr("test-deepseek-key"),
        GEMINI_API_KEY=SecretStr(""),
    )

    async with httpx.AsyncClient(transport=httpx.MockTransport(failing_deepseek)) as ds_client:
        router = ProviderRouter(
            settings_no_gemini,
            deepseek_provider=DeepSeekProvider(settings_no_gemini, http_client=ds_client),
            gemini_provider=GeminiProvider(settings_no_gemini),
        )
        with pytest.raises(ProviderError, match="HTTP 500"):
            await router.generate(InferenceRequest(system_prompt="sys", user_prompt="usr"))
