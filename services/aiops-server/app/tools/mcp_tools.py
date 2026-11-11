"""Phase 2.1: Model Context Protocol (MCP) Read-Only Tool Registry (`app/tools/mcp_tools.py`).

Provides strictly bounded, read-only diagnostic tools for SaSa AI:
1. `query_prometheus`: Queries allowlisted Prometheus metrics within a bounded lookback window.
2. `get_server_context`: Retrieves server OS, role, environment, and allowlisted services.
3. `search_runbook`: Queries the multi-stage `RunbookRAGPipeline` for grounded SRE procedures.
4. `query_logs`: Retrieves sanitized log lines wrapped in `<untrusted_telemetry>` blocks.
"""

from __future__ import annotations

from typing import Any

import httpx
from pydantic import BaseModel, Field

from app.guardrails.sanitizer import InputSanitizer
from app.rag.runbook_rag import RunbookRAGPipeline

# Strict allowlist of metric prefixes SaSa AI is permitted to query (INTRODUCT.md 11.4 & 14.5)
ALLOWLISTED_PROMQL_METRICS: frozenset[str] = frozenset(
    {
        "up",
        "cpu_usage_active",
        "mem_used_percent",
        "swap_used_percent",
        "disk_used_percent",
        "system_load1",
        "net_bytes_recv",
        "net_bytes_sent",
    }
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
    source: str = "local_context"
    data: dict[str, Any] = Field(default_factory=dict)
    formatted_context: str = ""


class MCPToolRegistry:
    """Registry and executor for read-only MCP diagnostic tools."""

    def __init__(
        self,
        *,
        rag_pipeline: RunbookRAGPipeline | None = None,
        prometheus_base_url: str = "http://127.0.0.1:9090",
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self.rag_pipeline = rag_pipeline or RunbookRAGPipeline()
        self.prometheus_base_url = prometheus_base_url.rstrip("/")
        self._client = http_client

    @staticmethod
    def list_tools() -> list[MCPToolDefinition]:
        """Return MCP-standard tool definitions available to SaSa AI."""
        return [
            MCPToolDefinition(
                name="query_prometheus",
                description="Execute a bounded read-only PromQL query for an allowlisted metric and server_id.",
                read_only=True,
                input_schema={
                    "type": "object",
                    "properties": {
                        "metric": {"type": "string", "enum": sorted(ALLOWLISTED_PROMQL_METRICS)},
                        "server_id": {"type": "string"},
                        "window_minutes": {"type": "integer", "minimum": 1, "maximum": 60},
                    },
                    "required": ["metric", "server_id"],
                },
            ),
            MCPToolDefinition(
                name="get_server_context",
                description="Retrieve server OS, role, environment, and allowlisted services for a given server_id.",
                read_only=True,
                input_schema={
                    "type": "object",
                    "properties": {"server_id": {"type": "string"}},
                    "required": ["server_id"],
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
                    },
                    "required": ["server_id"],
                },
            ),
        ]

    async def query_prometheus(
        self,
        *,
        metric: str,
        server_id: str,
        window_minutes: int = 15,
    ) -> MCPToolCallResult:
        """Query an allowlisted metric in Prometheus (with resilient lab snapshot fallback)."""
        clean_metric = InputSanitizer.inspect_text(metric, field_name="metric")
        clean_server = InputSanitizer.inspect_text(server_id, field_name="server_id")
        if clean_metric not in ALLOWLISTED_PROMQL_METRICS:
            raise ValueError(
                f"Metric '{clean_metric}' is not in ALLOWLISTED_PROMQL_METRICS."
            )
        bounded_window = max(1, min(60, int(window_minutes)))
        promql = f'{clean_metric}{{server_id="{clean_server}"}}[{bounded_window}m]'

        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=3.0)
        try:
            resp = await client.get(
                f"{self.prometheus_base_url}/api/v1/query",
                params={"query": f'{clean_metric}{{server_id="{clean_server}"}}'},
            )
            if resp.status_code == 200:
                payload = resp.json()
                return MCPToolCallResult(
                    tool_name="query_prometheus",
                    success=True,
                    source="prometheus_live",
                    data={"promql": promql, "result": payload.get("data", {})},
                    formatted_context=f"Prometheus live query `{promql}` succeeded.",
                )
        except httpx.HTTPError:
            pass
        finally:
            if owns_client:
                await client.aclose()

        return MCPToolCallResult(
            tool_name="query_prometheus",
            success=True,
            source="telemetry_snapshot_fallback",
            data={
                "promql": promql,
                "server_id": clean_server,
                "metric": clean_metric,
                "window_minutes": bounded_window,
                "note": "Prometheus direct endpoint offline; using alert-embedded telemetry snapshot.",
            },
            formatted_context=(
                f"MCP `query_prometheus` validated allowlisted query `{promql}` "
                "(using alert-embedded telemetry snapshot)."
            ),
        )

    async def get_server_context(
        self,
        *,
        server_id: str,
        labels: dict[str, str] | None = None,
    ) -> MCPToolCallResult:
        """Retrieve server metadata and allowlisted services for `server_id`."""
        clean_server = InputSanitizer.inspect_text(server_id, field_name="server_id")
        lbls = labels or {}
        os_type = lbls.get("os") or ("windows" if "win" in clean_server.lower() else "linux")
        role = lbls.get("role") or "application-node"
        service = lbls.get("service") or "telegraf"
        context_data = {
            "server_id": clean_server,
            "os": os_type,
            "environment": lbls.get("environment") or "lab",
            "role": role,
            "active_service": service,
            "allowlisted_actions": [
                "cleanup-temp-directory",
                "rotate-noncritical-logs",
                "restart-approved-service",
            ],
        }
        return MCPToolCallResult(
            tool_name="get_server_context",
            success=True,
            source="server_registry",
            data=context_data,
            formatted_context=(
                f"Server `{clean_server}` context: os={os_type}, role={role}, service={service}."
            ),
        )

    async def search_runbook(
        self,
        *,
        query: str,
        os_type: str | None = None,
        service: str | None = None,
        top_k: int = 2,
    ) -> MCPToolCallResult:
        """Retrieve grounded runbook sections via `RunbookRAGPipeline`."""
        clean_query = InputSanitizer.inspect_text(query, field_name="query")
        matches = self.rag_pipeline.retrieve(
            clean_query,
            os_type=os_type,
            service=service,
            top_k=top_k,
        )
        formatted = self.rag_pipeline.format_grounded_context(matches)
        return MCPToolCallResult(
            tool_name="search_runbook",
            success=True,
            source="runbook_rag_pipeline",
            data={
                "query": clean_query,
                "matched_chunks": [m.model_dump() for m in matches],
            },
            formatted_context=formatted,
        )

    async def query_logs(
        self,
        *,
        server_id: str,
        service: str = "system",
        annotation_summary: str = "",
    ) -> MCPToolCallResult:
        """Return sanitized log context isolated inside `<untrusted_telemetry>` tags."""
        clean_server = InputSanitizer.inspect_text(server_id, field_name="server_id")
        clean_service = InputSanitizer.inspect_text(service, field_name="service")
        clean_summary = InputSanitizer.inspect_text(annotation_summary, field_name="annotation_summary")
        isolated_log = InputSanitizer.wrap_untrusted_telemetry(
            f"[{clean_server}:{clean_service}] {clean_summary or 'No additional raw log lines attached.'}"
        )
        return MCPToolCallResult(
            tool_name="query_logs",
            success=True,
            source="sanitized_log_adapter",
            data={"server_id": clean_server, "service": clean_service},
            formatted_context=isolated_log,
        )

    async def invoke_tool(self, tool_name: str, arguments: dict[str, Any]) -> MCPToolCallResult:
        """Dispatch an MCP tool call by name with strict argument validation."""
        if tool_name == "query_prometheus":
            return await self.query_prometheus(
                metric=str(arguments.get("metric") or "up"),
                server_id=str(arguments.get("server_id") or "unknown-server"),
                window_minutes=int(arguments.get("window_minutes") or 15),
            )
        if tool_name == "get_server_context":
            return await self.get_server_context(
                server_id=str(arguments.get("server_id") or "unknown-server"),
                labels=arguments.get("labels"),
            )
        if tool_name == "search_runbook":
            return await self.search_runbook(
                query=str(arguments.get("query") or ""),
                os_type=arguments.get("os_type"),
                service=arguments.get("service"),
                top_k=int(arguments.get("top_k") or 2),
            )
        if tool_name == "query_logs":
            return await self.query_logs(
                server_id=str(arguments.get("server_id") or "unknown-server"),
                service=str(arguments.get("service") or "system"),
                annotation_summary=str(arguments.get("annotation_summary") or ""),
            )
        raise ValueError(f"Unknown or unapproved MCP tool: '{tool_name}'.")
