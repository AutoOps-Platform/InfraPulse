"""Tests for environment configuration and secret masking."""

from __future__ import annotations

from pathlib import Path

from pydantic import SecretStr

from app.config import AIOpsSettings


def test_secret_fields_are_masked_in_repr() -> None:
    settings = AIOpsSettings(
        DEEPSEEK_API_KEY=SecretStr("sk-test-deepseek-placeholder"),
        JEV_API_KEY=SecretStr("jev-test-placeholder"),
        GEMINI_API_KEY=SecretStr("gem-test-placeholder"),
    )
    rendered = repr(settings)
    assert "sk-test-deepseek-placeholder" not in rendered
    assert "jev-test-placeholder" not in rendered
    assert "gem-test-placeholder" not in rendered


def test_resolved_backends_in_auto_mode() -> None:
    without_keys = AIOpsSettings(
        DEEPSEEK_MODE="auto",
        DEEPSEEK_API_KEY=SecretStr(""),
        JEV_MODE="auto",
        JEV_API_KEY=SecretStr(""),
    )
    assert without_keys.resolved_deepseek_backend() == "ollama"
    assert without_keys.resolved_jev_backend() == "heuristic"

    with_keys = AIOpsSettings(
        DEEPSEEK_MODE="auto",
        DEEPSEEK_API_KEY=SecretStr("sk-placeholder-value"),
        JEV_MODE="auto",
        JEV_API_KEY=SecretStr("jev-placeholder-value"),
        JEV_API_URL="https://jev.internal/v1/decision/evaluate",
    )
    assert with_keys.resolved_deepseek_backend() == "api"
    assert with_keys.resolved_jev_backend() == "api"


def test_dotenv_template_has_no_hardcoded_secrets() -> None:
    env_example = Path(__file__).resolve().parents[1] / ".env.example"
    assert env_example.is_file()
    content = env_example.read_text(encoding="utf-8")
    for secret_key in ("DEEPSEEK_API_KEY=", "JEV_API_KEY=", "GEMINI_API_KEY=", "TELEGRAM_BOT_TOKEN="):
        assert secret_key in content
        for line in content.splitlines():
            if line.startswith(secret_key):
                assert line.partition("=")[2].strip() == ""
