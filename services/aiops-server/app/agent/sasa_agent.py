"""Step 1–8 Orchestrator: SaSa AI Agent Pipeline (Phase 1 + Phase 2 + P0/P1 Production Hardening).

Coordinates the traceable execution pipeline:
Incoming Webhook -> Input Validation -> Guardrails -> Per-Alert Batch Processing
  -> Fingerprint Dedup (preserving cached PolicyDecision) & Cache Lookup
  -> Jev Decision Model -> Deterministic Policy Gate
  -> Domain-Aware MCP Read-Only Tools (AMP / Management API / SSL Context) & Multi-Stage RAG Retrieval
  -> Safe Allowlisted Execution (e.g., `reprobe-ssl-target`)
  -> ProviderRouter LLM Inference (DeepSeek <-> Gemini with model-tier routing) -> Output Validation
  -> Telegram HITL Approval / Notification -> Traceable WebhookProcessingResult
"""

from __future__ import annotations

import inspect
import json
import time
import uuid
from typing import Any

from app.agent.prompts import build_rca_user_prompt, build_system_prompt
from app.approvals.telegram import TelegramHITLService
from app.config import AIOpsSettings
from app.decision.jev_client import JevDecisionClient
from app.decision.policy_gate import DeterministicPolicyGate
from app.guardrails.dedup import AlertDeduplicator, ResponseCache
from app.guardrails.sanitizer import InputSanitizer
from app.providers.base import BaseLLMProvider, InferenceRequest, InferenceResponse, ProviderError
from app.providers.deepseek import DeepSeekProvider
from app.providers.gemini import GeminiProvider
from app.rag.runbook_rag import RunbookRAGPipeline
from app.schemas.alert import AlertItem, AlertStatus, AlertWebhookPayload
from app.schemas.decision import (
    ExecutionStrategy,
    JevDecisionRequest,
    PolicyDecision,
    SeverityTier,
)
from app.schemas.rca import (
    PipelineTraceMetadata,
    RCAReport,
    WebhookProcessingResult,
)
from app.tools.mcp_tools import MCPToolCallResult, MCPToolRegistry


