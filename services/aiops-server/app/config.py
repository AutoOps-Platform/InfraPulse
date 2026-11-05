"""Environment-based configuration for InfraPulse AIOps Server (SaSa AI).

All API keys and tokens are loaded from environment variables (or a local,
gitignored `.env` file) and wrapped in `SecretStr` so they are never exposed
in logs, tracebacks, or string representations.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, SecretStr

try:
    from pydantic_settings import BaseSettings, SettingsConfigDict

    _HAS_PYDANTIC_SETTINGS = True
except ImportError:  # pragma: no cover - graceful fallback if pydantic-settings isn't installed
    _HAS_PYDANTIC_SETTINGS = False


def _load_dotenv_file(dotenv_path: Path) -> dict[str, str]:
    """Minimal safe parser for local `.env` files when needed."""
    values: dict[str, str] = {}
    if not dotenv_path.is_file():
        return values
    for raw_line in dotenv_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
            val = val[1:-1]
        if key:
            values[key] = val
    return values


class AIOpsSettings(BaseSettings if _HAS_PYDANTIC_SETTINGS else BaseModel):  # type: ignore[misc]
    """Centralized, secret-safe settings for `services/aiops-server/`."""

    if _HAS_PYDANTIC_SETTINGS:
        model_config = SettingsConfigDict(
            env_file=".env",
            env_file_encoding="utf-8",
            extra="ignore",
            case_sensitive=True,
        )

    # Service identity & runtime
    AIOPS_ENV: Literal["development", "lab", "test", "production"] = "development"
    AIOPS_SERVICE_NAME: str = "infrapulse-aiops-server"
    AIOPS_AGENT_NAME: str = "SaSa AI"
    AIOPS_HOST: str = "127.0.0.1"
    AIOPS_PORT: int = Field(default=8001, ge=1, le=65535)
    AIOPS_WEBHOOK_SECRET: SecretStr = Field(default=SecretStr(""))

    # Alert Storm & Response Cache Controls (Step 7)
    AIOPS_DEDUP_COOLDOWN_SECONDS: int = Field(default=300, ge=0, le=86400)
    AIOPS_CACHE_TTL_SECONDS: int = Field(default=600, ge=0, le=86400)
    AIOPS_MAX_CACHE_ENTRIES: int = Field(default=512, ge=1, le=10000)

    # Task 1: DeepSeek & Ollama Provider Settings
    AIOPS_DEFAULT_PROVIDER: Literal["deepseek", "gemini"] = "deepseek"
    DEEPSEEK_MODE: Literal["ollama", "api", "auto"] = "ollama"
    DEEPSEEK_API_KEY: SecretStr = Field(default=SecretStr(""))
    DEEPSEEK_BASE_URL: str = "https://api.deepseek.com/v1"
    DEEPSEEK_MODEL: str = "deepseek-v4.1-flash"
    DEEPSEEK_TIMEOUT_SECONDS: float = Field(default=30.0, gt=0.0, le=300.0)

    OLLAMA_BASE_URL: str = "http://localhost:11434/v1"
    OLLAMA_MODEL: str = "deepseek-r1:latest"
    OLLAMA_TIMEOUT_SECONDS: float = Field(default=60.0, gt=0.0, le=600.0)

    # Task 2: Jev Decision Model Settings
    JEV_MODE: Literal["api", "heuristic", "auto"] = "auto"
    JEV_API_URL: str = "http://localhost:8090/v1/decision/evaluate"
    JEV_API_KEY: SecretStr = Field(default=SecretStr(""))
    JEV_MODEL: str = "jev-decision-v1"
    JEV_TIMEOUT_SECONDS: float = Field(default=10.0, gt=0.0, le=120.0)

    # Optional Gemini Provider Settings
    GEMINI_API_KEY: SecretStr = Field(default=SecretStr(""))
    GEMINI_BASE_URL: str = "https://generativelanguage.googleapis.com/v1beta/openai"
    GEMINI_MODEL: str = "gemini-2.5-flash"
    GEMINI_TIMEOUT_SECONDS: float = Field(default=30.0, gt=0.0, le=300.0)

    # Optional Telegram HITL Settings
    TELEGRAM_BOT_TOKEN: SecretStr = Field(default=SecretStr(""))
    TELEGRAM_ADMIN_CHAT_ID: str = ""

    # Opt-in live connectivity test flag
    AIOPS_RUN_LIVE_TESTS: bool = False

    @classmethod
    def from_env(cls, dotenv_path: Path | None = None, **overrides: object) -> AIOpsSettings:
        """Load settings from environment variables (and optional `.env` file)."""
        if _HAS_PYDANTIC_SETTINGS and dotenv_path is None:
            return cls(**overrides)

        merged: dict[str, object] = {}
        file_vars = _load_dotenv_file(dotenv_path or Path(".env"))
        for field_name in cls.model_fields:
            if field_name in overrides:
                merged[field_name] = overrides[field_name]
            elif field_name in os.environ:
                merged[field_name] = os.environ[field_name]
            elif field_name in file_vars:
                merged[field_name] = file_vars[field_name]
        return cls(**merged)

    def resolved_deepseek_backend(self) -> Literal["ollama", "api"]:
        """Resolve whether DeepSeek uses the Cloud API or Local Ollama."""
        if self.DEEPSEEK_MODE == "api":
            return "api"
        if self.DEEPSEEK_MODE == "ollama":
            return "ollama"
        return "api" if bool(self.DEEPSEEK_API_KEY.get_secret_value().strip()) else "ollama"

    def resolved_jev_backend(self) -> Literal["api", "heuristic"]:
        """Resolve whether Jev uses the remote Decision Model API or local heuristic."""
        if self.JEV_MODE == "api":
            return "api"
        if self.JEV_MODE == "heuristic":
            return "heuristic"
        has_key = bool(self.JEV_API_KEY.get_secret_value().strip())
        has_url = bool(self.JEV_API_URL.strip())
        return "api" if (has_key and has_url) else "heuristic"
