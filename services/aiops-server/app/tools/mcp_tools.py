"""P0.2 & P1.1: Model Context Protocol (MCP) Diagnostic & Context Tool Registry (`app/tools/mcp_tools.py`).

Provides strictly bounded, parameterized diagnostic and context tools for SaSa AI
aligned with InfraPulse's AWS SSM + Grafana Alloy + Amazon Managed Prometheus (AMP)
+ Neon management-backend architecture:
1. `query_prometheus`: Executes allowlisted parameterized PromQL templates against AMP via SigV4.
2. `get_server_context`: Queries `GET /api/v1/servers/{server_id}` for live VM metadata & health.
3. `get_ssl_target_context`: Queries `GET /api/v1/ssl-targets` and matches external/local SSL target context.
4. `reprobe_ssl_target`: Triggers `POST /api/v1/ssl-targets/{target_id}/probe` (safe allowlisted probe action).
5. `search_runbook`: Queries the multi-stage `RunbookRAGPipeline` for grounded SRE procedures.
6. `query_logs`: Retrieves sanitized log lines wrapped in `<untrusted_telemetry>` blocks.
"""

from __future__ import annotations

import asyncio
import inspect
import re
from typing import Any
from urllib.parse import quote

import httpx
from pydantic import BaseModel, Field

from app.config import AIOpsSettings
from app.guardrails.sanitizer import InputSanitizer
from app.rag.runbook_rag import RunbookRAGPipeline
from app.tools.amp_client import AMPClient, AMPQueryError

# Parameterized PromQL templates grounded in origin/main's Grafana Alloy + AMP metric contract.
PROMQL_TEMPLATES: dict[str, str] = {
    # Shared VM heartbeat
    "vm_up": 'up{{server_id="{server_id}"}}',
    # Linux VM (node_exporter via Grafana Alloy)
    "linux_cpu_usage_pct": (
        '100 - avg by (server_id) (rate(node_cpu_seconds_total{{mode="idle",server_id="{server_id}"}}[5m])) * 100'
    ),
    "linux_memory_usage_pct": (
        '(1 - node_memory_MemAvailable_bytes{{server_id="{server_id}"}} '
        '/ node_memory_MemTotal_bytes{{server_id="{server_id}"}}) * 100'
    ),
    "linux_swap_usage_pct": (
        '((node_memory_SwapTotal_bytes{{server_id="{server_id}"}} '
        '- node_memory_SwapFree_bytes{{server_id="{server_id}"}}) '
        '/ clamp_min(node_memory_SwapTotal_bytes{{server_id="{server_id}"}}, 1)) * 100'
    ),
    "linux_disk_usage_pct": (
        '(1 - node_filesystem_avail_bytes{{server_id="{server_id}",fstype!="rootfs"}} '
        '/ node_filesystem_size_bytes{{server_id="{server_id}",fstype!="rootfs"}}) * 100'
    ),
    "linux_load1": 'node_load1{{server_id="{server_id}"}}',
    "linux_pressure_waiting": (
        'label_replace(rate(node_pressure_memory_waiting_seconds_total{{server_id="{server_id}"}}[5m]), "psi_resource", "memory", "", "") '
        'or label_replace(rate(node_pressure_cpu_waiting_seconds_total{{server_id="{server_id}"}}[5m]), "psi_resource", "cpu", "", "") '
        'or label_replace(rate(node_pressure_io_waiting_seconds_total{{server_id="{server_id}"}}[5m]), "psi_resource", "io", "", "")'
    ),
    # Windows VM (windows_exporter via Grafana Alloy)
    "windows_cpu_usage_pct": (
        '100 - avg by (server_id) (rate(windows_cpu_time_total{{mode="idle",server_id="{server_id}"}}[5m])) * 100'
    ),
    "windows_memory_usage_pct": (
        '(1 - windows_memory_available_bytes{{server_id="{server_id}"}} '
        '/ windows_cs_physical_memory_bytes{{server_id="{server_id}"}}) * 100'
    ),
    "windows_disk_usage_pct": (
        '(1 - windows_logical_disk_free_bytes{{server_id="{server_id}"}} '
        '/ windows_logical_disk_size_bytes{{server_id="{server_id}"}}) * 100'
    ),
    "windows_processor_queue_length": 'windows_system_processor_queue_length{{server_id="{server_id}"}}',
    # Docker Containers (cAdvisor + infrapulse-docker-state textfile)
    "container_running": "infrapulse_container_running{{{container_selector}}}",
    "container_state_code": "infrapulse_container_state_code{{{container_selector}}}",
    "container_health_code": "infrapulse_container_health_code{{{container_selector}}}",
    "container_restarts": "infrapulse_container_restarts_total{{{container_selector}}}",
    "container_oom_killed": "infrapulse_container_oom_killed{{{container_selector}}}",
    "container_cpu_usage_rate": "rate(container_cpu_usage_seconds_total{{{container_selector}}}[5m])",
    "container_cpu_throttled_pct": (
        "(sum by (server_id, container) (rate(container_cpu_cfs_throttled_periods_total{{{container_selector}}}[5m])) "
        "/ clamp_min(sum by (server_id, container) (rate(container_cpu_cfs_periods_total{{{container_selector}}}[5m])), 1)) * 100"
    ),
    "container_memory_working_set_pct": (
        "(container_memory_working_set_bytes{{{container_selector}}} "
        "/ (container_spec_memory_limit_bytes{{{container_selector}}} > 0)) * 100"
    ),
    # SSL Certificates (external HTTPS prober + local VM x509 scanners)
    "ssl_cert_days_remaining": "(x509_cert_not_after{{{ssl_selector}}} - time()) / 86400",
    "ssl_read_errors": "x509_read_errors{{{ssl_error_selector}}}",
}