class SaSaAgent:
    """Primary AIOps Agent orchestrating Jev, RAG, MCP Tools, LLM RCA, and Telegram HITL."""

    def __init__(
        self,
        settings: AIOpsSettings | None = None,
        *,
        llm_provider: BaseLLMProvider | None = None,
        jev_client: JevDecisionClient | None = None,
        policy_gate: DeterministicPolicyGate | None = None,
        deduplicator: AlertDeduplicator | None = None,
        response_cache: ResponseCache[RCAReport] | None = None,
        rag_pipeline: RunbookRAGPipeline | None = None,
        mcp_tools: MCPToolRegistry | None = None,
        telegram_service: TelegramHITLService | None = None,
    ) -> None:
        self.settings = settings or AIOpsSettings.from_env()
        self.llm_provider = llm_provider or self._create_default_provider()
        self.jev_client = jev_client or JevDecisionClient(self.settings)
        self.policy_gate = policy_gate or DeterministicPolicyGate()
        self.deduplicator = deduplicator or AlertDeduplicator(
            cooldown_seconds=self.settings.AIOPS_DEDUP_COOLDOWN_SECONDS,
            max_entries=self.settings.AIOPS_MAX_CACHE_ENTRIES,
        )
        self.response_cache = response_cache or ResponseCache[RCAReport](
            ttl_seconds=self.settings.AIOPS_CACHE_TTL_SECONDS,
            max_entries=self.settings.AIOPS_MAX_CACHE_ENTRIES,
        )
        self.rag_pipeline = rag_pipeline or RunbookRAGPipeline()
        self.mcp_tools = mcp_tools or self._create_default_mcp_tools()
        self.telegram_service = telegram_service or TelegramHITLService(self.settings)
        self._last_policy_by_fingerprint: dict[str, PolicyDecision] = {}

    def _create_default_provider(self) -> BaseLLMProvider:
        try:
            from app.providers.router import ProviderRouter

            return ProviderRouter(self.settings)
        except ImportError:
            if self.settings.AIOPS_DEFAULT_PROVIDER == "gemini":
                return GeminiProvider(self.settings)
            return DeepSeekProvider(self.settings)

    def _create_default_mcp_tools(self) -> MCPToolRegistry:
        init_params = inspect.signature(MCPToolRegistry.__init__).parameters
        if "settings" in init_params:
            return MCPToolRegistry(settings=self.settings, rag_pipeline=self.rag_pipeline)  # type: ignore[call-arg]
        return MCPToolRegistry(rag_pipeline=self.rag_pipeline)

    async def _invoke_llm(
        self,
        request: InferenceRequest,
        *,
        model_tier: str | None = None,
    ) -> InferenceResponse:
        gen_params = inspect.signature(self.llm_provider.generate).parameters
        if model_tier and "model_tier" in gen_params:
            return await self.llm_provider.generate(request, model_tier=model_tier)  # type: ignore[call-arg]
        return await self.llm_provider.generate(request)

    def _remember_policy(self, fingerprint: str, policy: PolicyDecision) -> None:
        max_entries = max(1, self.settings.AIOPS_MAX_CACHE_ENTRIES)
        if len(self._last_policy_by_fingerprint) >= max_entries and fingerprint not in self._last_policy_by_fingerprint:
            oldest_key = next(iter(self._last_policy_by_fingerprint))
            self._last_policy_by_fingerprint.pop(oldest_key, None)
        self._last_policy_by_fingerprint[fingerprint] = policy

    @staticmethod
    def _extract_ssl_target_id(alert: AlertItem, ssl_ctx_res: MCPToolCallResult | None) -> str | None:
        """Resolve management-backend SSL target UUID/ID from MCP context or alert labels."""
        if ssl_ctx_res is not None and isinstance(ssl_ctx_res.data, dict):
            data = ssl_ctx_res.data
            for direct_key in ("target_id", "id"):
                val = data.get(direct_key)
                if isinstance(val, str) and val.strip():
                    return val.strip()
            for nested_key in ("target", "matched_target", "ssl_target"):
                nested = data.get(nested_key)
                if isinstance(nested, dict):
                    val = nested.get("id") or nested.get("target_id")
                    if isinstance(val, str) and val.strip():
                        return val.strip()
            for list_key in ("matches", "targets"):
                items = data.get(list_key)
                if isinstance(items, list) and items and isinstance(items[0], dict):
                    val = items[0].get("id") or items[0].get("target_id")
                    if isinstance(val, str) and val.strip():
                        return val.strip()
        label_id = (alert.labels.get("ssl_target_id") or "").strip()
        return label_id or None

    @staticmethod
    def _extract_json_object(raw_text: str) -> dict[str, object]:
        """Extract JSON object from raw LLM text (handles optional `<think>` or markdown fences)."""
        cleaned = raw_text.strip()
        if "</think>" in cleaned:
            cleaned = cleaned.split("</think>", maxsplit=1)[1].strip()
        if cleaned.startswith("```"):
            lines = [line for line in cleaned.splitlines() if not line.strip().startswith("```")]
            cleaned = "\n".join(lines).strip()
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start != -1 and end != -1 and end > start:
            cleaned = cleaned[start : end + 1]
        parsed = json.loads(cleaned)
        if not isinstance(parsed, dict):
            raise ValueError("Expected top-level JSON object.")
        return parsed

    def _build_fallback_rca(
        self,
        alert: AlertItem,
        policy: PolicyDecision,
        *,
        fallback_note: str | None = None,
        executed_tools: list[str] | None = None,
    ) -> RCAReport:
        """Construct a deterministic structured RCA report if LLM inference is offline or skipped."""
        evidence = [
            f"domain={alert.domain}",
            f"target_id={alert.target_id}",
            f"server_id={alert.server_id}",
            f"alertname={alert.alert_name}",
            f"declared_severity={alert.declared_severity}",
        ]
        if fallback_note:
            evidence.append(f"note={fallback_note}")

        return RCAReport(
            agent_name=self.settings.AIOPS_AGENT_NAME,
            provider_name=self.llm_provider.provider_name,
            model_name=self.llm_provider.model_name,
            summary=(
                f"[{policy.severity.value.upper()}] Incident '{alert.alert_name}' detected on "
                f"target '{alert.target_id}'."
            ),
            evidence=evidence,
            possible_causes=[
                alert.annotations.get("description")
                or alert.annotations.get("summary")
                or f"Threshold breach on {alert.alert_name}"
            ],
            recommended_action_id=(
                policy.approved_action_id
                if policy.allow_automated_execution
                else policy.jev_decision.candidate_action_id
            ),
            risk_level=policy.severity,
            confidence=policy.jev_decision.confidence,
            requires_approval=policy.requires_human_approval,
            understanding=(
                f"{self.settings.AIOPS_AGENT_NAME} identified a {policy.severity.value}-severity "
                f"{alert.domain} event ('{alert.alert_name}') on '{alert.target_id}'."
            ),
            proposed_resolution=(
                "Verify live telemetry in Amazon Managed Prometheus / Grafana and execute the allowlisted "
                "runbook step only after verifying preconditions."
            ),
            expected_impact=(
                "Minimal impact if read-only diagnostics run first; service or container restart actions "
                "may cause brief connection draining."
            ),
            intended_tools=executed_tools or ["query_domain_metrics", "get_server_context", "search_runbook"],
        )

    @staticmethod
    def _format_notification(
        alert: AlertItem,
        policy: PolicyDecision,
        rca: RCAReport | None,
    ) -> str:
        """Format the operator/Telegram announcement according to severity tier."""
        target = alert.target_id
        if policy.strategy == ExecutionStrategy.NO_ACTION_RESOLVED:
            return f"[RESOLVED] Alert '{alert.alert_name}' on '{target}' has cleared."

        if policy.severity == SeverityTier.CRITICAL:
            summary = rca.summary if rca else "Read-only RCA pending."
            return (
                f"🚨 [CRITICAL ESCALATION - NO AUTO EXECUTION] Target={target} "
                f"Alert={alert.alert_name} | {summary}"
            )

        if policy.strategy == ExecutionStrategy.REQUEST_HITL_APPROVAL:
            action = (rca.recommended_action_id if rca else None) or "manual-review"
            return (
                f"⚠️ [HITL APPROVAL REQUIRED] Target={target} Alert={alert.alert_name} "
                f"ProposedAction={action} | Please Approve or Reject."
            )

        return (
            f"✅ [LOW - AUTO ALLOWLISTED] Target={target} Alert={alert.alert_name} "
            f"Action={policy.approved_action_id}"
        )

    async def _run_stage6_diagnostics(
        self,
        alert: AlertItem,
        policy: PolicyDecision,
    ) -> tuple[list[str], list[str], str, list[Any], dict[str, Any] | None]:
        """Execute domain-aware MCP diagnostics, RAG runbook lookup, and safe allowlisted actions."""
        mcp_tool_summaries: list[str] = []
        executed_tools: list[str] = []

        # 1. Domain metrics bundle (AMP SigV4 / parameterized PromQL)
        if hasattr(self.mcp_tools, "query_domain_metrics"):
            metric_results = await self.mcp_tools.query_domain_metrics(
                domain=alert.domain,
                target_id=alert.target_id,
                platform=alert.platform,
                container=alert.labels.get("container"),
                filepath=alert.labels.get("filepath"),
                window_minutes=15,
            )
            if isinstance(metric_results, list):
                for item in metric_results:
                    if item.formatted_context:
                        mcp_tool_summaries.append(item.formatted_context)
            elif metric_results is not None and metric_results.formatted_context:
                mcp_tool_summaries.append(metric_results.formatted_context)
            executed_tools.append("query_domain_metrics")
        else:
            alert_lower = alert.alert_name.lower()
            target_metric = (
                "mem_used_percent"
                if "mem" in alert_lower
                else "disk_used_percent"
                if "disk" in alert_lower or "tmp" in alert_lower
                else "cpu_usage_active"
                if "cpu" in alert_lower
                else "up"
            )
            prom_res = await self.mcp_tools.query_prometheus(
                metric=target_metric,
                server_id=alert.server_id,
                window_minutes=15,
            )
            if prom_res.formatted_context:
                mcp_tool_summaries.append(prom_res.formatted_context)
            executed_tools.append("query_prometheus")

        # 2. Target context (SSL target context and/or server context)
        ssl_ctx_res: MCPToolCallResult | None = None
        if alert.domain == "ssl" and hasattr(self.mcp_tools, "get_ssl_target_context"):
            ssl_ctx_res = await self.mcp_tools.get_ssl_target_context(
                endpoint=alert.labels.get("endpoint"),
                target_name=alert.labels.get("target_name") or alert.labels.get("subject_CN"),
                server_id=None if alert.is_external_ssl else alert.server_id,
                filepath=alert.labels.get("filepath"),
            )
            if ssl_ctx_res.formatted_context:
                mcp_tool_summaries.append(ssl_ctx_res.formatted_context)
            executed_tools.append("get_ssl_target_context")
            if not alert.is_external_ssl and alert.server_id != "unknown-server":
                ctx_res = await self.mcp_tools.get_server_context(
                    server_id=alert.server_id,
                    labels=alert.labels,
                )
                if ctx_res.formatted_context:
                    mcp_tool_summaries.append(ctx_res.formatted_context)
                executed_tools.append("get_server_context")
        else:
            ctx_res = await self.mcp_tools.get_server_context(
                server_id=alert.server_id,
                labels=alert.labels,
            )
            if ctx_res.formatted_context:
                mcp_tool_summaries.append(ctx_res.formatted_context)
            executed_tools.append("get_server_context")

        # 3. Multi-stage RAG runbook search
        rag_query = " ".join(
            filter(
                None,
                [
                    alert.alert_name,
                    alert.domain,
                    alert.labels.get("container", ""),
                    alert.labels.get("endpoint", ""),
                    alert.annotations.get("summary", ""),
                    alert.annotations.get("description", ""),
                ],
            )
        )
        rag_kwargs: dict[str, Any] = {
            "query": rag_query,
            "os_type": alert.labels.get("os") or alert.platform,
            "service": alert.labels.get("service") or alert.labels.get("container"),
            "top_k": 2,
        }
        if "domain" in inspect.signature(self.mcp_tools.search_runbook).parameters:
            rag_kwargs["domain"] = alert.domain
        rag_res = await self.mcp_tools.search_runbook(**rag_kwargs)
        executed_tools.append("search_runbook")
        matched_chunks = rag_res.data.get("matched_chunks") or []

        # 4. Safe allowlisted automated action execution (`reprobe-ssl-target`)
        executed_action_result: dict[str, Any] | None = None
        if (
            policy.allow_automated_execution
            and policy.approved_action_id == "reprobe-ssl-target"
            and hasattr(self.mcp_tools, "reprobe_ssl_target")
        ):
            resolved_ssl_target_id = self._extract_ssl_target_id(alert, ssl_ctx_res)
            if resolved_ssl_target_id:
                reprobe_res = await self.mcp_tools.reprobe_ssl_target(target_id=resolved_ssl_target_id)
                executed_tools.append("reprobe_ssl_target")
                if reprobe_res.formatted_context:
                    mcp_tool_summaries.append(reprobe_res.formatted_context)
                executed_action_result = {
                    "action_id": "reprobe-ssl-target",
                    "target_id": resolved_ssl_target_id,
                    **reprobe_res.model_dump(),
                }

        return (
            mcp_tool_summaries,
            executed_tools,
            rag_res.formatted_context,
            matched_chunks,
            executed_action_result,
        )

    async def _process_single_alert(
        self,
        alert: AlertItem,
        *,
        payload: AlertWebhookPayload,
        correlation_id: str,
    ) -> WebhookProcessingResult:
        """Run the full traceable pipeline for a single alert inside a webhook batch."""
        started = time.perf_counter()
        fingerprint = alert.compute_fingerprint()

        # Handle resolved alerts immediately and clear deduplication cooldown & cached policy
        if payload.status == AlertStatus.RESOLVED or alert.status == AlertStatus.RESOLVED:
            self.deduplicator.clear(fingerprint)
            self._last_policy_by_fingerprint.pop(fingerprint, None)
            jev_req = JevDecisionRequest(
                fingerprint=fingerprint,
                server_id=alert.server_id,
                alert_name=alert.alert_name,
                declared_severity=alert.declared_severity,
                status=AlertStatus.RESOLVED.value,
                domain=alert.domain,
                target_id=alert.target_id,
                labels=alert.labels,
                annotations=alert.annotations,
            )
            jev_resp = self.jev_client.evaluate_heuristic(jev_req)
            policy = self.policy_gate.enforce(jev_resp, alert_status=AlertStatus.RESOLVED)
            latency_ms = round((time.perf_counter() - started) * 1000.0, 2)
            trace = PipelineTraceMetadata(
                correlation_id=correlation_id,
                fingerprint=fingerprint,
                jev_backend=jev_resp.backend_mode,
                latency_ms=latency_ms,
            )
            return WebhookProcessingResult(
                incident_fingerprint=fingerprint,
                server_id=alert.server_id,
                alert_name=alert.alert_name,
                strategy=policy.strategy,
                policy_decision=policy,
                notification_message=self._format_notification(alert, policy, None),
                trace=trace,
            )

        # Stage 3: Alert Storm Fingerprint Deduplication (Tier 0 Cost Shield)
        if self.deduplicator.is_duplicate(fingerprint):
            cached_rca = self.response_cache.get(fingerprint)
            cached_policy = self._last_policy_by_fingerprint.get(fingerprint)
            resolved_strategy = (
                cached_policy.strategy
                if cached_policy is not None
                else ExecutionStrategy.REQUEST_HITL_APPROVAL
            )
            latency_ms = round((time.perf_counter() - started) * 1000.0, 2)
            trace = PipelineTraceMetadata(
                correlation_id=correlation_id,
                fingerprint=fingerprint,
                deduplicated=True,
                cache_hit=cached_rca is not None,
                jev_backend=(
                    cached_policy.jev_decision.backend_mode
                    if cached_policy is not None
                    else "heuristic"
                ),
                llm_provider=cached_rca.provider_name if cached_rca is not None else "none",
                llm_model=cached_rca.model_name if cached_rca is not None else "none",
                latency_ms=latency_ms,
            )
            return WebhookProcessingResult(
                incident_fingerprint=fingerprint,
                server_id=alert.server_id,
                alert_name=alert.alert_name,
                strategy=resolved_strategy,
                deduplicated=True,
                cache_hit=cached_rca is not None,
                policy_decision=cached_policy,
                rca_report=cached_rca,
                notification_message=(
                    f"[SUPPRESSED DUPLICATE] Alert '{alert.alert_name}' on "
                    f"'{alert.target_id}' is within active cooldown window."
                ),
                trace=trace,
            )

        # Stage 4: Jev Decision Model + Deterministic Policy Gate
        jev_request = JevDecisionRequest(
            fingerprint=fingerprint,
            server_id=alert.server_id,
            alert_name=alert.alert_name,
            declared_severity=alert.declared_severity,
            status=alert.status.value,
            domain=alert.domain,
            target_id=alert.target_id,
            summary=alert.annotations.get("summary") or payload.message or payload.title,
            labels=alert.labels,
            annotations=alert.annotations,
        )
        jev_response = await self.jev_client.evaluate(jev_request)
        policy = self.policy_gate.enforce(jev_response, alert_status=alert.status)
        self._remember_policy(fingerprint, policy)

        # Stage 5: Cache Lookup (Tier 1 Cost Shield)
        cached = self.response_cache.get(fingerprint)
        if cached is not None:
            self.deduplicator.record(fingerprint)
            tg_receipt = await self.telegram_service.notify_and_request_approval(
                alert, policy, cached, fingerprint=fingerprint
            )
            latency_ms = round((time.perf_counter() - started) * 1000.0, 2)
            trace = PipelineTraceMetadata(
                correlation_id=correlation_id,
                fingerprint=fingerprint,
                cache_hit=True,
                jev_backend=jev_response.backend_mode,
                llm_provider=cached.provider_name,
                llm_model=cached.model_name,
                latency_ms=latency_ms,
            )
            return WebhookProcessingResult(
                incident_fingerprint=fingerprint,
                server_id=alert.server_id,
                alert_name=alert.alert_name,
                strategy=policy.strategy,
                cache_hit=True,
                policy_decision=policy,
                rca_report=cached,
                notification_message=self._format_notification(alert, policy, cached),
                telegram_receipt=tg_receipt.model_dump(),
                trace=trace,
            )

        # Stage 6: Execute Domain-Aware Read-Only MCP Tools, RAG Runbooks, & Allowlisted SSL Reprobe
        (
            mcp_tool_summaries,
            executed_tools,
            grounded_runbook_context,
            matched_chunks,
            executed_action_result,
        ) = await self._run_stage6_diagnostics(alert, policy)

        # Stage 7: LLM Inference (with model_tier routing) + Output Schema Validation
        prompt_tokens = 0
        completion_tokens = 0
        system_prompt = build_system_prompt(self.settings.AIOPS_AGENT_NAME)
        user_prompt = build_rca_user_prompt(
            alert,
            policy,
            grounded_runbook_context=grounded_runbook_context,
            mcp_tool_summaries=mcp_tool_summaries,
        )

        try:
            inference_resp = await self._invoke_llm(
                InferenceRequest(
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    temperature=0.1,
                    response_json=True,
                ),
                model_tier=policy.routing_model_tier,
            )
            prompt_tokens = inference_resp.prompt_tokens
            completion_tokens = inference_resp.completion_tokens
            parsed_json = self._extract_json_object(inference_resp.content)
            rca_report = RCAReport(
                agent_name=self.settings.AIOPS_AGENT_NAME,
                provider_name=inference_resp.provider_name,
                model_name=inference_resp.model_name,
                summary=str(parsed_json.get("summary") or f"RCA for {alert.alert_name}"),
                evidence=[str(x) for x in (parsed_json.get("evidence") or [])],  # type: ignore[union-attr]
                possible_causes=[str(x) for x in (parsed_json.get("possible_causes") or [])],  # type: ignore[union-attr]
                recommended_action_id=(
                    str(parsed_json["recommended_action_id"])
                    if parsed_json.get("recommended_action_id")
                    else policy.approved_action_id
                ),
                risk_level=policy.severity,
                confidence=float(parsed_json.get("confidence", policy.jev_decision.confidence)),  # type: ignore[arg-type]
                requires_approval=policy.requires_human_approval,
                understanding=str(parsed_json.get("understanding") or ""),
                proposed_resolution=str(parsed_json.get("proposed_resolution") or ""),
                expected_impact=str(parsed_json.get("expected_impact") or ""),
                intended_tools=[
                    str(x)
                    for x in (
                        parsed_json.get("intended_tools")  # type: ignore[union-attr]
                        or executed_tools
                    )
                ],
            )
        except (ProviderError, ValueError, KeyError, TypeError):
            rca_report = self._build_fallback_rca(
                alert,
                policy,
                fallback_note="Generated via deterministic fallback while LLM provider was unavailable.",
                executed_tools=executed_tools,
            )

        self.deduplicator.record(fingerprint)
        self.response_cache.set(fingerprint, rca_report)

        # Stage 8: Telegram Notification & HITL Approval Dispatch
        tg_receipt = await self.telegram_service.notify_and_request_approval(
            alert,
            policy,
            rca_report,
            fingerprint=fingerprint,
        )

        latency_ms = round((time.perf_counter() - started) * 1000.0, 2)
        trace = PipelineTraceMetadata(
            correlation_id=correlation_id,
            fingerprint=fingerprint,
            jev_backend=jev_response.backend_mode,
            rag_chunks_retrieved=len(matched_chunks),
            mcp_tools_executed=executed_tools,
            llm_provider=rca_report.provider_name,
            llm_model=rca_report.model_name,
            latency_ms=latency_ms,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
        )
        return WebhookProcessingResult(
            incident_fingerprint=fingerprint,
            server_id=alert.server_id,
            alert_name=alert.alert_name,
            strategy=policy.strategy,
            policy_decision=policy,
            rca_report=rca_report,
            notification_message=self._format_notification(alert, policy, rca_report),
            telegram_receipt=tg_receipt.model_dump(),
            executed_action_result=executed_action_result,
            trace=trace,
        )

    async def process_webhook(
        self,
        payload: AlertWebhookPayload,
        *,
        correlation_id: str | None = None,
    ) -> WebhookProcessingResult:
        """Execute the full Step 8 traceable pipeline for every alert in an incoming webhook batch."""
        corr_id = correlation_id or f"req-{uuid.uuid4().hex[:12]}"

        # Stage 1 & 2: Input validation & Prompt-Injection Guardrails across the entire batch
        InputSanitizer.validate_webhook_payload(payload)

        results: list[WebhookProcessingResult] = []
        total = len(payload.alerts)
        for idx, alert in enumerate(payload.alerts):
            alert_corr_id = corr_id if total == 1 else f"{corr_id}-{idx + 1}"
            result = await self._process_single_alert(
                alert,
                payload=payload,
                correlation_id=alert_corr_id,
            )
            results.append(result)

        primary_result = results[0]
        return primary_result.model_copy(
            update={
                "alerts_processed": total,
                "batch_results": results,
            }
        )
