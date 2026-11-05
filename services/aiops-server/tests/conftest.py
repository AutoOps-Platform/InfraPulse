"""Shared pytest fixtures for `services/aiops-server/`."""

from __future__ import annotations

import pytest
from pydantic import SecretStr

from app.config import AIOpsSettings


@pytest.fixture
def isolated_settings() -> AIOpsSettings:
    """Return isolated test settings that never read real secrets from disk."""
    return AIOpsSettings(
        AIOPS_ENV="test",
        DEEPSEEK_MODE="ollama",
        DEEPSEEK_API_KEY=SecretStr(""),
        OLLAMA_BASE_URL="http://localhost:11434/v1",
        OLLAMA_MODEL="deepseek-r1:latest",
        JEV_MODE="heuristic",
        JEV_API_URL="http://localhost:8090/v1/decision/evaluate",
        JEV_API_KEY=SecretStr(""),
        AIOPS_DEDUP_COOLDOWN_SECONDS=300,
        AIOPS_CACHE_TTL_SECONDS=600,
    )
