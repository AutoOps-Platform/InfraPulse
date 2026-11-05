"""Task 1: Unified DeepSeek Cloud API and Ollama Local Inference Provider.

Supports:
1. Local Ollama inference (`http://localhost:11434/v1`) for `deepseek-r1:latest`
   or `deepseek-v4.1-flash` with zero external API key required.
2. DeepSeek Cloud API (`https://api.deepseek.com/v1`) authenticated via
   `DEEPSEEK_API_KEY` from environment variables.
3. Optional PydanticAI model construction (`build_pydantic_ai_model`) preserving
   full compatibility with `services/aiops-server/agent.py`.
"""

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


class DeepSeekProvider(BaseLLMProvider):
    """Interchangeable DeepSeek provider supporting both Ollama local and DeepSeek Cloud API."""

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
        return "deepseek"

    @property
    def backend_mode(self) -> str:
        return self.settings.resolved_deepseek_backend()

    @property
    def base_url(self) -> str:
        if self.backend_mode == "api":
            return self.settings.DEEPSEEK_BASE_URL.rstrip("/")
        return self.settings.OLLAMA_BASE_URL.rstrip("/")

    @property
    def model_name(self) -> str:
        if self.backend_mode == "api":
            return self.settings.DEEPSEEK_MODEL
        return self.settings.OLLAMA_MODEL

    @property
    def timeout_seconds(self) -> float:
        if self.backend_mode == "api":
            return self.settings.DEEPSEEK_TIMEOUT_SECONDS
        return self.settings.OLLAMA_TIMEOUT_SECONDS

    def _build_headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.backend_mode == "api":
            api_key = self.settings.DEEPSEEK_API_KEY.get_secret_value().strip()
            if not api_key:
                raise ProviderError(
                    "DEEPSEEK_MODE='api' requires DEEPSEEK_API_KEY to be set in environment or .env."
                )
            headers["Authorization"] = f"Bearer {api_key}"
        else:
            # Ollama local OpenAI-compatible endpoint accepts a non-secret placeholder bearer
            headers["Authorization"] = "Bearer ollama"
        return headers

    def build_pydantic_ai_model(self) -> Any:
        """Build a `pydantic_ai` model instance for either Ollama local or DeepSeek API."""
        try:
            from pydantic_ai.models.ollama import OllamaModel
            from pydantic_ai.providers.ollama import OllamaProvider
        except ImportError as exc:  # pragma: no cover
            raise ProviderError("pydantic_ai is not installed in the current environment.") from exc

        if self.backend_mode == "ollama":
            return OllamaModel(
                self.model_name,
                provider=OllamaProvider(base_url=self.base_url),
            )

        try:
            from pydantic_ai.models.openai import OpenAIModel
            from pydantic_ai.providers.openai import OpenAIProvider

            api_key = self.settings.DEEPSEEK_API_KEY.get_secret_value().strip()
            if not api_key:
                raise ProviderError("DEEPSEEK_API_KEY is required to build DeepSeek API model.")
            return OpenAIModel(
                self.model_name,
                provider=OpenAIProvider(base_url=self.base_url, api_key=api_key),
            )
        except ImportError:
            return OllamaModel(
                self.model_name,
                provider=OllamaProvider(base_url=self.base_url),
            )

    async def generate(self, request: InferenceRequest) -> InferenceResponse:
        """Send an OpenAI-compatible chat completion request to DeepSeek API or Ollama."""
        headers = self._build_headers()
        url = f"{self.base_url}/chat/completions"

        payload: dict[str, Any] = {
            "model": self.model_name,
            "messages": [
                {"role": "system", "content": request.system_prompt},
                {"role": "user", "content": request.user_prompt},
            ],
            "temperature": request.temperature,
            "max_tokens": request.max_tokens,
        }
        if request.response_json and self.backend_mode == "api":
            payload["response_format"] = {"type": "json_object"}

        started = time.perf_counter()
        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self.timeout_seconds)
        try:
            response = await client.post(url, headers=headers, json=payload)
        except httpx.HTTPError as exc:
            raise ProviderError(
                f"DeepSeek ({self.backend_mode}) transport failure against {self.base_url}: {exc}"
            ) from exc
        finally:
            if owns_client:
                await client.aclose()

        latency_ms = round((time.perf_counter() - started) * 1000.0, 2)
        if response.status_code >= 400:
            raise ProviderError(
                f"DeepSeek ({self.backend_mode}) returned HTTP {response.status_code}."
            )

        try:
            data = response.json()
            choices = data.get("choices") or []
            content = choices[0]["message"]["content"]
            usage = data.get("usage") or {}
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise ProviderError(
                f"DeepSeek ({self.backend_mode}) returned malformed completion payload."
            ) from exc

        return InferenceResponse(
            provider_name=self.provider_name,
            backend_mode=self.backend_mode,
            model_name=str(data.get("model") or self.model_name),
            content=str(content),
            prompt_tokens=int(usage.get("prompt_tokens") or 0),
            completion_tokens=int(usage.get("completion_tokens") or 0),
            latency_ms=latency_ms,
        )

    async def health_check(self) -> dict[str, object]:
        """Probe `/models` on Ollama or DeepSeek API without leaking secrets."""
        try:
            headers = self._build_headers()
        except ProviderError as exc:
            return {
                "provider": self.provider_name,
                "backend_mode": self.backend_mode,
                "model": self.model_name,
                "configured": False,
                "reachable": False,
                "detail": str(exc),
            }

        url = f"{self.base_url}/models"
        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=min(self.timeout_seconds, 5.0))
        try:
            resp = await client.get(url, headers=headers)
            reachable = resp.status_code < 400
            return {
                "provider": self.provider_name,
                "backend_mode": self.backend_mode,
                "model": self.model_name,
                "configured": True,
                "reachable": reachable,
                "status_code": resp.status_code,
            }
        except httpx.HTTPError:
            return {
                "provider": self.provider_name,
                "backend_mode": self.backend_mode,
                "model": self.model_name,
                "configured": True,
                "reachable": False,
                "status_code": None,
            }
        finally:
            if owns_client:
                await client.aclose()