ALLOWLISTED_PROMQL_TEMPLATES: frozenset[str] = frozenset(PROMQL_TEMPLATES.keys())
# Backward-compatible export alias referencing the new template allowlist
ALLOWLISTED_PROMQL_METRICS: frozenset[str] = ALLOWLISTED_PROMQL_TEMPLATES

LINUX_VM_TEMPLATES: tuple[str, ...] = (
    "vm_up",
    "linux_cpu_usage_pct",
    "linux_memory_usage_pct",
    "linux_swap_usage_pct",
    "linux_disk_usage_pct",
    "linux_load1",
    "linux_pressure_waiting",
)

WINDOWS_VM_TEMPLATES: tuple[str, ...] = (
    "vm_up",
    "windows_cpu_usage_pct",
    "windows_memory_usage_pct",
    "windows_disk_usage_pct",
    "windows_processor_queue_length",
)

CONTAINER_TEMPLATES: tuple[str, ...] = (
    "container_running",
    "container_state_code",
    "container_health_code",
    "container_restarts",
    "container_oom_killed",
    "container_cpu_usage_rate",
    "container_cpu_throttled_pct",
    "container_memory_working_set_pct",
)

SSL_TEMPLATES: tuple[str, ...] = (
    "ssl_cert_days_remaining",
    "ssl_read_errors",
)

_HOST_PORT_RE = re.compile(r"^[^/\s\\]+:\d{1,5}$")


def _escape_promql_label_value(value: str) -> str:
    """Strictly escape a label value for safe interpolation inside PromQL `"..."` matchers."""
    cleaned = value.replace("\x00", "").strip()
    return (
        cleaned.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\t", "\\t")
    )


def _format_selector(pairs: list[tuple[str, str]]) -> str:
    return ",".join(f'{key}="{_escape_promql_label_value(val)}"' for key, val in pairs if val)


def render_promql_template(
    template: str,
    *,
    server_id: str | None = None,
    container: str | None = None,
    endpoint: str | None = None,
    filepath: str | None = None,
) -> str:
    """Render a validated allowlisted PromQL template with escaped label matchers."""
    if template not in ALLOWLISTED_PROMQL_TEMPLATES:
        raise ValueError(
            f"Template '{template}' is not in ALLOWLISTED_PROMQL_TEMPLATES."
        )

    clean_server = (
        InputSanitizer.inspect_text(server_id, field_name="server_id")
        if server_id
        else ""
    )
    clean_container = (
        InputSanitizer.inspect_text(container, field_name="container")
        if container
        else ""
    )
    clean_endpoint = (
        InputSanitizer.inspect_text(endpoint, field_name="endpoint")
        if endpoint
        else ""
    )
    clean_filepath = (
        InputSanitizer.inspect_text(filepath, field_name="filepath")
        if filepath
        else ""
    )

    escaped_server = _escape_promql_label_value(clean_server)

    container_pairs: list[tuple[str, str]] = []
    if clean_server:
        container_pairs.append(("server_id", clean_server))
    if clean_container:
        container_pairs.append(("container", clean_container))
    container_selector = _format_selector(container_pairs)

    ssl_pairs: list[tuple[str, str]] = []
    if clean_endpoint:
        ssl_pairs.append(("endpoint", clean_endpoint))
    else:
        if clean_server and clean_server != "management-ssl-prober":
            ssl_pairs.append(("server_id", clean_server))
        if clean_filepath:
            ssl_pairs.append(("filepath", clean_filepath))
    ssl_selector = _format_selector(ssl_pairs)

    ssl_error_pairs: list[tuple[str, str]] = []
    if clean_server and clean_server != "management-ssl-prober" and not clean_endpoint:
        ssl_error_pairs.append(("server_id", clean_server))
    else:
        ssl_error_pairs.append(("source", "external"))
    ssl_error_selector = _format_selector(ssl_error_pairs)

    raw_template = PROMQL_TEMPLATES[template]
    return raw_template.format(
        server_id=escaped_server,
        container_selector=container_selector,
        ssl_selector=ssl_selector,
        ssl_error_selector=ssl_error_selector,
    )


class MCPToolDefinition(BaseModel):
    """MCP-compliant tool schema definition."""

    name: str
    description: str
    read_only: bool = True
    input_schema: dict[str, Any] = Field(default_factory=dict)


class MCPToolCallResult(BaseModel):
    """Structured output returned by an MCP tool invocation."""

    tool_name: str
    success: bool = True
    degraded: bool = False
    error: str | None = None
    source: str = "local_context"
    data: dict[str, Any] = Field(default_factory=dict)
    formatted_context: str = ""


