"""Task 2 & P1.2: Jev Decision Model Integration.

Separates the Decision Layer (`Jev`) from the general LLM Inference Layer
(`DeepSeek` / `Ollama` / `Gemini`). Supports:
1. Remote/local `Jev` Decision Model HTTP API (`JEV_MODE="api"`) authenticated
   via `JEV_API_KEY` and `JEV_API_URL`.
2. Domain-complete deterministic heuristic classification (`JEV_MODE="heuristic"`)
   covering Linux VM, Windows VM, Docker Containers, and SSL Certificates
   (External HTTPS prober + Local VM x509 scanners).
"""

from __future__ import annotations

import re

import httpx

from app.config import AIOpsSettings
from app.schemas.decision import (
    JevDecisionRequest,
    JevDecisionResponse,
    SeverityTier,
)

_DAYS_REMAINING_RE = re.compile(
    r"(?:days_remaining\s*[:=]\s*(-?\d+(?:\.\d+)?)|(-?\d+(?:\.\d+)?)\s*days?\s*remaining)",
    re.IGNORECASE,
)

_SSL_LABEL_KEYS = frozenset(
    {"endpoint", "filepath", "subject_cn", "issuer_cn", "target_name", "ssl_target_id"}
)
_SSL_MEDIA_VALUES = frozenset({"external_https", "linux_file", "windows_store"})
_SSL_KEYWORDS = (
    "ssl",
    "x509",
    "cert_expired",
    "certexpired",
    "certificate",
    "dns_timeout",
    "tls_timeout",
    "private_address_blocked",
    "tls_probe_failed",
    "no_peer_certificate",
    "invalid_certificate_dates",
    "reprobe-ssl-target",
)
_SSL_CRITICAL_KEYWORDS = (
    "expired",
    "ssl_expired",
    "cert_expired",
    "certexpired",
    "sslcertexpired",
    "sslcritical",
    "ssl_critical",
    "sslcertexpiringcritical",
    "<7d",
    "< 7d",
    "< 7 days",
)
_SSL_PROBE_ERROR_KEYWORDS = (
    "x509_read_errors",
    "x509readerrors",
    "dns_timeout",
    "tls_timeout",
    "private_address_blocked",
    "tls_probe_failed",
    "no_peer_certificate",
    "invalid_certificate_dates",
    "sslprobe",
    "ssl_probe",
    "reprobe",
)
_SSL_EXPIRING_KEYWORDS = (
    "7-28d",
    "expiring",
    "sslwarning",
    "ssl_warning",
    "sslcertexpiringwarning",
)

_CONTAINER_KEYWORDS = (
    "container",
    "docker",
    "oom_killed",
    "oomkilled",
    "restartloop",
    "restart_loop",
    "cadvisor",
)
_CONTAINER_CRITICAL_KEYWORDS = (
    "oom_killed",
    "oomkilled",
    "containerdown",
    "container_down",
    "containerstopped",
    "container_stopped",
    "dead",
)
_CONTAINER_DIAGNOSTICS_KEYWORDS = (
    "container_diagnostics",
    "collect_container_diagnostics",
    "containerdiagnostics",
)
_CONTAINER_MEDIUM_KEYWORDS = (
    "unhealthy",
    "restarting",
    "restartloop",
    "restart_loop",
    "exited",
    "throttled",
    "containerhighmemory",
    "container_high_memory",
    "containerhighcpu",
    "container_high_cpu",
)

_WINDOWS_VM_KEYWORDS = (
    "windows_cpu",
    "windowscpu",
    "windows_memory",
    "windowsmemory",
    "windows_logical_disk",
    "windows_disk",
    "windowsdisk",
    "processor_queue_length",
    "processorqueuelength",
)
_VM_CRITICAL_KEYWORDS = (
    "down",
    "outage",
    "diskfull",
    "oom",
    "panic",
    "unreachable",
    "hostdown",
    "host_down",
    "vmhostdown",
    "alloy_down",
    "alloydown",
    "memorycritical",
)
_VM_LOW_KEYWORDS = (
    "temp_cleanup",
    "cache_warmup",
    "log_rotate",
    "tmp_clean",
    "refresh_metrics",
)


