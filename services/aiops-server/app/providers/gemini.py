"""P1.3: Gemini API Provider adapter with JSON response_format and live /models health probe."""

from __future__ import annotations

import time
from typing import Any

import httpx

from app.config import AIOpsSettings
from app.providers.base import (
    BaseLLMProvider,
    InferenceRequest,
    InferenceResponse,
    ProviderError,
)


class GeminiProvider(BaseLLMProvider):
    """OpenAI-compatible Gemini inference adapter configured via `GEMINI_API_KEY`."""

    def __init__(
        self,
        settings: AIOpsSettings | None = None,
        *,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self.settings = settings or AIOpsSettings.from_env()
        self._client = http_client

    @property
    def provider_name(self) -> str:
        return "gemini"

    @property
    def base_url(self) -> str:
        return self.settings.GEMINI_BASE_URL.rstrip("/")

    @property
    def model_name(self) -> str:
        return self.settings.GEMINI_MODEL

    def is_configured(self) -> bool:
        """Return True when `GEMINI_API_KEY` is populated."""
        return bool(self.settings.GEMINI_API_KEY.get_secret_value().strip())

    def resolve_model(
        self,
        *,
        model_tier: str | None = None,
        model_override: str | None = None,
    ) -> str:
        """Resolve Gemini model name, honoring explicit `model_override` when given."""
        if model_override and model_override.strip():
            return model_override.strip()
        return self.model_name

    def _build_headers(self) -> dict[str, str]:
        api_key = self.settings.GEMINI_API_KEY.get_secret_value().strip()
        if not api_key:
            raise ProviderError("GEMINI_API_KEY is required when using GeminiProvider.")
        return {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        }

    async def generate(
        self,
        request: InferenceRequest,
        *,
        model_tier: str | None = None,
        model_override: str | None = None,
    ) -> InferenceResponse:
        headers = self._build_headers()
        url = f"{self.base_url}/chat/completions"
        resolved_model = self.resolve_model(
            model_tier=model_tier,
            model_override=model_override or request.model_override,
        )

        payload: dict[str, Any] = {
            "model": resolved_model,
            "messages": [
                {"role": "system", "content": request.system_prompt},
                {"role": "user", "content": request.user_prompt},
            ],
            "temperature": request.temperature,
            "max_tokens": request.max_tokens,
        }
        if request.response_json:
            payload["response_format"] = {"type": "json_object"}

        started = time.perf_counter()
        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self.settings.GEMINI_TIMEOUT_SECONDS)
        try:
            response = await client.post(url, headers=headers, json=payload)
        except httpx.HTTPError as exc:
            raise ProviderError(f"Gemini transport failure: {exc}") from exc
        finally:
            if owns_client:
                await client.aclose()

        latency_ms = round((time.perf_counter() - started) * 1000.0, 2)
        if response.status_code >= 400:
            raise ProviderError(f"Gemini returned HTTP {response.status_code}.")

        try:
            data = response.json()
            content = data["choices"][0]["message"]["content"]
            usage = data.get("usage") or {}
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise ProviderError("Gemini returned malformed completion payload.") from exc

        return InferenceResponse(
            provider_name=self.provider_name,
            backend_mode="api",
            model_name=str(data.get("model") or resolved_model),
            content=str(content),
            prompt_tokens=int(usage.get("prompt_tokens") or 0),
            completion_tokens=int(usage.get("completion_tokens") or 0),
            latency_ms=latency_ms,
        )

    async def health_check(self) -> dict[str, object]:
        """Perform a live `GET {base_url}/models` probe against the Gemini OpenAI endpoint."""
        try:
            headers = self._build_headers()
        except ProviderError as exc:
            return {
                "provider": self.provider_name,
                "backend_mode": "api",
                "model": self.model_name,
                "configured": False,
                "reachable": False,
                "detail": str(exc),
            }

        url = f"{self.base_url}/models"
        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(
            timeout=min(self.settings.GEMINI_TIMEOUT_SECONDS, 5.0)
        )
        try:
            resp = await client.get(url, headers=headers)
            reachable = resp.status_code < 400
            return {
                "provider": self.provider_name,
                "backend_mode": "api",
                "model": self.model_name,
                "configured": True,
                "reachable": reachable,
                "status_code": resp.status_code,
            }
        except httpx.HTTPError:
            return {
                "provider": self.provider_name,
                "backend_mode": "api",
                "model": self.model_name,
                "configured": True,
                "reachable": False,
                "status_code": None,
            }
        finally:
            if owns_client:
                await client.aclose()
