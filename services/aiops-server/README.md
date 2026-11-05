# InfraPulse AIOps Server (`services/aiops-server/`) — SaSa AI

Dedicated AI Agent backend service for **InfraPulse** on the `AgentModels` branch.

## Overview

`aiops-server` powers **SaSa AI**, handling:
1. **Alert Webhook Ingestion & Storm Deduplication:** Validates Grafana alert webhooks (`POST /api/v1/webhooks/grafana`), blocks prompt injection, and deduplicates repeated firing alerts by fingerprint.
2. **Task 1 — Interchangeable LLM Providers (`app/providers/`):**
   - **DeepSeek Local via Ollama:** Connects to `OLLAMA_BASE_URL` (`http://localhost:11434/v1`) for `deepseek-r1:latest` or `deepseek-v4.1-flash`.
   - **DeepSeek Cloud API:** Connects to `DEEPSEEK_BASE_URL` (`https://api.deepseek.com/v1`) using `DEEPSEEK_API_KEY`.
   - **Gemini API:** Optional adapter using `GEMINI_API_KEY`.
3. **Task 2 — `Jev` Decision Model & Deterministic Policy Gate (`app/decision/`):**
   - Evaluates incoming incidents via `JevDecisionClient` (`JEV_API_URL` & `JEV_API_KEY`, with a local `heuristic` fallback mode).
   - Enforces hard safety boundaries (`Low` allowlisted execution, `Medium` Human-in-the-Loop approval, and `Critical` immediate escalation + read-only RCA).

---

## Quick Start (Inserting Your API Keys & Testing)

1. **Create your local `.env` (gitignored):**
   ```powershell
   Set-Location services/aiops-server
   Copy-Item .env.example .env
   ```
2. **Configure your credentials inside `services/aiops-server/.env`:**
   - **For Local Ollama:** Keep `DEEPSEEK_MODE=ollama` and set `OLLAMA_MODEL=deepseek-r1:latest` (or `deepseek-v4.1-flash`).
   - **For DeepSeek Cloud API:** Set `DEEPSEEK_MODE=api` and fill in `DEEPSEEK_API_KEY=<your-key>`.
   - **For Jev Decision Model API:** Set `JEV_MODE=api` and fill in `JEV_API_URL` and `JEV_API_KEY=<your-key>`.
3. **Run Unit & Integration Tests (No Live Keys Required):**
   ```powershell
   uv run pytest -q
   ```
4. **Run Live Connectivity Check (After Adding Keys / Starting Ollama):**
   ```powershell
   python scripts/verify_providers.py
   # Or run opt-in live pytest cases:
   $env:AIOPS_RUN_LIVE_TESTS = "1"
   uv run pytest -m live -q
   ```
