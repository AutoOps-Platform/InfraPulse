"""Gemini API Provider adapter preserving compatibility with existing Gemini API keys."""

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
    def model_name(self) -> str:
        return self.settings.GEMINI_MODEL

    def _build_headers(self) -> dict[str, str]:
        api_key = self.settings.GEMINI_API_KEY.get_secret_value().strip()
        if not api_key:
            raise ProviderError("GEMINI_API_KEY is required when using GeminiProvider.")
        return {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        }

    async def generate(self, request: InferenceRequest) -> InferenceResponse:
        headers = self._build_headers()
        base_url = self.settings.GEMINI_BASE_URL.rstrip("/")
        url = f"{base_url}/chat/completions"
        payload: dict[str, Any] = {
            "model": self.model_name,
            "messages": [
                {"role": "system", "content": request.system_prompt},
                {"role": "user", "content": request.user_prompt},
            ],
            "temperature": request.temperature,
            "max_tokens": request.max_tokens,
        }

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
            model_name=str(data.get("model") or self.model_name),
            content=str(content),
            prompt_tokens=int(usage.get("prompt_tokens") or 0),
            completion_tokens=int(usage.get("completion_tokens") or 0),
            latency_ms=latency_ms,
        )

    async def health_check(self) -> dict[str, object]:
        has_key = bool(self.settings.GEMINI_API_KEY.get_secret_value().strip())
        return {
            "provider": self.provider_name,
            "backend_mode": "api",
            "model": self.model_name,
            "configured": has_key,
            "reachable": has_key,
        }
