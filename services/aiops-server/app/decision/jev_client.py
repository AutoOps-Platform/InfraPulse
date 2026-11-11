"""Task 2: Jev Decision Model Integration.

Separates the Decision Layer (`Jev`) from the general LLM Inference Layer
(`DeepSeek` / `Ollama` / `Gemini`). Supports:
1. Remote/local `Jev` Decision Model HTTP API (`JEV_MODE="api"`) authenticated
   via `JEV_API_KEY` and `JEV_API_URL`.
2. Deterministic heuristic classification (`JEV_MODE="heuristic"`) when testing
   locally before live `JEV_API_KEY` credentials are inserted.
"""

from __future__ import annotations

import httpx

from app.config import AIOpsSettings
from app.schemas.decision import (
    JevDecisionRequest,
    JevDecisionResponse,
    SeverityTier,
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

    def evaluate_heuristic(self, request: JevDecisionRequest) -> JevDecisionResponse:
        """Deterministic baseline decision rules when running in `heuristic` mode."""
        raw_sev = request.declared_severity.lower().strip()
        alert_lower = request.alert_name.lower()

        if raw_sev in {"critical", "page", "fatal", "emergency"} or any(
            kw in alert_lower for kw in ("down", "outage", "diskfull", "oom", "panic", "unreachable")
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
                    f"Alert '{request.alert_name}' on '{request.server_id}' classified as CRITICAL; "
                    "immediate administrator escalation with read-only RCA required."
                ),
            )

        if raw_sev in {"low", "info", "informational", "minor"} or any(
            kw in alert_lower for kw in ("temp_cleanup", "cache_warmup", "log_rotate", "tmp_clean")
        ):
            candidate = request.labels.get("action_id") or "cleanup-temp-directory"
            return JevDecisionResponse(
                model_name=self.model_name,
                backend_mode="heuristic",
                severity=SeverityTier.LOW,
                complexity_score=0.2,
                confidence=0.9,
                candidate_action_id=candidate,
                recommended_model_tier="lightweight",
                rationale=(
                    f"Alert '{request.alert_name}' on '{request.server_id}' classified as LOW; "
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
                f"Alert '{request.alert_name}' on '{request.server_id}' classified as MEDIUM; "
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
