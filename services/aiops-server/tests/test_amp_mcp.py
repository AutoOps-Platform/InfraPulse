"""P0.2 & P1.1 Tests: AMP SigV4 Client, Parameterized PromQL Templates, and Management API MCP Tools."""

from __future__ import annotations

import hashlib
import hmac
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs

import httpx
import pytest
from pydantic import SecretStr

from app.config import AIOpsSettings
from app.tools.amp_client import (
    AMPClient,
    AMPQueryError,
    AwsStaticCredentials,
    sign_sigv4,
)
from app.tools.mcp_tools import (
    ALLOWLISTED_PROMQL_TEMPLATES,
    CONTAINER_TEMPLATES,
    LINUX_VM_TEMPLATES,
    PROMQL_TEMPLATES,
    SSL_TEMPLATES,
    WINDOWS_VM_TEMPLATES,
    MCPToolRegistry,
    _escape_promql_label_value,
    render_promql_template,
)


# ---------------------------------------------------------------------------
# 1. Shared AIOpsSettings Contract & .env.example Hygiene
# ---------------------------------------------------------------------------


def test_aiops_settings_p0_p1_contract_and_secret_masking() -> None:
    settings = AIOpsSettings(
        _env_file=None,
        AWS_ACCESS_KEY_ID=SecretStr("AKIAIOSFODNN7EXAMPLE"),
        AWS_SECRET_ACCESS_KEY=SecretStr("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"),
        AWS_SESSION_TOKEN=SecretStr("IQoJb3JpZ2luX2VjEXAMPLE"),
        MANAGEMENT_API_TOKEN=SecretStr("mgmt-jwt-secret-token"),
        TELEGRAM_WEBHOOK_SECRET=SecretStr("tg-webhook-secret"),
        AIOPS_INTERNAL_API_KEY=SecretStr("internal-api-key-secret"),
    )

    assert settings.TELEGRAM_ADMIN_CHAT_ID == ""
    assert settings.AMP_ENDPOINT == ""
    assert settings.AWS_REGION == "ap-southeast-1"
    assert settings.AMP_TIMEOUT_SECONDS == 10.0
    assert settings.MANAGEMENT_API_BASE_URL == ""
    assert settings.MANAGEMENT_API_TIMEOUT_SECONDS == 5.0
    assert settings.TELEGRAM_POLLING_ENABLED is False
    assert settings.TELEGRAM_POLL_INTERVAL_SECONDS == 2.0
    assert settings.DEEPSEEK_LIGHTWEIGHT_MODEL == "deepseek-chat"
    assert settings.DEEPSEEK_REASONING_MODEL == "deepseek-reasoner"
    assert settings.AIOPS_ENABLE_PROVIDER_FALLBACK is True

    rendered = repr(settings)
    for secret in (
        "AKIAIOSFODNN7EXAMPLE",
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        "IQoJb3JpZ2luX2VjEXAMPLE",
        "mgmt-jwt-secret-token",
        "tg-webhook-secret",
        "internal-api-key-secret",
    ):
        assert secret not in rendered


def test_env_example_mirrors_all_new_vars_with_no_hardcoded_secrets() -> None:
    env_example = Path(__file__).resolve().parents[1] / ".env.example"
    assert env_example.is_file()
    content = env_example.read_text(encoding="utf-8")

    assert "5841901091" not in content
    assert "sk-" not in content

    expected_keys = (
        "AMP_ENDPOINT=",
        "AWS_REGION=",
        "AWS_ACCESS_KEY_ID=",
        "AWS_SECRET_ACCESS_KEY=",
        "AWS_SESSION_TOKEN=",
        "AMP_TIMEOUT_SECONDS=",
        "MANAGEMENT_API_BASE_URL=",
        "MANAGEMENT_API_TOKEN=",
        "MANAGEMENT_API_TIMEOUT_SECONDS=",
        "TELEGRAM_ADMIN_CHAT_ID=",
        "TELEGRAM_WEBHOOK_SECRET=",
        "TELEGRAM_POLLING_ENABLED=",
        "TELEGRAM_POLL_INTERVAL_SECONDS=",
        "AIOPS_INTERNAL_API_KEY=",
        "DEEPSEEK_LIGHTWEIGHT_MODEL=",
        "DEEPSEEK_REASONING_MODEL=",
        "AIOPS_ENABLE_PROVIDER_FALLBACK=",
    )
    for key in expected_keys:
        assert key in content

    empty_secret_keys = (
        "AIOPS_WEBHOOK_SECRET=",
        "AIOPS_INTERNAL_API_KEY=",
        "DEEPSEEK_API_KEY=",
        "JEV_API_KEY=",
        "GEMINI_API_KEY=",
        "AWS_ACCESS_KEY_ID=",
        "AWS_SECRET_ACCESS_KEY=",
        "AWS_SESSION_TOKEN=",
        "MANAGEMENT_API_TOKEN=",
        "TELEGRAM_BOT_TOKEN=",
        "TELEGRAM_ADMIN_CHAT_ID=",
        "TELEGRAM_WEBHOOK_SECRET=",
    )
    for line in content.splitlines():
        for secret_key in empty_secret_keys:
            if line.startswith(secret_key):
                assert line.partition("=")[2].strip() == "", f"Secret {secret_key} must be empty"


