"""Step 1–8 Orchestrator: SaSa AI Agent Pipeline.

Coordinates the traceable execution pipeline:
Incoming Webhook -> Input Validation -> Guardrails -> Fingerprint Dedup & Cache Lookup
  -> Jev Decision Model -> Deterministic Policy Gate -> LLM Inference (DeepSeek/Ollama/Gemini)
  -> Output Validation -> Traceable WebhookProcessingResult
"""

from __future__ import annotations

import json
import time
import uuid

from app.agent.prompts import build_rca_user_prompt, build_system_prompt
from app.config import AIOpsSettings
from app.decision.jev_client import JevDecisionClient
from app.decision.policy_gate import DeterministicPolicyGate
from app.guardrails.dedup import AlertDeduplicator, ResponseCache
from app.guardrails.sanitizer import InputSanitizer
from app.providers.base import BaseLLMProvider, InferenceRequest, ProviderError
from app.providers.deepseek import DeepSeekProvider
from app.providers.gemini import GeminiProvider
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


class SaSaAgent:
    """Primary AIOps Agent orchestrating Jev decision routing, LLM RCA, and HITL workflows."""

    def __init__(
        self,
        settings: AIOpsSettings | None = None,
        *,
        llm_provider: BaseLLMProvider | None = None,
        jev_client: JevDecisionClient | None = None,
        policy_gate: DeterministicPolicyGate | None = None,
        deduplicator: AlertDeduplicator | None = None,
        response_cache: ResponseCache[RCAReport] | None = None,
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

    def _create_default_provider(self) -> BaseLLMProvider:
        if self.settings.AIOPS_DEFAULT_PROVIDER == "gemini":
            return GeminiProvider(self.settings)
        return DeepSeekProvider(self.settings)

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
    ) -> RCAReport:
        """Construct a deterministic structured RCA report if LLM inference is offline or skipped."""
        evidence = [
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
                f"host '{alert.server_id}'."
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
                f"event ('{alert.alert_name}') on server '{alert.server_id}'."
            ),
            proposed_resolution=(
                "Verify live telemetry in Prometheus/Grafana and execute the allowlisted runbook "
                "step only after verifying preconditions."
            ),
            expected_impact=(
                "Minimal impact if read-only diagnostics run first; service restart actions may "
                "cause brief connection draining."
            ),
            intended_tools=["query_prometheus", "get_server_context", "search_runbook"],
        )

    @staticmethod
    def _format_notification(
        alert: AlertItem,
        policy: PolicyDecision,
        rca: RCAReport | None,
    ) -> str:
        """Format the operator/Telegram announcement according to severity tier."""
        if policy.strategy == ExecutionStrategy.NO_ACTION_RESOLVED:
            return f"[RESOLVED] Alert '{alert.alert_name}' on '{alert.server_id}' has cleared."

        if policy.severity == SeverityTier.CRITICAL:
            summary = rca.summary if rca else "Read-only RCA pending."
            return (
                f"🚨 [CRITICAL ESCALATION - NO AUTO EXECUTION] Host={alert.server_id} "
                f"Alert={alert.alert_name} | {summary}"
            )

        if policy.strategy == ExecutionStrategy.REQUEST_HITL_APPROVAL:
            action = (rca.recommended_action_id if rca else None) or "manual-review"
            return (
                f"⚠️ [HITL APPROVAL REQUIRED] Host={alert.server_id} Alert={alert.alert_name} "
                f"ProposedAction={action} | Please Approve or Reject."
            )

        return (
            f"✅ [LOW - AUTO ALLOWLISTED] Host={alert.server_id} Alert={alert.alert_name} "
            f"Action={policy.approved_action_id}"
        )

    async def process_webhook(
        self,
        payload: AlertWebhookPayload,
        *,
        correlation_id: str | None = None,
    ) -> WebhookProcessingResult:
        """Execute the full Step 8 traceable pipeline for an incoming alert webhook."""
        started = time.perf_counter()
        corr_id = correlation_id or f"req-{uuid.uuid4().hex[:12]}"

        # Stage 1 & 2: Input validation & Prompt-Injection Guardrails
        InputSanitizer.validate_webhook_payload(payload)
        primary = payload.primary_alert()
        fingerprint = primary.compute_fingerprint()

        # Handle resolved alerts immediately and clear deduplication cooldown
        if payload.status == AlertStatus.RESOLVED or primary.status == AlertStatus.RESOLVED:
            self.deduplicator.clear(fingerprint)
            jev_Req = JevDecisionRequest(
                fingerprint=fingerprint,
                server_id=primary.server_id,
                alert_name=primary.alert_name,
                declared_severity=primary.declared_severity,
                status=AlertStatus.RESOLVED.value,
                labels=primary.labels,
                annotations=primary.annotations,
            )
            jev_resp = self.jev_client.evaluate_heuristic(jev_Req)
            policy = self.policy_gate.enforce(jev_resp, alert_status=AlertStatus.RESOLVED)
            latency_ms = round((time.perf_counter() - started) * 1000.0, 2)
            trace = PipelineTraceMetadata(
                correlation_id=corr_id,
                fingerprint=fingerprint,
                jev_backend=jev_resp.backend_mode,
                latency_ms=latency_ms,
            )
            return WebhookProcessingResult(
                incident_fingerprint=fingerprint,
                server_id=primary.server_id,
                alert_name=primary.alert_name,
                strategy=policy.strategy,
                policy_decision=policy,
                notification_message=self._format_notification(primary, policy, None),
                trace=trace,
            )

        # Stage 3: Alert Storm Fingerprint Deduplication (Tier 0 Cost Shield)
        if self.deduplicator.is_duplicate(fingerprint):
            cached_rca = self.response_cache.get(fingerprint)
            latency_ms = round((time.perf_counter() - started) * 1000.0, 2)
            trace = PipelineTraceMetadata(
                correlation_id=corr_id,
                fingerprint=fingerprint,
                deduplicated=True,
                cache_hit=cached_rca is not None,
                latency_ms=latency_ms,
            )
            return WebhookProcessingResult(
                incident_fingerprint=fingerprint,
                server_id=primary.server_id,
                alert_name=primary.alert_name,
                strategy=ExecutionStrategy.REQUEST_HITL_APPROVAL,
                deduplicated=True,
                cache_hit=cached_rca is not None,
                rca_report=cached_rca,
                notification_message=(
                    f"[SUPPRESSED DUPLICATE] Alert '{primary.alert_name}' on "
                    f"'{primary.server_id}' is within active cooldown window."
                ),
                trace=trace,
            )

        # Stage 4: Jev Decision Model + Deterministic Policy Gate
        jev_request = JevDecisionRequest(
            fingerprint=fingerprint,
            server_id=primary.server_id,
            alert_name=primary.alert_name,
            declared_severity=primary.declared_severity,
            status=primary.status.value,
            summary=payload.message or payload.title,
            labels=primary.labels,
            annotations=primary.annotations,
        )
        jev_response = await self.jev_client.evaluate(jev_request)
        policy = self.policy_gate.enforce(jev_response, alert_status=primary.status)

        # Stage 5: Cache Lookup (Tier 1 Cost Shield)
        cached = self.response_cache.get(fingerprint)
        if cached is not None:
            self.deduplicator.record(fingerprint)
            latency_ms = round((time.perf_counter() - started) * 1000.0, 2)
            trace = PipelineTraceMetadata(
                correlation_id=corr_id,
                fingerprint=fingerprint,
                cache_hit=True,
                jev_backend=jev_response.backend_mode,
                llm_provider=cached.provider_name,
                llm_model=cached.model_name,
                latency_ms=latency_ms,
            )
            return WebhookProcessingResult(
                incident_fingerprint=fingerprint,
                server_id=primary.server_id,
                alert_name=primary.alert_name,
                strategy=policy.strategy,
                cache_hit=True,
                policy_decision=policy,
                rca_report=cached,
                notification_message=self._format_notification(primary, policy, cached),
                trace=trace,
            )

        # Stage 6 & 7: Read-Only Context & LLM Inference + Output Schema Validation
        prompt_tokens = 0
        completion_tokens = 0
        system_prompt = build_system_prompt(self.settings.AIOPS_AGENT_NAME)
        user_prompt = build_rca_user_prompt(primary, policy)

        try:
            inference_resp = await self.llm_provider.generate(
                InferenceRequest(
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    temperature=0.1,
                    response_json=True,
                )
            )
            prompt_tokens = inference_resp.prompt_tokens
            completion_tokens = inference_resp.completion_tokens
            parsed_json = self._extract_json_object(inference_resp.content)
            rca_report = RCAReport(
                agent_name=self.settings.AIOPS_AGENT_NAME,
                provider_name=inference_resp.provider_name,
                model_name=inference_resp.model_name,
                summary=str(parsed_json.get("summary") or f"RCA for {primary.alert_name}"),
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
                        or ["query_prometheus", "get_server_context"]
                    )
                ],
            )
        except (ProviderError, ValueError, KeyError, TypeError):
            # Graceful resilience (INTRODUCT.md 16.1): if AI provider is unreachable or returns
            # non-JSON output, incident handling and notifications continue using structured fallback.
            rca_report = self._build_fallback_rca(
                primary,
                policy,
                fallback_note="Generated via deterministic fallback while LLM provider was unavailable.",
            )

        self.deduplicator.record(fingerprint)
        self.response_cache.set(fingerprint, rca_report)

        latency_ms = round((time.perf_counter() - started) * 1000.0, 2)
        trace = PipelineTraceMetadata(
            correlation_id=corr_id,
            fingerprint=fingerprint,
            jev_backend=jev_response.backend_mode,
            llm_provider=rca_report.provider_name,
            llm_model=rca_report.model_name,
            latency_ms=latency_ms,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
        )
        return WebhookProcessingResult(
            incident_fingerprint=fingerprint,
            server_id=primary.server_id,
            alert_name=primary.alert_name,
            strategy=policy.strategy,
            policy_decision=policy,
            rca_report=rca_report,
            notification_message=self._format_notification(primary, policy, rca_report),
            trace=trace,
        )
