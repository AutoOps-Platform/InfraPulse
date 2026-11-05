"""Task 1 Tests: DeepSeek Cloud API and Ollama Local Inference Integration."""

from __future__ import annotations

import json
import os

import httpx
import pytest
from pydantic import SecretStr

from app.config import AIOpsSettings
from app.providers.base import InferenceRequest, ProviderError
from app.providers.deepseek import DeepSeekProvider


@pytest.mark.asyncio
async def test_deepseek_ollama_local_inference() -> None:
    """Verify DeepSeekProvider sends OpenAI-compatible requests to local Ollama."""
    captured_requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured_requests.append(request)
        return httpx.Response(
            status_code=200,
            json={
                "model": "deepseek-r1:latest",
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": json.dumps(
                                {
                                    "summary": "High CPU on srv-linux-01 caused by runaway worker",
                                    "evidence": ["cpu_usage=98%"],
                                    "possible_causes": ["Worker loop"],
                                    "recommended_action_id": "restart-approved-service",
                                    "risk_level": "medium",
                                    "confidence": 0.91,
                                    "requires_approval": True,
                                }
                            ),
                        }
                    }
                ],
                "usage": {"prompt_tokens": 120, "completion_tokens": 64},
            },
        )

    settings = AIOpsSettings(
        DEEPSEEK_MODE="ollama",
        OLLAMA_BASE_URL="http://localhost:11434/v1",
        OLLAMA_MODEL="deepseek-r1:latest",
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        provider = DeepSeekProvider(settings, http_client=client)
        result = await provider.generate(
            InferenceRequest(
                system_prompt="You are SaSa AI.",
                user_prompt="Analyze CPU alert on srv-linux-01.",
            )
        )

    assert len(captured_requests) == 1
    assert str(captured_requests[0].url) == "http://localhost:11434/v1/chat/completions"
    assert result.provider_name == "deepseek"
    assert result.backend_mode == "ollama"
    assert result.model_name == "deepseek-r1:latest"
    assert result.prompt_tokens == 120
    assert result.completion_tokens == 64
    assert "srv-linux-01" in result.content


@pytest.mark.asyncio
async def test_deepseek_cloud_api_inference_with_env_key() -> None:
    """Verify DeepSeekProvider uses DEEPSEEK_API_KEY and DeepSeek V4.1 Flash in API mode."""
    captured_headers: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured_headers.update(dict(request.headers))
        return httpx.Response(
            status_code=200,
            json={
                "model": "deepseek-v4.1-flash",
                "choices": [{"message": {"content": '{"summary": "DeepSeek API ok"}'}}],
                "usage": {"prompt_tokens": 50, "completion_tokens": 20},
            },
        )

    settings = AIOpsSettings(
        DEEPSEEK_MODE="api",
        DEEPSEEK_API_KEY=SecretStr("test-env-key-do-not-commit"),
        DEEPSEEK_BASE_URL="https://api.deepseek.com/v1",
        DEEPSEEK_MODEL="deepseek-v4.1-flash",
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        provider = DeepSeekProvider(settings, http_client=client)
        result = await provider.generate(
            InferenceRequest(
                system_prompt="System prompt",
                user_prompt="Test DeepSeek V4.1 Flash",
            )
        )

    assert captured_headers.get("authorization") == "Bearer test-env-key-do-not-commit"
    assert result.backend_mode == "api"
    assert result.model_name == "deepseek-v4.1-flash"


@pytest.mark.asyncio
async def test_deepseek_api_mode_rejects_missing_key() -> None:
    """Verify API mode raises ProviderError when DEEPSEEK_API_KEY is empty."""
    settings = AIOpsSettings(
        DEEPSEEK_MODE="api",
        DEEPSEEK_API_KEY=SecretStr(""),
    )
    provider = DeepSeekProvider(settings)
    with pytest.raises(ProviderError, match="DEEPSEEK_API_KEY"):
        await provider.generate(
            InferenceRequest(system_prompt="sys", user_prompt="user")
        )


@pytest.mark.live
@pytest.mark.skipif(
    os.environ.get("AIOPS_RUN_LIVE_TESTS") != "1",
    reason="Set AIOPS_RUN_LIVE_TESTS=1 to run live Ollama / DeepSeek API connectivity tests.",
)
@pytest.mark.asyncio
async def test_live_deepseek_connectivity() -> None:
    """Opt-in live test for checking real Ollama or DeepSeek API connectivity."""
    provider = DeepSeekProvider(AIOpsSettings.from_env())
    health = await provider.health_check()
    assert health["configured"] is True
    assert health["reachable"] is True