class MCPToolRegistry:
    """Registry and executor for bounded MCP diagnostic and live-context tools."""

    def __init__(
        self,
        settings: AIOpsSettings | None = None,
        *,
        rag_pipeline: RunbookRAGPipeline | None = None,
        amp_client: AMPClient | None = None,
        prometheus_base_url: str | None = None,
        management_api_base_url: str | None = None,
        management_api_token: str | None = None,
        management_api_timeout_seconds: float | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self.settings = settings
        self.rag_pipeline = rag_pipeline or RunbookRAGPipeline()
        self._client = http_client

        if amp_client is not None:
            self.amp_client = amp_client
        else:
            effective_amp_endpoint = (
                prometheus_base_url
                if prometheus_base_url is not None
                else (settings.AMP_ENDPOINT if settings is not None else "")
            )
            self.amp_client = AMPClient(
                settings,
                endpoint=effective_amp_endpoint,
                http_client=http_client,
            )

        self.management_api_base_url = (
            management_api_base_url
            if management_api_base_url is not None
            else (settings.MANAGEMENT_API_BASE_URL if settings is not None else "")
        ).strip().rstrip("/")
        self._management_api_token = (
            management_api_token
            if management_api_token is not None
            else (settings.MANAGEMENT_API_TOKEN.get_secret_value() if settings is not None else "")
        ).strip()
        self.management_api_timeout_seconds = (
            float(management_api_timeout_seconds)
            if management_api_timeout_seconds is not None
            else (float(settings.MANAGEMENT_API_TIMEOUT_SECONDS) if settings is not None else 5.0)
        )

    def _management_headers(self) -> dict[str, str]:
        headers = {"Accept": "application/json"}
        if self._management_api_token:
            headers["Authorization"] = f"Bearer {self._management_api_token}"
        return headers

    @staticmethod
    def list_tools() -> list[MCPToolDefinition]:
        """Return MCP-standard tool definitions available to SaSa AI."""
        return [
            MCPToolDefinition(
                name="query_prometheus",
                description=(
                    "Execute a bounded read-only PromQL template query against Amazon Managed "
                    "Prometheus (AMP) using AWS SigV4 authentication."
                ),
                read_only=True,
                input_schema={
                    "type": "object",
                    "properties": {
                        "template": {
                            "type": "string",
                            "enum": sorted(ALLOWLISTED_PROMQL_TEMPLATES),
                        },
                        "metric": {
                            "type": "string",
                            "description": "Legacy alias for `template`.",
                        },
                        "server_id": {"type": "string"},
                        "container": {"type": "string"},
                        "endpoint": {"type": "string"},
                        "filepath": {"type": "string"},
                        "window_minutes": {"type": "integer", "minimum": 1, "maximum": 60},
                    },
                },
            ),
            MCPToolDefinition(
                name="get_server_context",
                description=(
                    "Retrieve live server platform, managed_node_id, monitoring_health, groups, "
                    "and last_observed_sample_at from management-backend."
                ),
                read_only=True,
                input_schema={
                    "type": "object",
                    "properties": {"server_id": {"type": "string"}},
                    "required": ["server_id"],
                },
            ),
            MCPToolDefinition(
                name="get_ssl_target_context",
                description=(
                    "Retrieve external/local SSL certificate target metadata and probe status "
                    "from management-backend."
                ),
                read_only=True,
                input_schema={
                    "type": "object",
                    "properties": {
                        "endpoint": {"type": "string"},
                        "target_name": {"type": "string"},
                        "server_id": {"type": "string"},
                        "filepath": {"type": "string"},
                    },
                },
            ),
            MCPToolDefinition(
                name="reprobe_ssl_target",
                description=(
                    "Trigger an allowlisted immediate TLS re-probe via management-backend "
                    "(`POST /api/v1/ssl-targets/{target_id}/probe`)."
                ),
                read_only=False,
                input_schema={
                    "type": "object",
                    "properties": {"target_id": {"type": "string"}},
                    "required": ["target_id"],
                },
            ),
            MCPToolDefinition(
                name="search_runbook",
                description="Search internal InfraPulse SRE runbooks via the RAG pipeline.",
                read_only=True,
                input_schema={
                    "type": "object",
                    "properties": {
                        "query": {"type": "string"},
                        "os_type": {"type": "string"},
                        "service": {"type": "string"},
                        "domain": {"type": "string"},
                        "top_k": {"type": "integer", "minimum": 1, "maximum": 5},
                    },
                    "required": ["query"],
                },
            ),
            MCPToolDefinition(
                name="query_logs",
                description="Retrieve recent sanitized log lines for a server_id and service.",
                read_only=True,
                input_schema={
                    "type": "object",
                    "properties": {
                        "server_id": {"type": "string"},
                        "service": {"type": "string"},
                        "limit": {"type": "integer", "minimum": 1, "maximum": 50},
                        "annotation_summary": {"type": "string"},
                    },
                    "required": ["server_id"],
                },
            ),
        ]

    async def query_prometheus(
        self,
        *,
        template: str | None = None,
        server_id: str | None = None,
        container: str | None = None,
        endpoint: str | None = None,
        filepath: str | None = None,
        window_minutes: int = 15,
        metric: str | None = None,
    ) -> MCPToolCallResult:
        """Query an allowlisted parameterized PromQL template against AMP (or honest unconfigured snapshot)."""
        raw_template = template if template is not None else metric
        if not raw_template:
            raise ValueError("Either 'template' or 'metric' must be provided.")
        clean_template = InputSanitizer.inspect_text(raw_template, field_name="template")
        if clean_template == "up":
            clean_template = "vm_up"
        if clean_template not in ALLOWLISTED_PROMQL_TEMPLATES:
            raise ValueError(
                f"Template '{clean_template}' is not in ALLOWLISTED_PROMQL_TEMPLATES."
            )

        bounded_window = max(1, min(60, int(window_minutes)))
        promql = render_promql_template(
            clean_template,
            server_id=server_id,
            container=container,
            endpoint=endpoint,
            filepath=filepath,
        )

        if not self.amp_client.is_configured:
            return MCPToolCallResult(
                tool_name="query_prometheus",
                success=True,
                degraded=True,
                error=None,
                source="amp_unconfigured_snapshot",
                data={
                    "template": clean_template,
                    "promql": promql,
                    "server_id": server_id,
                    "container": container,
                    "endpoint": endpoint,
                    "filepath": filepath,
                    "window_minutes": bounded_window,
                    "note": "AMP_ENDPOINT is not configured; returning generated PromQL without live query.",
                },
                formatted_context=(
                    f"MCP `query_prometheus` generated `{clean_template}` PromQL `{promql}` "
                    "(AMP_ENDPOINT unconfigured; degraded offline snapshot)."
                ),
            )

        try:
            payload = await self.amp_client.query(promql)
            result_data = payload.get("data", {})
            series = result_data.get("result") if isinstance(result_data, dict) else []
            series_count = len(series) if isinstance(series, list) else 0
            return MCPToolCallResult(
                tool_name="query_prometheus",
                success=True,
                degraded=False,
                error=None,
                source="amp_live",
                data={
                    "template": clean_template,
                    "promql": promql,
                    "window_minutes": bounded_window,
                    "result": result_data,
                },
                formatted_context=(
                    f"AMP live query `{clean_template}` (`{promql}`) succeeded "
                    f"({series_count} series returned)."
                ),
            )
        except (AMPQueryError, httpx.HTTPError) as exc:
            return MCPToolCallResult(
                tool_name="query_prometheus",
                success=False,
                degraded=True,
                error=str(exc),
                source="amp_error",
                data={
                    "template": clean_template,
                    "promql": promql,
                    "window_minutes": bounded_window,
                },
                formatted_context=(
                    f"AMP query `{clean_template}` failed (degraded): {exc}"
                ),
            )

    async def query_domain_metrics(
        self,
        *,
        domain: str,
        target_id: str,
        platform: str = "linux",
        container: str | None = None,
        filepath: str | None = None,
        window_minutes: int = 15,
    ) -> list[MCPToolCallResult]:
        """Run the full domain-appropriate PromQL template bundle for `'vm'`, `'container'`, or `'ssl'`."""
        clean_domain = InputSanitizer.inspect_text(domain, field_name="domain").lower()
        clean_target = InputSanitizer.inspect_text(target_id, field_name="target_id")
        clean_platform = (platform or "linux").strip().lower()

        if clean_domain == "vm":
            templates = (
                WINDOWS_VM_TEMPLATES if clean_platform == "windows" else LINUX_VM_TEMPLATES
            )
            tasks = [
                self.query_prometheus(
                    template=tpl,
                    server_id=clean_target,
                    window_minutes=window_minutes,
                )
                for tpl in templates
            ]
            return list(await asyncio.gather(*tasks))

        if clean_domain == "container":
            resolved_server = clean_target
            resolved_container = container
            if resolved_container:
                suffix = f":{resolved_container}"
                if resolved_server.endswith(suffix):
                    resolved_server = resolved_server[: -len(suffix)]
            elif ":" in clean_target:
                resolved_server, resolved_container = clean_target.split(":", 1)

            tasks = [
                self.query_prometheus(
                    template=tpl,
                    server_id=resolved_server,
                    container=resolved_container,
                    window_minutes=window_minutes,
                )
                for tpl in CONTAINER_TEMPLATES
            ]
            return list(await asyncio.gather(*tasks))

        if clean_domain == "ssl":
            resolved_endpoint: str | None = None
            resolved_server_id: str | None = None
            resolved_filepath: str | None = filepath

            if resolved_filepath:
                suffix = f":{resolved_filepath}"
                resolved_server_id = (
                    clean_target[: -len(suffix)]
                    if clean_target.endswith(suffix)
                    else clean_target
                )
            elif ":/" in clean_target or ":\\" in clean_target or ":Cert:" in clean_target:
                resolved_server_id, resolved_filepath = clean_target.split(":", 1)
            elif _HOST_PORT_RE.match(clean_target) or "." in clean_target:
                resolved_endpoint = clean_target
            else:
                resolved_server_id = clean_target

            tasks = [
                self.query_prometheus(
                    template=tpl,
                    server_id=resolved_server_id,
                    endpoint=resolved_endpoint,
                    filepath=resolved_filepath,
                    window_minutes=window_minutes,
                )
                for tpl in SSL_TEMPLATES
            ]
            return list(await asyncio.gather(*tasks))

        raise ValueError(
            f"Unsupported metrics domain '{clean_domain}'. Expected 'vm', 'container', or 'ssl'."
        )

    async def get_server_context(
        self,
        *,
        server_id: str,
        labels: dict[str, str] | None = None,
    ) -> MCPToolCallResult:
        """Retrieve server metadata and monitoring health from management-backend."""
        clean_server = InputSanitizer.inspect_text(server_id, field_name="server_id")
        lbls = labels or {}

        if not self.management_api_base_url:
            platform = (
                lbls.get("platform")
                or lbls.get("os")
                or ("windows" if "win" in clean_server.lower() else "linux")
            )
            role = lbls.get("role") or "application-node"
            service = lbls.get("service") or "grafana-alloy"
            context_data = {
                "server_id": clean_server,
                "platform": platform,
                "os": platform,
                "managed_node_id": lbls.get("managed_node_id"),
                "monitoring_health": "Unknown",
                "last_observed_sample_at": None,
                "groups": [],
                "environment": lbls.get("environment") or "lab",
                "role": role,
                "active_service": service,
                "allowlisted_actions": [
                    "cleanup-temp-directory",
                    "rotate-noncritical-logs",
                    "collect-container-diagnostics",
                    "reprobe-ssl-target",
                ],
            }
            return MCPToolCallResult(
                tool_name="get_server_context",
                success=True,
                degraded=True,
                error=None,
                source="server_registry_unconfigured",
                data=context_data,
                formatted_context=(
                    f"Server `{clean_server}` offline context (MANAGEMENT_API_BASE_URL unconfigured): "
                    f"platform={platform}, service={service}, monitoring_health=Unknown."
                ),
            )

        url = f"{self.management_api_base_url}/api/v1/servers/{quote(clean_server, safe='')}"
        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self.management_api_timeout_seconds)
        try:
            resp = await client.get(url, headers=self._management_headers())
        except httpx.HTTPError as exc:
            return MCPToolCallResult(
                tool_name="get_server_context",
                success=False,
                degraded=True,
                error=f"Management API transport error: {exc}",
                source="management_api_error",
                data={"server_id": clean_server},
                formatted_context=f"Management API `get_server_context` failed for `{clean_server}`: {exc}",
            )
        finally:
            if owns_client:
                await client.aclose()

        if resp.status_code != 200:
            return MCPToolCallResult(
                tool_name="get_server_context",
                success=False,
                degraded=True,
                error=f"Management API HTTP {resp.status_code}: {resp.text[:200]}",
                source="management_api_error",
                data={"server_id": clean_server, "status_code": resp.status_code},
                formatted_context=(
                    f"Management API `get_server_context` returned HTTP {resp.status_code} "
                    f"for `{clean_server}`."
                ),
            )

        try:
            payload = resp.json()
        except ValueError as exc:
            return MCPToolCallResult(
                tool_name="get_server_context",
                success=False,
                degraded=True,
                error=f"Invalid JSON from Management API: {exc}",
                source="management_api_error",
                data={"server_id": clean_server},
                formatted_context=f"Management API returned invalid JSON for `{clean_server}`.",
            )

        if not isinstance(payload, dict):
            return MCPToolCallResult(
                tool_name="get_server_context",
                success=False,
                degraded=True,
                error="Unexpected non-object server payload from Management API.",
                source="management_api_error",
                data={"server_id": clean_server},
                formatted_context=f"Management API returned unexpected payload for `{clean_server}`.",
            )

        dashboard_ctx = payload.get("dashboardContext")
        if not isinstance(dashboard_ctx, dict):
            dashboard_ctx = {}
        onboarding = payload.get("onboarding")
        if not isinstance(onboarding, dict):
            onboarding = {}
        monitoring = onboarding.get("monitoring")
        if not isinstance(monitoring, dict):
            monitoring = {}
        metadata = payload.get("metadata")
        if not isinstance(metadata, dict):
            metadata = {}

        platform = str(
            payload.get("platform")
            or dashboard_ctx.get("platform")
            or payload.get("os")
            or lbls.get("platform")
            or lbls.get("os")
            or "linux"
        ).lower()
        managed_node_id = (
            payload.get("managed_node_id")
            or payload.get("managedNodeId")
            or dashboard_ctx.get("nodeId")
            or lbls.get("managed_node_id")
        )
        monitoring_health = (
            payload.get("monitoring_health")
            or payload.get("monitoringHealth")
            or monitoring.get("health")
            or "Unknown"
        )
        last_observed_sample_at = (
            payload.get("last_observed_sample_at")
            or payload.get("lastObservedSampleAt")
            or monitoring.get("lastObservedSampleAt")
        )
        raw_groups = payload.get("groups")
        if raw_groups is None:
            raw_groups = metadata.get("groups")
        groups = list(raw_groups) if isinstance(raw_groups, list) else []

        active_service = str(
            lbls.get("service")
            or metadata.get("service")
            or "grafana-alloy"
        )
        context_data = {
            "server_id": str(payload.get("id") or clean_server),
            "name": payload.get("name"),
            "platform": platform,
            "os": platform,
            "environment": payload.get("environment") or lbls.get("environment") or "unknown",
            "managed_node_id": managed_node_id,
            "monitoring_health": monitoring_health,
            "last_observed_sample_at": last_observed_sample_at,
            "groups": groups,
            "onboarding_state": onboarding.get("state"),
            "active_service": active_service,
            "metadata": metadata,
            "allowlisted_actions": [
                "cleanup-temp-directory",
                "rotate-noncritical-logs",
                "collect-container-diagnostics",
                "reprobe-ssl-target",
            ],
        }
        return MCPToolCallResult(
            tool_name="get_server_context",
            success=True,
            degraded=False,
            error=None,
            source="management_api_live",
            data=context_data,
            formatted_context=(
                f"Server `{context_data['server_id']}` live context: platform={platform}, "
                f"managed_node_id={managed_node_id or 'none'}, "
                f"monitoring_health={monitoring_health}, "
                f"last_observed_sample_at={last_observed_sample_at or 'none'}, "
                f"groups={groups}."
            ),
        )

    @staticmethod
    def _normalize_ssl_target(item: dict[str, Any]) -> dict[str, Any]:
        host = str(item.get("host") or "")
        port = int(item.get("port") or 443)
        return {
            "target_id": item.get("id"),
            "name": item.get("name"),
            "host": host,
            "port": port,
            "endpoint": f"{host}:{port}" if host else None,
            "group": item.get("group") or item.get("group_name") or "default",
            "enabled": item.get("enabled"),
            "subject_cn": item.get("subjectCn") if "subjectCn" in item else item.get("subject_cn"),
            "issuer_cn": item.get("issuerCn") if "issuerCn" in item else item.get("issuer_cn"),
            "serial_number": (
                item.get("serialNumber") if "serialNumber" in item else item.get("serial_number")
            ),
            "not_before": item.get("notBefore") if "notBefore" in item else item.get("not_before"),
            "not_after": item.get("notAfter") if "notAfter" in item else item.get("not_after"),
            "authorized": item.get("authorized"),
            "last_probed_at": (
                item.get("lastProbedAt") if "lastProbedAt" in item else item.get("last_probed_at")
            ),
            "last_error": item.get("lastError") if "lastError" in item else item.get("last_error"),
        }

    async def get_ssl_target_context(
        self,
        *,
        endpoint: str | None = None,
        target_name: str | None = None,
        server_id: str | None = None,
        filepath: str | None = None,
    ) -> MCPToolCallResult:
        """Retrieve SSL target metadata from `GET /api/v1/ssl-targets` and match by endpoint/host/name."""
        clean_endpoint = (
            InputSanitizer.inspect_text(endpoint, field_name="endpoint") if endpoint else None
        )
        clean_name = (
            InputSanitizer.inspect_text(target_name, field_name="target_name")
            if target_name
            else None
        )
        clean_server = (
            InputSanitizer.inspect_text(server_id, field_name="server_id") if server_id else None
        )
        clean_filepath = (
            InputSanitizer.inspect_text(filepath, field_name="filepath") if filepath else None
        )

        if not self.management_api_base_url:
            return MCPToolCallResult(
                tool_name="get_ssl_target_context",
                success=True,
                degraded=True,
                error=None,
                source="management_api_unconfigured",
                data={
                    "matched": False,
                    "endpoint": clean_endpoint,
                    "target_name": clean_name,
                    "server_id": clean_server,
                    "filepath": clean_filepath,
                },
                formatted_context=(
                    "SSL target context unavailable (MANAGEMENT_API_BASE_URL unconfigured; "
                    f"endpoint={clean_endpoint}, target_name={clean_name}, "
                    f"server_id={clean_server}, filepath={clean_filepath})."
                ),
            )

        url = f"{self.management_api_base_url}/api/v1/ssl-targets"
        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self.management_api_timeout_seconds)
        try:
            resp = await client.get(url, headers=self._management_headers())
        except httpx.HTTPError as exc:
            return MCPToolCallResult(
                tool_name="get_ssl_target_context",
                success=False,
                degraded=True,
                error=f"Management API transport error: {exc}",
                source="management_api_error",
                data={"endpoint": clean_endpoint, "target_name": clean_name},
                formatted_context=f"Management API `get_ssl_target_context` failed: {exc}",
            )
        finally:
            if owns_client:
                await client.aclose()

        if resp.status_code != 200:
            return MCPToolCallResult(
                tool_name="get_ssl_target_context",
                success=False,
                degraded=True,
                error=f"Management API HTTP {resp.status_code}: {resp.text[:200]}",
                source="management_api_error",
                data={"endpoint": clean_endpoint, "status_code": resp.status_code},
                formatted_context=(
                    f"Management API `get_ssl_target_context` returned HTTP {resp.status_code}."
                ),
            )

        try:
            payload = resp.json()
        except ValueError as exc:
            return MCPToolCallResult(
                tool_name="get_ssl_target_context",
                success=False,
                degraded=True,
                error=f"Invalid JSON from Management API: {exc}",
                source="management_api_error",
                data={"endpoint": clean_endpoint},
                formatted_context="Management API returned invalid JSON for SSL targets.",
            )

        raw_items: list[dict[str, Any]]
        if isinstance(payload, dict) and isinstance(payload.get("items"), list):
            raw_items = [item for item in payload["items"] if isinstance(item, dict)]
        elif isinstance(payload, list):
            raw_items = [item for item in payload if isinstance(item, dict)]
        else:
            raw_items = []

        matched_target: dict[str, Any] | None = None
        ep_lower = clean_endpoint.lower() if clean_endpoint else ""
        ep_host = ep_lower.rsplit(":", 1)[0] if ":" in ep_lower else ep_lower
        name_lower = clean_name.lower() if clean_name else ""

        for raw in raw_items:
            normalized = self._normalize_ssl_target(raw)
            item_ep = (normalized.get("endpoint") or "").lower()
            item_host = (normalized.get("host") or "").lower()
            item_name = str(normalized.get("name") or "").lower()
            item_cn = str(normalized.get("subject_cn") or "").lower()

            if ep_lower and (ep_lower == item_ep or ep_lower == item_host or ep_host == item_host):
                matched_target = normalized
                break
            if name_lower and name_lower == item_name:
                matched_target = normalized
                break
            if ep_host and ep_host == item_cn:
                matched_target = normalized
                break

        if matched_target is not None:
            data = {
                "matched": True,
                "source_type": "external",
                **matched_target,
            }
            return MCPToolCallResult(
                tool_name="get_ssl_target_context",
                success=True,
                degraded=False,
                error=None,
                source="management_api_live",
                data=data,
                formatted_context=(
                    f"SSL target `{data['name']}` ({data['endpoint']}, id={data['target_id']}): "
                    f"subject_cn={data['subject_cn']}, issuer_cn={data['issuer_cn']}, "
                    f"not_after={data['not_after']}, authorized={data['authorized']}, "
                    f"last_error={data['last_error'] or 'none'}."
                ),
            )

        source_type = "local" if (clean_server or clean_filepath) else "external"
        return MCPToolCallResult(
            tool_name="get_ssl_target_context",
            success=True,
            degraded=False,
            error=None,
            source="management_api_live",
            data={
                "matched": False,
                "source_type": source_type,
                "endpoint": clean_endpoint,
                "target_name": clean_name,
                "server_id": clean_server,
                "filepath": clean_filepath,
                "total_targets_checked": len(raw_items),
            },
            formatted_context=(
                f"No external SSL target matched endpoint={clean_endpoint} / target_name={clean_name} "
                f"(checked {len(raw_items)} targets; source_type={source_type})."
            ),
        )

    async def reprobe_ssl_target(self, *, target_id: str) -> MCPToolCallResult:
        """Trigger an immediate TLS re-probe via `POST /api/v1/ssl-targets/{target_id}/probe`."""
        clean_target_id = InputSanitizer.inspect_text(target_id, field_name="target_id")
        if not clean_target_id:
            raise ValueError("target_id must be a non-empty string.")

        if not self.management_api_base_url:
            return MCPToolCallResult(
                tool_name="reprobe_ssl_target",
                success=False,
                degraded=True,
                error="MANAGEMENT_API_BASE_URL is not configured.",
                source="management_api_unconfigured",
                data={"target_id": clean_target_id},
                formatted_context=(
                    f"Cannot reprobe SSL target `{clean_target_id}`: MANAGEMENT_API_BASE_URL is not configured."
                ),
            )

        url = (
            f"{self.management_api_base_url}/api/v1/ssl-targets/"
            f"{quote(clean_target_id, safe='')}/probe"
        )
        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self.management_api_timeout_seconds)
        try:
            resp = await client.post(url, headers=self._management_headers())
        except httpx.HTTPError as exc:
            return MCPToolCallResult(
                tool_name="reprobe_ssl_target",
                success=False,
                degraded=True,
                error=f"Management API transport error: {exc}",
                source="management_api_error",
                data={"target_id": clean_target_id},
                formatted_context=f"SSL reprobe failed for `{clean_target_id}`: {exc}",
            )
        finally:
            if owns_client:
                await client.aclose()

        if resp.status_code != 200:
            return MCPToolCallResult(
                tool_name="reprobe_ssl_target",
                success=False,
                degraded=True,
                error=f"Management API HTTP {resp.status_code}: {resp.text[:200]}",
                source="management_api_error",
                data={"target_id": clean_target_id, "status_code": resp.status_code},
                formatted_context=(
                    f"SSL reprobe for `{clean_target_id}` returned HTTP {resp.status_code}."
                ),
            )

        try:
            payload = resp.json()
        except ValueError as exc:
            return MCPToolCallResult(
                tool_name="reprobe_ssl_target",
                success=False,
                degraded=True,
                error=f"Invalid JSON from Management API: {exc}",
                source="management_api_error",
                data={"target_id": clean_target_id},
                formatted_context=f"SSL reprobe for `{clean_target_id}` returned invalid JSON.",
            )

        normalized = (
            self._normalize_ssl_target(payload)
            if isinstance(payload, dict)
            else {"target_id": clean_target_id}
        )
        return MCPToolCallResult(
            tool_name="reprobe_ssl_target",
            success=True,
            degraded=False,
            error=None,
            source="management_api_live",
            data=normalized,
            formatted_context=(
                f"Reprobed SSL target `{normalized.get('name') or clean_target_id}` "
                f"({normalized.get('endpoint') or clean_target_id}): "
                f"authorized={normalized.get('authorized')}, "
                f"not_after={normalized.get('not_after')}, "
                f"last_error={normalized.get('last_error') or 'none'}."
            ),
        )

    async def search_runbook(
        self,
        *,
        query: str,
        os_type: str | None = None,
        service: str | None = None,
        domain: str | None = None,
        top_k: int = 2,
    ) -> MCPToolCallResult:
        """Retrieve grounded runbook sections via `RunbookRAGPipeline`."""
        clean_query = InputSanitizer.inspect_text(query, field_name="query")
        retrieve_kwargs: dict[str, Any] = {
            "os_type": os_type,
            "service": service,
            "top_k": top_k,
        }
        sig = inspect.signature(self.rag_pipeline.retrieve)
        if "domain" in sig.parameters:
            retrieve_kwargs["domain"] = domain
        elif domain:
            clean_query = f"{clean_query} {domain}".strip()

        matches = self.rag_pipeline.retrieve(clean_query, **retrieve_kwargs)
        formatted = self.rag_pipeline.format_grounded_context(matches)
        return MCPToolCallResult(
            tool_name="search_runbook",
            success=True,
            degraded=False,
            error=None,
            source="runbook_rag_pipeline",
            data={
                "query": clean_query,
                "domain": domain,
                "matched_chunks": [m.model_dump() for m in matches],
            },
            formatted_context=formatted,
        )

    async def query_logs(
        self,
        *,
        server_id: str,
        service: str = "system",
        limit: int = 20,
        annotation_summary: str = "",
    ) -> MCPToolCallResult:
        """Return sanitized log context isolated inside `<untrusted_telemetry>` tags."""
        clean_server = InputSanitizer.inspect_text(server_id, field_name="server_id")
        clean_service = InputSanitizer.inspect_text(service, field_name="service")
        clean_summary = InputSanitizer.inspect_text(
            annotation_summary, field_name="annotation_summary"
        )
        bounded_limit = max(1, min(50, int(limit)))
        summary_lines = (
            clean_summary.splitlines()[:bounded_limit]
            if clean_summary
            else ["No additional raw log lines attached."]
        )
        isolated_log = InputSanitizer.wrap_untrusted_telemetry(
            "\n".join(f"[{clean_server}:{clean_service}] {line}" for line in summary_lines)
        )
        return MCPToolCallResult(
            tool_name="query_logs",
            success=True,
            degraded=False,
            error=None,
            source="sanitized_log_adapter",
            data={
                "server_id": clean_server,
                "service": clean_service,
                "limit": bounded_limit,
                "line_count": len(summary_lines),
            },
            formatted_context=isolated_log,
        )

    async def invoke_tool(self, tool_name: str, arguments: dict[str, Any]) -> MCPToolCallResult:
        """Dispatch an MCP tool call by name with strict argument validation."""
        if tool_name == "query_prometheus":
            return await self.query_prometheus(
                template=arguments.get("template"),
                metric=arguments.get("metric"),
                server_id=arguments.get("server_id"),
                container=arguments.get("container"),
                endpoint=arguments.get("endpoint"),
                filepath=arguments.get("filepath"),
                window_minutes=int(arguments.get("window_minutes") or 15),
            )
        if tool_name == "get_server_context":
            return await self.get_server_context(
                server_id=str(arguments.get("server_id") or "unknown-server"),
                labels=arguments.get("labels"),
            )
        if tool_name == "get_ssl_target_context":
            return await self.get_ssl_target_context(
                endpoint=arguments.get("endpoint"),
                target_name=arguments.get("target_name"),
                server_id=arguments.get("server_id"),
                filepath=arguments.get("filepath"),
            )
        if tool_name == "reprobe_ssl_target":
            return await self.reprobe_ssl_target(
                target_id=str(arguments.get("target_id") or ""),
            )
        if tool_name == "search_runbook":
            return await self.search_runbook(
                query=str(arguments.get("query") or ""),
                os_type=arguments.get("os_type"),
                service=arguments.get("service"),
                domain=arguments.get("domain"),
                top_k=int(arguments.get("top_k") or 2),
            )
        if tool_name == "query_logs":
            return await self.query_logs(
                server_id=str(arguments.get("server_id") or "unknown-server"),
                service=str(arguments.get("service") or "system"),
                limit=int(arguments.get("limit") or 20),
                annotation_summary=str(arguments.get("annotation_summary") or ""),
            )
        raise ValueError(f"Unknown or unapproved MCP tool: '{tool_name}'.")