class JevDecisionError(RuntimeError):
    """Raised when the Jev Decision Model endpoint fails or returns an invalid payload."""


class JevDecisionClient:
    """Client for evaluating alert severity and routing via the Jev Decision Model."""

    def __init__(
        self,
        settings: AIOpsSettings | None = None,
        *,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self.settings = settings or AIOpsSettings.from_env()
        self._client = http_client

    @property
    def backend_mode(self) -> str:
        return self.settings.resolved_jev_backend()

    @property
    def api_url(self) -> str:
        return self.settings.JEV_API_URL.strip()

    @property
    def model_name(self) -> str:
        return self.settings.JEV_MODEL

    def _build_headers(self) -> dict[str, str]:
        api_key = self.settings.JEV_API_KEY.get_secret_value().strip()
        if not api_key:
            raise JevDecisionError(
                "JEV_MODE='api' requires JEV_API_KEY to be configured in environment or .env."
            )
        return {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "X-Jev-Model": self.model_name,
        }

    @staticmethod
    def _extract_days_remaining(request: JevDecisionRequest, combined_text: str) -> float | None:
        """Parse numeric `days_remaining` from labels, annotations, or summary text."""
        for source in (request.labels, request.annotations):
            for key, val in source.items():
                if key.lower() == "days_remaining":
                    try:
                        return float(str(val).strip())
                    except ValueError:
                        pass
        match = _DAYS_REMAINING_RE.search(combined_text)
        if match:
            raw_num = match.group(1) or match.group(2)
            if raw_num is not None:
                try:
                    return float(raw_num)
                except ValueError:
                    return None
        return None

    @staticmethod
    def _detect_domain(request: JevDecisionRequest, combined_text: str) -> str:
        """Identify alert domain (`ssl`, `container`, or `vm`) from labels and alert signals."""
        explicit_domain = (
            str(getattr(request, "domain", "") or "") or request.labels.get("domain", "")
        ).lower().strip()
        if explicit_domain in {"ssl", "container"}:
            return explicit_domain

        lower_labels = {k.lower(): str(v).lower().strip() for k, v in request.labels.items()}
        alert_lower = request.alert_name.lower()

        if (
            any(lower_labels.get(k) for k in _SSL_LABEL_KEYS)
            or lower_labels.get("media") in _SSL_MEDIA_VALUES
            or lower_labels.get("instance") == "management-ssl-prober"
            or lower_labels.get("action_id") == "reprobe-ssl-target"
            or any(kw in alert_lower for kw in _SSL_KEYWORDS)
            or any(
                kw in combined_text
                for kw in (
                    "x509_read_errors",
                    "dns_timeout",
                    "tls_timeout",
                    "private_address_blocked",
                    "tls_probe_failed",
                    "ssl_expired",
                    "cert_expired",
                )
            )
        ):
            return "ssl"

        if (
            bool(lower_labels.get("container"))
            or lower_labels.get("action_id")
            in {"restart-approved-container", "collect-container-diagnostics"}
            or any(kw in alert_lower for kw in _CONTAINER_KEYWORDS)
        ):
            return "container"

        return "vm"

    def _evaluate_ssl(
        self,
        request: JevDecisionRequest,
        raw_sev: str,
        alert_lower: str,
        combined_text: str,
        target: str,
    ) -> JevDecisionResponse:
        days_remaining = self._extract_days_remaining(request, combined_text)
        is_critical_days = days_remaining is not None and days_remaining < 7.0
        is_critical_signal = (
            raw_sev in {"critical", "page", "fatal", "emergency"}
            or is_critical_days
            or any(kw in combined_text for kw in _SSL_CRITICAL_KEYWORDS)
        )
        if is_critical_signal:
            days_note = f" ({days_remaining:.1f}d remaining)" if days_remaining is not None else ""
            return JevDecisionResponse(
                model_name=self.model_name,
                backend_mode="heuristic",
                severity=SeverityTier.CRITICAL,
                complexity_score=0.9,
                confidence=0.94,
                candidate_action_id="reprobe-ssl-target",
                recommended_model_tier="reasoning",
                rationale=(
                    f"SSL alert '{request.alert_name}' on '{target}'{days_note} classified as CRITICAL; "
                    "immediate administrator escalation with read-only RCA required (no autonomous execution)."
                ),
            )

        is_expiring_renewal = (
            (days_remaining is not None and 7.0 <= days_remaining < 28.0)
            or any(kw in combined_text for kw in _SSL_EXPIRING_KEYWORDS)
        )
        is_probe_error = any(kw in combined_text for kw in _SSL_PROBE_ERROR_KEYWORDS)

        if (
            raw_sev in {"low", "info", "informational", "minor"}
            and not is_expiring_renewal
        ):
            return JevDecisionResponse(
                model_name=self.model_name,
                backend_mode="heuristic",
                severity=SeverityTier.LOW,
                complexity_score=0.25,
                confidence=0.9,
                candidate_action_id="reprobe-ssl-target",
                recommended_model_tier="lightweight",
                rationale=(
                    f"SSL transient probe alert '{request.alert_name}' on '{target}' classified as LOW; "
                    "eligible for allowlisted `reprobe-ssl-target` verification."
                ),
            )

        candidate = request.labels.get("action_id") or (
            "reprobe-ssl-target" if (is_probe_error and not is_expiring_renewal) else "renew-ssl-certificate"
        )
        return JevDecisionResponse(
            model_name=self.model_name,
            backend_mode="heuristic",
            severity=SeverityTier.MEDIUM,
            complexity_score=0.6,
            confidence=0.88,
            candidate_action_id=candidate,
            recommended_model_tier="standard",
            rationale=(
                f"SSL alert '{request.alert_name}' on '{target}' classified as MEDIUM; "
                "requires RCA and administrator HITL approval for renewal or probe remediation."
            ),
        )

    def _evaluate_container(
        self,
        request: JevDecisionRequest,
        raw_sev: str,
        alert_lower: str,
        combined_text: str,
        target: str,
    ) -> JevDecisionResponse:
        if any(kw in combined_text for kw in _CONTAINER_DIAGNOSTICS_KEYWORDS) or (
            request.labels.get("action_id") == "collect-container-diagnostics"
            and raw_sev not in {"critical", "page", "fatal", "emergency"}
        ):
            return JevDecisionResponse(
                model_name=self.model_name,
                backend_mode="heuristic",
                severity=SeverityTier.LOW,
                complexity_score=0.2,
                confidence=0.91,
                candidate_action_id="collect-container-diagnostics",
                recommended_model_tier="lightweight",
                rationale=(
                    f"Container diagnostic alert '{request.alert_name}' on '{target}' classified as LOW; "
                    "eligible for allowlisted read-only `collect-container-diagnostics`."
                ),
            )

        if raw_sev in {"critical", "page", "fatal", "emergency"} or any(
            kw in alert_lower for kw in _CONTAINER_CRITICAL_KEYWORDS
        ) or any(
            kw in combined_text for kw in ("oom_killed", "oomkilled")
        ):
            return JevDecisionResponse(
                model_name=self.model_name,
                backend_mode="heuristic",
                severity=SeverityTier.CRITICAL,
                complexity_score=0.92,
                confidence=0.93,
                candidate_action_id=None,
                recommended_model_tier="reasoning",
                rationale=(
                    f"Container alert '{request.alert_name}' on '{target}' classified as CRITICAL; "
                    "autonomous container restarts are forbidden — escalating with read-only RCA."
                ),
            )

        if raw_sev in {"low", "info", "informational", "minor"} and not any(
            kw in combined_text for kw in _CONTAINER_MEDIUM_KEYWORDS
        ):
            candidate = request.labels.get("action_id") or "collect-container-diagnostics"
            return JevDecisionResponse(
                model_name=self.model_name,
                backend_mode="heuristic",
                severity=SeverityTier.LOW,
                complexity_score=0.2,
                confidence=0.89,
                candidate_action_id=candidate,
                recommended_model_tier="lightweight",
                rationale=(
                    f"Container alert '{request.alert_name}' on '{target}' classified as LOW; "
                    "eligible for lightweight diagnostics and allowlist check."
                ),
            )

        candidate = request.labels.get("action_id") or "restart-approved-container"
        return JevDecisionResponse(
            model_name=self.model_name,
            backend_mode="heuristic",
            severity=SeverityTier.MEDIUM,
            complexity_score=0.62,
            confidence=0.87,
            candidate_action_id=candidate,
            recommended_model_tier="standard",
            rationale=(
                f"Container alert '{request.alert_name}' on '{target}' classified as MEDIUM; "
                "requires RCA and administrator HITL approval before restarting container."
            ),
        )

    def evaluate_heuristic(self, request: JevDecisionRequest) -> JevDecisionResponse:
        """Deterministic baseline decision rules across VM (Linux/Windows), Container, and SSL."""
        raw_sev = request.declared_severity.lower().strip()
        alert_lower = request.alert_name.lower().strip()
        summary_lower = (request.summary or "").lower()
        ann_text = " ".join(str(v).lower() for v in request.annotations.values())
        label_text = " ".join(f"{k.lower()}={str(v).lower()}" for k, v in request.labels.items())
        combined_text = " ".join(part for part in (alert_lower, summary_lower, ann_text, label_text) if part)

        target = (
            str(getattr(request, "target_id", "") or "").strip()
            or request.labels.get("endpoint")
            or request.labels.get("container")
            or request.server_id
        )

        domain = self._detect_domain(request, combined_text)
        if domain == "ssl":
            return self._evaluate_ssl(request, raw_sev, alert_lower, combined_text, target)
        if domain == "container":
            return self._evaluate_container(request, raw_sev, alert_lower, combined_text, target)

        # VM domain (Linux & Windows)
        is_windows = (
            request.labels.get("platform", "").lower() == "windows"
            or request.labels.get("os", "").lower() == "windows"
            or any(kw in combined_text for kw in _WINDOWS_VM_KEYWORDS)
        )
        vm_label = "Windows VM" if is_windows else "Linux VM"

        if raw_sev in {"critical", "page", "fatal", "emergency"} or any(
            kw in alert_lower for kw in _VM_CRITICAL_KEYWORDS
        ):
            return JevDecisionResponse(
                model_name=self.model_name,
                backend_mode="heuristic",
                severity=SeverityTier.CRITICAL,
                complexity_score=0.9,
                confidence=0.92,
                candidate_action_id=None,
                recommended_model_tier="reasoning",
                rationale=(
                    f"{vm_label} alert '{request.alert_name}' on '{request.server_id}' classified as CRITICAL; "
                    "immediate administrator escalation with read-only RCA required."
                ),
            )

        if raw_sev in {"low", "info", "informational", "minor"} or any(
            kw in alert_lower for kw in _VM_LOW_KEYWORDS
        ):
            candidate = request.labels.get("action_id")
            if not candidate:
                if "log_rotate" in alert_lower:
                    candidate = "rotate-noncritical-logs"
                elif "cache" in alert_lower or "refresh_metrics" in alert_lower:
                    candidate = "refresh-metrics-collector-cache"
                else:
                    candidate = "cleanup-temp-directory"
            return JevDecisionResponse(
                model_name=self.model_name,
                backend_mode="heuristic",
                severity=SeverityTier.LOW,
                complexity_score=0.2,
                confidence=0.9,
                candidate_action_id=candidate,
                recommended_model_tier="lightweight",
                rationale=(
                    f"{vm_label} alert '{request.alert_name}' on '{request.server_id}' classified as LOW; "
                    "eligible for lightweight model processing and allowlisted action check."
                ),
            )

        candidate = request.labels.get("action_id") or "restart-approved-service"
        return JevDecisionResponse(
            model_name=self.model_name,
            backend_mode="heuristic",
            severity=SeverityTier.MEDIUM,
            complexity_score=0.6,
            confidence=0.85,
            candidate_action_id=candidate,
            recommended_model_tier="standard",
            rationale=(
                f"{vm_label} alert '{request.alert_name}' on '{request.server_id}' classified as MEDIUM; "
                "requires RCA generation and administrator HITL approval before execution."
            ),
        )

    async def evaluate(self, request: JevDecisionRequest) -> JevDecisionResponse:
        """Evaluate an incoming alert via the Jev API or fallback heuristic."""
        if self.backend_mode == "heuristic":
            return self.evaluate_heuristic(request)

        headers = self._build_headers()
        if not self.api_url:
            raise JevDecisionError("JEV_API_URL must not be empty when JEV_MODE='api'.")

        payload = {
            "model": self.model_name,
            "event": request.model_dump(),
        }

        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self.settings.JEV_TIMEOUT_SECONDS)
        try:
            response = await client.post(self.api_url, headers=headers, json=payload)
        except httpx.HTTPError as exc:
            if self.settings.JEV_MODE == "auto":
                return self.evaluate_heuristic(request)
            raise JevDecisionError(f"Jev transport failure against {self.api_url}: {exc}") from exc
        finally:
            if owns_client:
                await client.aclose()

        if response.status_code >= 400:
            if self.settings.JEV_MODE == "auto":
                return self.evaluate_heuristic(request)
            raise JevDecisionError(f"Jev API returned HTTP {response.status_code}.")

        try:
            data = response.json()
            severity = SeverityTier(str(data.get("severity", "medium")).lower())
            return JevDecisionResponse(
                model_name=str(data.get("model_name") or self.model_name),
                backend_mode="api",
                severity=severity,
                complexity_score=float(data.get("complexity_score", 0.5)),
                confidence=float(data.get("confidence", 0.85)),
                candidate_action_id=data.get("candidate_action_id"),
                recommended_model_tier=str(data.get("recommended_model_tier") or "lightweight"),
                rationale=str(data.get("rationale") or "Evaluated by Jev Decision Model API."),
            )
        except (ValueError, TypeError, KeyError) as exc:
            raise JevDecisionError("Jev API returned malformed decision payload.") from exc

    async def health_check(self) -> dict[str, object]:
        """Verify Jev Decision Model configuration and reachability."""
        mode = self.backend_mode
        if mode == "heuristic":
            return {
                "component": "jev_decision_model",
                "backend_mode": "heuristic",
                "model": self.model_name,
                "configured": True,
                "reachable": True,
            }

        try:
            headers = self._build_headers()
        except JevDecisionError as exc:
            return {
                "component": "jev_decision_model",
                "backend_mode": "api",
                "model": self.model_name,
                "configured": False,
                "reachable": False,
                "detail": str(exc),
            }

        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=min(self.settings.JEV_TIMEOUT_SECONDS, 5.0))
        try:
            resp = await client.get(self.api_url, headers=headers)
            return {
                "component": "jev_decision_model",
                "backend_mode": "api",
                "model": self.model_name,
                "configured": True,
                "reachable": resp.status_code < 500,
                "status_code": resp.status_code,
            }
        except httpx.HTTPError:
            return {
                "component": "jev_decision_model",
                "backend_mode": "api",
                "model": self.model_name,
                "configured": True,
                "reachable": False,
                "status_code": None,
            }
        finally:
            if owns_client:
                await client.aclose()
