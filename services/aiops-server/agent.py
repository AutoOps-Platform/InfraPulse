
from __future__ import annotations

import os
from datetime import datetime

from app.agent.sasa_agent import SaSaAgent
from app.config import AIOpsSettings
from app.decision.jev_client import JevDecisionClient
from app.providers.deepseek import DeepSeekProvider

try:
    from pydantic_ai import Agent
    from pydantic_ai.models.ollama import OllamaModel
    from pydantic_ai.providers.ollama import OllamaProvider

    _settings = AIOpsSettings.from_env()
    model = OllamaModel(
        _settings.OLLAMA_MODEL,
        provider=OllamaProvider(base_url=_settings.OLLAMA_BASE_URL),
    )
except ImportError:  
    Agent = None  
    OllamaModel = None  
    OllamaProvider = None  
    model = None


def create_sasa_agent(settings: AIOpsSettings | None = None) -> SaSaAgent:
    """Instantiate the full SaSa AI orchestrator with configured providers."""
    return SaSaAgent(settings=settings)


__all__ = [
    "Agent",
    "DeepSeekProvider",
    "JevDecisionClient",
    "OllamaModel",
    "OllamaProvider",
    "SaSaAgent",
    "create_sasa_agent",
    "datetime",
    "model",
    "os",
]
