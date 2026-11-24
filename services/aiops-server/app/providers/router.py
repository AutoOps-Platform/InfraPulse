"""P1.3: Model-Tier Routing and Cross-Provider Fallback Router (DeepSeek <-> Gemini)."""

from __future__ import annotations

import inspect

from app.config import AIOpsSettings
from app.providers.base import (
    BaseLLMProvider,
    InferenceRequest,
    InferenceResponse,
    ProviderError,
)
from app.providers.deepseek import DeepSeekProvider
from app.providers.gemini import GeminiProvider


class ProviderRouter(BaseLLMProvider):
    """Routes inference by model tier and automatically fails over between DeepSeek and Gemini."""

    def __init__(
        self,
        settings: AIOpsSettings | None = None,
        *,
        deepseek_provider: DeepSeekProvider | None = None,
        gemini_provider: GeminiProvider | None = None,
        primary_provider: BaseLLMProvider | None = None,
        fallback_provider: BaseLLMProvider | None = None,
    ) -> None:
        self.settings = settings or AIOpsSettings.from_env()
        self.deepseek_provider = deepseek_provider or DeepSeekProvider(self.settings)
        self.gemini_provider = gemini_provider or GeminiProvider(self.settings)

        if primary_provider is not None:
            self.primary_provider: BaseLLMProvider = primary_provider
            if fallback_provider is not None:
                self.fallback_provider: BaseLLMProvider | None = fallback_provider
            else:
                self.fallback_provider = (
                    self.deepseek_provider
                    if primary_provider.provider_name == "gemini"
                    else self.gemini_provider
                )
        elif self.settings.AIOPS_DEFAULT_PROVIDER == "gemini":
            self.primary_provider = self.gemini_provider
            self.fallback_provider = fallback_provider or self.deepseek_provider
        else:
            self.primary_provider = self.deepseek_provider
            self.fallback_provider = fallback_provider or self.gemini_provider

        self.last_served_provider: str | None = None
        self.last_fallback_used: bool = False

    @property
    def provider_name(self) -> str:
        return self.primary_provider.provider_name

    @property
    def model_name(self) -> str:
        return self.primary_provider.model_name

    @property
    def fallback_enabled(self) -> bool:
        return bool(getattr(self.settings, "AIOPS_ENABLE_PROVIDER_FALLBACK", True))

    @staticmethod
    def _is_provider_configured(provider: BaseLLMProvider) -> bool:
        if hasattr(provider, "is_configured"):
            return bool(provider.is_configured())
        if isinstance(provider, GeminiProvider):
            return bool(provider.settings.GEMINI_API_KEY.get_secret_value().strip())
        if isinstance(provider, DeepSeekProvider):
            if provider.backend_mode == "ollama":
                return bool(provider.settings.OLLAMA_BASE_URL.strip())
            return bool(provider.settings.DEEPSEEK_API_KEY.get_secret_value().strip())
        return True

    @staticmethod
    async def _invoke_provider(
        provider: BaseLLMProvider,
        request: InferenceRequest,
        *,
        model_tier: str | None = None,
        model_override: str | None = None,
    ) -> InferenceResponse:
        sig = inspect.signature(provider.generate)
        params = sig.parameters
        kwargs: dict[str, object] = {}
        if "model_tier" in params:
            kwargs["model_tier"] = model_tier
        if "model_override" in params:
            kwargs["model_override"] = model_override

        effective_req = request
        if model_override and request.model_override != model_override:
            effective_req = request.model_copy(update={"model_override": model_override})
        elif not kwargs and hasattr(provider, "resolve_model"):
            resolved = provider.resolve_model(
                model_tier=model_tier,
                model_override=model_override or request.model_override,
            )
            effective_req = request.model_copy(update={"model_override": resolved})

        return await provider.generate(effective_req, **kwargs)  # type: ignore[arg-type]

    async def generate(
        self,
        request: InferenceRequest,
        *,
        model_tier: str | None = None,
        model_override: str | None = None,
    ) -> InferenceResponse:
        """Route inference to primary provider with optional cross-provider fallback."""
        try:
            response = await self._invoke_provider(
                self.primary_provider,
                request,
                model_tier=model_tier,
                model_override=model_override,
            )
            self.last_served_provider = response.provider_name
            self.last_fallback_used = False
            return response
        except ProviderError as primary_exc:
            if (
                not self.fallback_enabled
                or self.fallback_provider is None
                or not self._is_provider_configured(self.fallback_provider)
            ):
                raise

            # Avoid forwarding primary-specific model_override unless explicitly requested;
            # let fallback resolve its own model for `model_tier`.
            fallback_req = request
            if model_override is None and request.model_override is not None:
                fallback_req = request.model_copy(update={"model_override": None})

            try:
                fallback_resp = await self._invoke_provider(
                    self.fallback_provider,
                    fallback_req,
                    model_tier=model_tier,
                    model_override=model_override,
                )
            except ProviderError as fallback_exc:
                raise ProviderError(
                    f"Primary provider '{self.primary_provider.provider_name}' failed ({primary_exc}); "
                    f"fallback provider '{self.fallback_provider.provider_name}' also failed ({fallback_exc})."
                ) from fallback_exc

            self.last_served_provider = fallback_resp.provider_name
            self.last_fallback_used = True
            return fallback_resp.model_copy(update={"fallback_used": True})

    async def health_check(self) -> dict[str, object]:
        """Report health of both primary and fallback providers."""
        primary_health = await self.primary_provider.health_check()
        fallback_health = (
            await self.fallback_provider.health_check()
            if self.fallback_provider is not None
            else None
        )
        configured = bool(primary_health.get("configured")) or (
            self.fallback_enabled and bool((fallback_health or {}).get("configured"))
        )
        reachable = bool(primary_health.get("reachable")) or (
            self.fallback_enabled and bool((fallback_health or {}).get("reachable"))
        )
        return {
            "provider": self.primary_provider.provider_name,
            "model": self.primary_provider.model_name,
            "configured": configured,
            "reachable": reachable,
            "fallback_enabled": self.fallback_enabled,
            "last_served_provider": self.last_served_provider,
            "primary": primary_health,
            "fallback": fallback_health,
        }
