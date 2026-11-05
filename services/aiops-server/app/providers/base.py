"""Abstract LLM Provider interface for decoupling SaSa AI from specific model vendors."""

from __future__ import annotations

from abc import ABC, abstractmethod

from pydantic import BaseModel, Field


class ProviderError(RuntimeError):
    """Raised when an LLM provider fails configuration, authentication, or inference."""


class InferenceRequest(BaseModel):
    """Normalized request payload sent to any LLM provider."""

    system_prompt: str
    user_prompt: str
    temperature: float = Field(default=0.1, ge=0.0, le=2.0)
    max_tokens: int = Field(default=1024, ge=1, le=16384)
    response_json: bool = True


class InferenceResponse(BaseModel):
    """Normalized response returned by any LLM provider."""

    provider_name: str
    backend_mode: str
    model_name: str
    content: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    latency_ms: float = 0.0


class BaseLLMProvider(ABC):
    """Abstract base class for interchangeable LLM inference providers."""

    @property
    @abstractmethod
    def provider_name(self) -> str:
        """Unique provider identifier (e.g., `deepseek`, `gemini`)."""

    @property
    @abstractmethod
    def model_name(self) -> str:
        """Configured foundation model identifier."""

    @abstractmethod
    async def generate(self, request: InferenceRequest) -> InferenceResponse:
        """Execute a chat completion / inference request and return a normalized response."""

    @abstractmethod
    async def health_check(self) -> dict[str, object]:
        """Verify provider configuration and endpoint reachability."""