# ---------------------------------------------------------------------------
# 2. AWS SigV4 Signing (service="aps")
# ---------------------------------------------------------------------------


def test_sigv4_signature_headers_without_and_with_session_token() -> None:
    fixed_now = datetime(2026, 4, 15, 12, 30, 45, tzinfo=timezone.utc)
    url = "https://aps-workspaces.ap-southeast-1.amazonaws.com/workspaces/ws-test123/api/v1/query"
    body = "query=up%7Bserver_id%3D%22srv-01%22%7D"
    creds = AwsStaticCredentials(
        access_key_id="AKIAEXAMPLEKEY123456",
        secret_access_key="SecretKeyForUnitTestingOnly1234567890",
    )

    headers = sign_sigv4(
        method="POST",
        url=url,
        region="ap-southeast-1",
        service="aps",
        body=body,
        content_type="application/x-www-form-urlencoded",
        credentials=creds,
        now=fixed_now,
    )

    expected_payload_hash = hashlib.sha256(body.encode("utf-8")).hexdigest()
    assert headers["x-amz-date"] == "20260415T123045Z"
    assert headers["x-amz-content-sha256"] == expected_payload_hash
    assert headers["content-type"] == "application/x-www-form-urlencoded"
    assert headers["host"] == "aps-workspaces.ap-southeast-1.amazonaws.com"
    assert "x-amz-security-token" not in headers

    # Independently verify canonical request & AWS4-HMAC-SHA256 signature
    canonical_headers = (
        "content-type:application/x-www-form-urlencoded\n"
        "host:aps-workspaces.ap-southeast-1.amazonaws.com\n"
        f"x-amz-content-sha256:{expected_payload_hash}\n"
        "x-amz-date:20260415T123045Z\n"
    )
    signed_headers = "content-type;host;x-amz-content-sha256;x-amz-date"
    canonical_request = "\n".join(
        [
            "POST",
            "/workspaces/ws-test123/api/v1/query",
            "",
            canonical_headers,
            signed_headers,
            expected_payload_hash,
        ]
    )
    scope = "20260415/ap-southeast-1/aps/aws4_request"
    string_to_sign = "\n".join(
        [
            "AWS4-HMAC-SHA256",
            "20260415T123045Z",
            scope,
            hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ]
    )
    k_date = hmac.new(b"AWS4SecretKeyForUnitTestingOnly1234567890", b"20260415", hashlib.sha256).digest()
    k_region = hmac.new(k_date, b"ap-southeast-1", hashlib.sha256).digest()
    k_service = hmac.new(k_region, b"aps", hashlib.sha256).digest()
    k_signing = hmac.new(k_service, b"aws4_request", hashlib.sha256).digest()
    expected_sig = hmac.new(k_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

    assert headers["Authorization"] == (
        f"AWS4-HMAC-SHA256 Credential=AKIAEXAMPLEKEY123456/{scope}, "
        f"SignedHeaders={signed_headers}, Signature={expected_sig}"
    )

    # Now verify with optional session token
    creds_with_token = AwsStaticCredentials(
        access_key_id=creds.access_key_id,
        secret_access_key=creds.secret_access_key,
        session_token="FwoGZXIvYXdzEBYaDTestSessionToken",
    )
    headers_tok = sign_sigv4(
        method="POST",
        url=url,
        region="ap-southeast-1",
        service="aps",
        body=body,
        content_type="application/x-www-form-urlencoded",
        credentials=creds_with_token,
        now=fixed_now,
    )
    assert headers_tok["x-amz-security-token"] == "FwoGZXIvYXdzEBYaDTestSessionToken"
    assert (
        "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token"
        in headers_tok["Authorization"]
    )


def test_sigv4_rejects_missing_credentials() -> None:
    with pytest.raises(ValueError, match="access_key_id"):
        sign_sigv4(
            method="POST",
            url="https://aps-workspaces.ap-southeast-1.amazonaws.com/workspaces/ws-1/api/v1/query",
            region="ap-southeast-1",
            body="query=up",
        )


# ---------------------------------------------------------------------------
# 3. AMPClient POST /api/v1/query, /api/v1/query_range & Error Reporting
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_amp_client_query_and_query_range_signed_post() -> None:
    captured_requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured_requests.append(request)
        if request.url.path.endswith("/api/v1/query"):
            return httpx.Response(
                200,
                json={
                    "status": "success",
                    "data": {
                        "resultType": "vector",
                        "result": [{"metric": {"server_id": "srv-01"}, "value": [1710000000, "1"]}],
                    },
                },
            )
        return httpx.Response(
            200,
            json={
                "status": "success",
                "data": {
                    "resultType": "matrix",
                    "result": [
                        {
                            "metric": {"server_id": "srv-01"},
                            "values": [[1710000000, "42.5"], [1710000060, "44.0"]],
                        }
                    ],
                },
            },
        )

    settings = AIOpsSettings(
        _env_file=None,
        AMP_ENDPOINT="https://aps-workspaces.ap-southeast-1.amazonaws.com/workspaces/ws-abc123",
        AWS_REGION="ap-southeast-1",
        AWS_ACCESS_KEY_ID=SecretStr("AKIAEXAMPLE123"),
        AWS_SECRET_ACCESS_KEY=SecretStr("SecretExample456"),
        AWS_SESSION_TOKEN=SecretStr("SessionToken789"),
    )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        amp = AMPClient(settings, http_client=client)
        instant = await amp.query('up{server_id="srv-01"}')
        ranged = await amp.query_range(
            'node_load1{server_id="srv-01"}',
            start=1710000000,
            end=1710000900,
            step=60,
        )

    assert instant["status"] == "success"
    assert ranged["data"]["resultType"] == "matrix"
    assert len(captured_requests) == 2

    req_query, req_range = captured_requests
    assert req_query.method == "POST"
    assert str(req_query.url) == (
        "https://aps-workspaces.ap-southeast-1.amazonaws.com/workspaces/ws-abc123/api/v1/query"
    )
    assert req_query.headers["content-type"] == "application/x-www-form-urlencoded"
    assert req_query.headers["authorization"].startswith("AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE123/")
    assert "/ap-southeast-1/aps/aws4_request" in req_query.headers["authorization"]
    assert "x-amz-date" in req_query.headers
    assert "x-amz-content-sha256" in req_query.headers
    assert req_query.headers["x-amz-security-token"] == "SessionToken789"
    assert parse_qs(req_query.content.decode("utf-8")) == {"query": ['up{server_id="srv-01"}']}

    assert req_range.method == "POST"
    assert str(req_range.url).endswith("/api/v1/query_range")
    assert parse_qs(req_range.content.decode("utf-8")) == {
        "query": ['node_load1{server_id="srv-01"}'],
        "start": ["1710000000"],
        "end": ["1710000900"],
        "step": ["60"],
    }


@pytest.mark.asyncio
async def test_amp_query_http_error_and_transport_error_report_degraded_failure() -> None:
    settings = AIOpsSettings(
        _env_file=None,
        AMP_ENDPOINT="https://aps-workspaces.ap-southeast-1.amazonaws.com/workspaces/ws-abc123",
        AWS_ACCESS_KEY_ID=SecretStr("AKIAEXAMPLE123"),
        AWS_SECRET_ACCESS_KEY=SecretStr("SecretExample456"),
    )

    # HTTP 403 AccessDenied
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda req: httpx.Response(403, text="Forbidden"))
    ) as client_403:
        mcp = MCPToolRegistry(settings, http_client=client_403)
        res_403 = await mcp.query_prometheus(template="vm_up", server_id="srv-01")
        assert res_403.success is False
        assert res_403.degraded is True
        assert res_403.source == "amp_error"
        assert res_403.error is not None and "403" in res_403.error

    # Transport connection error
    def fail_transport(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("AMP unreachable", request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(fail_transport)) as client_err:
        mcp_err = MCPToolRegistry(settings, http_client=client_err)
        res_err = await mcp_err.query_prometheus(template="linux_cpu_usage_pct", server_id="srv-01")
        assert res_err.success is False
        assert res_err.degraded is True
        assert res_err.source == "amp_error"
        assert res_err.error is not None and "AMP transport error" in res_err.error

        with pytest.raises(AMPQueryError):
            await mcp_err.amp_client.query('up{server_id="srv-01"}')


@pytest.mark.asyncio
async def test_amp_unconfigured_returns_honest_degraded_snapshot() -> None:
    mcp = MCPToolRegistry()
    res = await mcp.query_prometheus(template="linux_memory_usage_pct", server_id="srv-linux-01")
    assert res.success is True
    assert res.degraded is True
    assert res.error is None
    assert res.source == "amp_unconfigured_snapshot"
    assert 'node_memory_MemAvailable_bytes{server_id="srv-linux-01"}' in res.data["promql"]
    assert 'node_memory_MemTotal_bytes{server_id="srv-linux-01"}' in res.data["promql"]


# ---------------------------------------------------------------------------
# 4. PromQL Injection Escaping & Template Allowlist Enforcement
# ---------------------------------------------------------------------------


def test_promql_label_escaping_prevents_injection() -> None:
    adversarial = 'srv-1"} or vector(1) #'
    escaped = _escape_promql_label_value(adversarial)
    assert escaped == 'srv-1\\"} or vector(1) #'

    promql = render_promql_template("vm_up", server_id=adversarial)
    assert promql == 'up{server_id="srv-1\\"} or vector(1) #"}'

    # Backslash followed by quote must escape both so the quote stays inside string
    backslash_quote = 'srv-1\\"}) or up{x="'
    promql_bs = render_promql_template("linux_load1", server_id=backslash_quote)
    assert promql_bs == 'node_load1{server_id="srv-1\\\\\\"}) or up{x=\\""}'

    # Control characters / newlines escaped
    newline_attack = "srv-1\n\"}\x00"
    assert _escape_promql_label_value(newline_attack) == 'srv-1\\n\\"}'


@pytest.mark.asyncio
async def test_query_prometheus_rejects_legacy_telegraf_and_unknown_templates() -> None:
    mcp = MCPToolRegistry()

    # Legacy Telegraf metrics are removed from allowlist
    for dead_metric in ("cpu_usage_active", "mem_used_percent", "disk_used_percent", "unknown_metric"):
        assert dead_metric not in ALLOWLISTED_PROMQL_TEMPLATES
        with pytest.raises(ValueError, match="ALLOWLISTED_PROMQL_TEMPLATES"):
            await mcp.query_prometheus(metric=dead_metric, server_id="srv-01")

    # Legacy `metric=` kwarg still works for valid templates and `"up"` alias
    res_up = await mcp.query_prometheus(metric="up", server_id="srv-01")
    assert res_up.data["template"] == "vm_up"
    assert res_up.data["promql"] == 'up{server_id="srv-01"}'

    res_legacy_kw = await mcp.query_prometheus(metric="linux_load1", server_id="srv-01")
    assert res_legacy_kw.data["template"] == "linux_load1"
    assert res_legacy_kw.data["promql"] == 'node_load1{server_id="srv-01"}'


# ---------------------------------------------------------------------------
# 5. All 4 Domain PromQL Template Bundles (Linux VM, Windows VM, Container, SSL)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_query_domain_metrics_all_four_bundles() -> None:
    assert set(PROMQL_TEMPLATES.keys()) == ALLOWLISTED_PROMQL_TEMPLATES
    mcp = MCPToolRegistry()

    # 1) Linux VM bundle
    linux_results = await mcp.query_domain_metrics(
        domain="vm",
        target_id="srv-linux-01",
        platform="linux",
    )
    assert [r.data["template"] for r in linux_results] == list(LINUX_VM_TEMPLATES)
    linux_promqls = {r.data["template"]: r.data["promql"] for r in linux_results}
    assert 'up{server_id="srv-linux-01"}' == linux_promqls["vm_up"]
    assert 'node_cpu_seconds_total{mode="idle",server_id="srv-linux-01"}[5m]' in linux_promqls["linux_cpu_usage_pct"]
    assert "node_memory_MemAvailable_bytes" in linux_promqls["linux_memory_usage_pct"]
    assert "node_memory_MemTotal_bytes" in linux_promqls["linux_memory_usage_pct"]
    assert "node_memory_SwapTotal_bytes" in linux_promqls["linux_swap_usage_pct"]
    assert "node_filesystem_avail_bytes" in linux_promqls["linux_disk_usage_pct"]
    assert "node_filesystem_size_bytes" in linux_promqls["linux_disk_usage_pct"]
    assert 'node_load1{server_id="srv-linux-01"}' == linux_promqls["linux_load1"]
    assert "node_pressure_memory_waiting_seconds_total" in linux_promqls["linux_pressure_waiting"]
    assert "node_pressure_cpu_waiting_seconds_total" in linux_promqls["linux_pressure_waiting"]
    assert "node_pressure_io_waiting_seconds_total" in linux_promqls["linux_pressure_waiting"]

    # 2) Windows VM bundle
    win_results = await mcp.query_domain_metrics(
        domain="vm",
        target_id="srv-win-01",
        platform="windows",
    )
    assert [r.data["template"] for r in win_results] == list(WINDOWS_VM_TEMPLATES)
    win_promqls = {r.data["template"]: r.data["promql"] for r in win_results}
    assert 'up{server_id="srv-win-01"}' == win_promqls["vm_up"]
    assert 'windows_cpu_time_total{mode="idle",server_id="srv-win-01"}[5m]' in win_promqls["windows_cpu_usage_pct"]
    assert "windows_memory_available_bytes" in win_promqls["windows_memory_usage_pct"]
    assert "windows_cs_physical_memory_bytes" in win_promqls["windows_memory_usage_pct"]
    assert "windows_logical_disk_free_bytes" in win_promqls["windows_disk_usage_pct"]
    assert "windows_logical_disk_size_bytes" in win_promqls["windows_disk_usage_pct"]
    assert (
        'windows_system_processor_queue_length{server_id="srv-win-01"}'
        == win_promqls["windows_processor_queue_length"]
    )

    # 3) Container bundle (both explicit container arg and composite target_id)
    ctr_results = await mcp.query_domain_metrics(
        domain="container",
        target_id="srv-docker-01:payment-api",
    )
    assert [r.data["template"] for r in ctr_results] == list(CONTAINER_TEMPLATES)
    ctr_promqls = {r.data["template"]: r.data["promql"] for r in ctr_results}
    expected_sel = 'server_id="srv-docker-01",container="payment-api"'
    assert ctr_promqls["container_running"] == f"infrapulse_container_running{{{expected_sel}}}"
    assert ctr_promqls["container_state_code"] == f"infrapulse_container_state_code{{{expected_sel}}}"
    assert ctr_promqls["container_health_code"] == f"infrapulse_container_health_code{{{expected_sel}}}"
    assert ctr_promqls["container_restarts"] == f"infrapulse_container_restarts_total{{{expected_sel}}}"
    assert ctr_promqls["container_oom_killed"] == f"infrapulse_container_oom_killed{{{expected_sel}}}"
    assert f"rate(container_cpu_usage_seconds_total{{{expected_sel}}}[5m])" == ctr_promqls["container_cpu_usage_rate"]
    assert "container_cpu_cfs_throttled_periods_total" in ctr_promqls["container_cpu_throttled_pct"]
    assert "container_cpu_cfs_periods_total" in ctr_promqls["container_cpu_throttled_pct"]
    assert "container_memory_working_set_bytes" in ctr_promqls["container_memory_working_set_pct"]
    assert "container_spec_memory_limit_bytes" in ctr_promqls["container_memory_working_set_pct"]

    # 4a) External SSL bundle
    ext_ssl = await mcp.query_domain_metrics(
        domain="ssl",
        target_id="api.example.com:443",
    )
    assert [r.data["template"] for r in ext_ssl] == list(SSL_TEMPLATES)
    ext_promqls = {r.data["template"]: r.data["promql"] for r in ext_ssl}
    assert (
        ext_promqls["ssl_cert_days_remaining"]
        == '(x509_cert_not_after{endpoint="api.example.com:443"} - time()) / 86400'
    )
    assert ext_promqls["ssl_read_errors"] == 'x509_read_errors{source="external"}'

    # 4b) Local VM SSL bundle
    local_ssl = await mcp.query_domain_metrics(
        domain="ssl",
        target_id="srv-linux-01",
        filepath="/etc/letsencrypt/live/app.example.com/fullchain.pem",
    )
    local_promqls = {r.data["template"]: r.data["promql"] for r in local_ssl}
    assert (
        local_promqls["ssl_cert_days_remaining"]
        == '(x509_cert_not_after{server_id="srv-linux-01",filepath="/etc/letsencrypt/live/app.example.com/fullchain.pem"} - time()) / 86400'
    )
    assert local_promqls["ssl_read_errors"] == 'x509_read_errors{server_id="srv-linux-01"}'


# ---------------------------------------------------------------------------
# 6. P1.1 Management Backend Live Context & SSL Probe Tools
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_server_context_live_and_unconfigured_and_error() -> None:
    captured_auth: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured_auth.append(request.headers.get("authorization"))
        if request.url.path == "/api/v1/servers/srv-prod-01":
            return httpx.Response(
                200,
                json={
                    "id": "srv-prod-01",
                    "name": "prod-app-01",
                    "os": "linux",
                    "environment": "production",
                    "groups": ["core-web", "ap-se-1"],
                    "metadata": {"role": "api"},
                    "dashboardContext": {
                        "serverId": "srv-prod-01",
                        "nodeId": "mi-0123456789abcdef0",
                        "platform": "linux",
                        "state": "Active",
                    },
                    "onboarding": {
                        "state": "Success",
                        "monitoring": {
                            "health": "Fresh",
                            "lastObservedSampleAt": "2026-04-15T12:29:00.000Z",
                        },
                    },
                },
            )
        return httpx.Response(503, text="Backend unavailable")

    settings = AIOpsSettings(
        _env_file=None,
        MANAGEMENT_API_BASE_URL="http://management.internal:3001",
        MANAGEMENT_API_TOKEN=SecretStr("admin-assertion-jwt"),
    )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        mcp = MCPToolRegistry(settings, http_client=client)

        ok = await mcp.get_server_context(server_id="srv-prod-01")
        assert ok.success is True
        assert ok.degraded is False
        assert ok.source == "management_api_live"
        assert ok.data["platform"] == "linux"
        assert ok.data["managed_node_id"] == "mi-0123456789abcdef0"
        assert ok.data["monitoring_health"] == "Fresh"
        assert ok.data["groups"] == ["core-web", "ap-se-1"]
        assert ok.data["last_observed_sample_at"] == "2026-04-15T12:29:00.000Z"
        assert ok.data["active_service"] == "grafana-alloy"
        assert captured_auth == ["Bearer admin-assertion-jwt"]

        err = await mcp.get_server_context(server_id="srv-missing")
        assert err.success is False
        assert err.degraded is True
        assert err.source == "management_api_error"
        assert err.error is not None and "503" in err.error

    # Unconfigured mode uses grafana-alloy (zero telegraf references) and marks degraded=True
    offline_mcp = MCPToolRegistry()
    offline = await offline_mcp.get_server_context(server_id="srv-offline-01")
    assert offline.success is True
    assert offline.degraded is True
    assert offline.data["active_service"] == "grafana-alloy"
    assert "telegraf" not in offline.formatted_context.lower()


@pytest.mark.asyncio
async def test_get_ssl_target_context_and_reprobe_ssl_target_live() -> None:
    requests_seen: list[tuple[str, str, str | None]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests_seen.append((request.method, request.url.path, request.headers.get("authorization")))
        if request.method == "GET" and request.url.path == "/api/v1/ssl-targets":
            return httpx.Response(
                200,
                json={
                    "items": [
                        {
                            "id": "ssl-uuid-001",
                            "name": "Public API TLS",
                            "host": "api.infrapulse.example.com",
                            "port": 443,
                            "group": "production",
                            "enabled": True,
                            "subjectCn": "api.infrapulse.example.com",
                            "issuerCn": "Let's Encrypt R11",
                            "serialNumber": "04AABBCC",
                            "notBefore": "2026-02-01T00:00:00.000Z",
                            "notAfter": "2026-04-20T00:00:00.000Z",
                            "authorized": True,
                            "lastProbedAt": "2026-04-15T12:25:00.000Z",
                            "lastError": None,
                        }
                    ]
                },
            )
        if request.method == "POST" and request.url.path == "/api/v1/ssl-targets/ssl-uuid-001/probe":
            return httpx.Response(
                200,
                json={
                    "id": "ssl-uuid-001",
                    "name": "Public API TLS",
                    "host": "api.infrapulse.example.com",
                    "port": 443,
                    "group": "production",
                    "enabled": True,
                    "subjectCn": "api.infrapulse.example.com",
                    "issuerCn": "Let's Encrypt R11",
                    "notAfter": "2026-07-15T00:00:00.000Z",
                    "authorized": True,
                    "lastProbedAt": "2026-04-15T12:31:00.000Z",
                    "lastError": None,
                },
            )
        return httpx.Response(404, text="Not found")

    settings = AIOpsSettings(
        _env_file=None,
        MANAGEMENT_API_BASE_URL="http://management.internal:3001",
        MANAGEMENT_API_TOKEN=SecretStr("ssl-mgmt-token"),
    )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        mcp = MCPToolRegistry(settings, http_client=client)

        # Match by endpoint
        by_ep = await mcp.get_ssl_target_context(endpoint="api.infrapulse.example.com:443")
        assert by_ep.success is True
        assert by_ep.degraded is False
        assert by_ep.data["matched"] is True
        assert by_ep.data["target_id"] == "ssl-uuid-001"
        assert by_ep.data["issuer_cn"] == "Let's Encrypt R11"

        # Match by target_name
        by_name = await mcp.invoke_tool(
            "get_ssl_target_context",
            {"target_name": "Public API TLS"},
        )
        assert by_name.success is True
        assert by_name.data["matched"] is True
        assert by_name.data["endpoint"] == "api.infrapulse.example.com:443"

        # Reprobe target
        probed = await mcp.invoke_tool("reprobe_ssl_target", {"target_id": "ssl-uuid-001"})
        assert probed.success is True
        assert probed.degraded is False
        assert probed.source == "management_api_live"
        assert probed.data["not_after"] == "2026-07-15T00:00:00.000Z"

        # Missing target returns degraded failure
        missing = await mcp.reprobe_ssl_target(target_id="ssl-nonexistent")
        assert missing.success is False
        assert missing.degraded is True
        assert missing.error is not None and "404" in missing.error

    assert requests_seen[0] == ("GET", "/api/v1/ssl-targets", "Bearer ssl-mgmt-token")
    assert requests_seen[2] == ("POST", "/api/v1/ssl-targets/ssl-uuid-001/probe", "Bearer ssl-mgmt-token")


@pytest.mark.asyncio
async def test_query_logs_schema_and_tool_registry_listing() -> None:
    mcp = MCPToolRegistry()
    tools = {t.name: t for t in mcp.list_tools()}
    assert set(tools.keys()) == {
        "query_prometheus",
        "get_server_context",
        "get_ssl_target_context",
        "reprobe_ssl_target",
        "search_runbook",
        "query_logs",
    }

    query_logs_props = set(tools["query_logs"].input_schema["properties"].keys())
    assert query_logs_props == {"server_id", "service", "limit", "annotation_summary"}

    log_res = await mcp.invoke_tool(
        "query_logs",
        {
            "server_id": "srv-01",
            "service": "grafana-alloy",
            "limit": 2,
            "annotation_summary": "line1\nline2\nline3",
        },
    )
    assert log_res.success is True
    assert log_res.data["limit"] == 2
    assert log_res.data["line_count"] == 2
    assert "<untrusted_telemetry>" in log_res.formatted_context
    assert "line1" in log_res.formatted_context
    assert "line2" in log_res.formatted_context
    assert "line3" not in log_res.formatted_context
