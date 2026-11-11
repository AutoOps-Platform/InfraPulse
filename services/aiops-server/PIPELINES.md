# InfraPulse AIOps (`SaSa AI`) — Detailed Multi-Pipeline Architecture Reference

> **Purpose**: Comprehensive visual blueprint of every pipeline, sub-pipeline, and micro-task inside `services/aiops-server/`, designed for executive presentations, architectural reviews, and engineering onboarding.

---

## Pipeline 1: Master End-to-End AIOps Execution Pipeline (Executive Overview)

This diagram illustrates the complete lifecycle of an infrastructure incident from Grafana alert generation to administrator approval on Telegram (`5841901091`).

```mermaid
flowchart TD
    subgraph EXT["1. External Monitoring Plane"]
        TELEGRAF["Telegraf Agents (Linux / Windows)"] -->|"Remote Write HTTPS"| GW["FastAPI Ingestion Gateway"]
        GW -->|"Forward Metrics"| PROM["Prometheus TSDB"]
        PROM -->|"Evaluate Alert Rules"| GRAF["Grafana Alerting Engine"]
    end

    subgraph SHIELD["2. Ingress Security & Cost Shield"]
        GRAF -->|"POST /api/v1/webhooks/grafana"| AUTH["HMAC Webhook Token Check"]
        AUTH --> SAN["InputSanitizer & Injection Filter"]
        SAN --> DEDUP{"Tier-0 Fingerprint Dedup (300s Cooldown)"}
        DEDUP -->|"Duplicate Storm Event"| SUPPRESS["Suppress & Return Cached Status (0 Tokens)"]
    end

    subgraph DECISION["3. Decision & Policy Layer"]
        DEDUP -->|"New Incident"| JEV["Jev Decision Model (API or Heuristic)"]
        JEV --> GATE{"DeterministicPolicyGate"}
        GATE -->|"RESOLVED"| DONE_RES["Clear Cooldown & Close"]
        GATE -->|"LOW + Allowlisted"| ROUTE_LOW["Strategy: AUTO_EXECUTE_ALLOWLISTED"]
        GATE -->|"MEDIUM (or Unapproved Low)"| ROUTE_MED["Strategy: REQUEST_HITL_APPROVAL"]
        GATE -->|"CRITICAL"| ROUTE_CRIT["Strategy: ESCALATE_NOTIFY_ONLY (Block Auto-Exec)"]
    end

    subgraph CONTEXT["4. MCP Read-Only Diagnostics & RAG"]
        ROUTE_LOW --> CACHE{"Tier-1 Response Cache (600s TTL)"}
        ROUTE_MED --> CACHE
        ROUTE_CRIT --> CACHE
        CACHE -->|"Cache Miss"| MCP["MCPToolRegistry (Read-Only)"]
        MCP --> T_PROM["Tool: query_prometheus (Allowlisted PromQL)"]
        MCP --> T_CTX["Tool: get_server_context (OS, Role, Service)"]
        MCP --> T_RAG["Tool: search_runbook (Multi-Stage RAG)"]
    end

    subgraph INFERENCE["5. Interchangeable LLM Provider Layer (SaSa AI)"]
        T_PROM --> PROMPT["Prompt Builder (<untrusted_telemetry> + <grounded_runbook_context>)"]
        T_CTX --> PROMPT
        T_RAG --> PROMPT
        PROMPT --> ROUTER{"AIOPS_DEFAULT_PROVIDER"}
        ROUTER -->|"DEEPSEEK_MODE=api"| DS_API["DeepSeek Cloud API (deepseek-chat / flash)"]
        ROUTER -->|"DEEPSEEK_MODE=ollama"| OLLAMA["Local Ollama (deepseek-r1:latest)"]
        ROUTER -->|"gemini"| GEMINI["Gemini API"]
        DS_API --> PARSE["JSON Extractor & RCAReport Schema Validator"]
        OLLAMA --> PARSE
        GEMINI --> PARSE
    end

    subgraph HITL["6. Telegram ChatOps & Human-in-the-Loop (Admin: 5841901091)"]
        PARSE --> TG["TelegramHITLService"]
        CACHE -->|"Cache Hit"| TG
        TG -->|"MEDIUM"| TG_BTN["Send RCA Card + Inline Buttons (Approve / Reject)"]
        TG -->|"CRITICAL"| TG_PAGE["Send Urgent Page + Read-Only RCA (No Buttons)"]
        TG -->|"LOW"| TG_INFO["Send Auto-Execution Summary"]
        TG_BTN -->|"POST /api/v1/integrations/telegram/webhook"| CB_VERIFY["Verify Admin ID 5841901091 + TTL + Idempotency"]
    end
```

---

## Pipeline 2: Ingress Security, Prompt-Injection Guardrails & Alert-Storm Cost Shield

Shows how `aiops-server` protects against malicious log/label payloads and prevents API budget exhaustion during cascading infrastructure failures.

```mermaid
flowchart LR
    subgraph INGRESS["Incoming Webhook Request"]
        RAW["AlertWebhookPayload JSON"] --> HMAC{"X-AIOps-Webhook-Token Configured?"}
        HMAC -->|"Mismatch"| REJ_401["HTTP 401 Unauthorized"]
        HMAC -->|"Valid or Open Lab"| LEN_CHK{"Field Length <= 4096 chars?"}
    end

    subgraph GUARD["Step 6: InputSanitizer (app/guardrails/sanitizer.py)"]
        LEN_CHK -->|"Exceeded"| REJ_400A["HTTP 400 GuardrailViolationError"]
        LEN_CHK -->|"OK"| REGEX_CHK{"Scan Against _INJECTION_PATTERNS"}
        REGEX_CHK -->|"Matches 'ignore instructions', 'rm -rf', 'curl | sh'"| REJ_400B["HTTP 400 Prompt Injection Blocked"]
        REGEX_CHK -->|"Clean"| WRAP["Wrap Raw Telemetry in <untrusted_telemetry> Tags"]
    end

    subgraph STORM["Step 7: Two-Tier Cost Shield (app/guardrails/dedup.py)"]
        WRAP --> FP["Compute SHA-256 Fingerprint (alertname + server_id + service + severity)"]
        FP --> DEDUP_CHK{"In AlertDeduplicator Cooldown (300s)?"}
        DEDUP_CHK -->|"Yes (Alert Storm)"| RET_SUPP["Skip Jev & LLM -> Return Suppressed Result"]
        DEDUP_CHK -->|"No"| CACHE_CHK{"In ResponseCache TTL (600s)?"}
        CACHE_CHK -->|"Yes (Recurring Fault)"| RET_CACHE["Reuse Validated RCAReport (0 LLM Tokens)"]
        CACHE_CHK -->|"No"| NEXT_STAGE["Proceed to MCP + RAG + LLM"]
    end
```

---

## Pipeline 3: Dual-Layer Decision Engine (`Jev` Model + `DeterministicPolicyGate`)

Illustrates why the **Decision Layer** is decoupled from the **LLM Provider Layer** and how deterministic safety rules override model suggestions when necessary.

```mermaid
flowchart TD
    EVENT["JevDecisionRequest (fingerprint, server_id, alert_name, declared_severity)"] --> MODE{"JEV_MODE Resolution"}

    subgraph JEV_LAYER["Layer A: Jev Decision Model (app/decision/jev_client.py)"]
        MODE -->|"api (or auto with reachable endpoint)"| JEV_HTTP["POST JEV_API_URL (Bearer JEV_API_KEY)"]
        JEV_HTTP -->|"HTTP 200"| JEV_OUT["JevDecisionResponse (severity, confidence, candidate_action_id)"]
        JEV_HTTP -->|"Timeout / Error in 'auto' mode"| JEV_HEUR["Fallback: evaluate_heuristic()"]
        MODE -->|"heuristic (or auto without server)"| JEV_HEUR
        JEV_HEUR --> JEV_OUT
    end

    subgraph POLICY_LAYER["Layer B: Hard Safety Gate (app/decision/policy_gate.py)"]
        JEV_OUT --> STATUS_CHK{"Alert Status == RESOLVED?"}
        STATUS_CHK -->|"Yes"| POL_RES["NO_ACTION_RESOLVED (allow_auto=False, rca=False)"]
        STATUS_CHK -->|"No (FIRING)"| SEV_CHK{"Jev Severity Classification"}

        SEV_CHK -->|"CRITICAL"| POL_CRIT["ESCALATE_NOTIFY_ONLY (allow_auto=False, requires_hitl=True, run_readonly_rca=True)"]
        SEV_CHK -->|"MEDIUM"| POL_MED["REQUEST_HITL_APPROVAL (allow_auto=False, requires_hitl=True, run_readonly_rca=True)"]
        SEV_CHK -->|"LOW"| ALLOW_CHK{"candidate_action_id in ALLOWLISTED_LOW_RISK_ACTIONS?"}

        ALLOW_CHK -->|"Yes (e.g. cleanup-temp-directory)"| POL_LOW_OK["AUTO_EXECUTE_ALLOWLISTED (allow_auto=True, requires_hitl=False)"]
        ALLOW_CHK -->|"No (Unapproved Action)"| POL_DOWNGRADE["Downgrade to REQUEST_HITL_APPROVAL (allow_auto=False, requires_hitl=True)"]
    end
```

---

## Pipeline 4: Multi-Stage RAG — Stage A (Offline Runbook Ingestion, Chunking & Indexing)

Details how internal Markdown documentation (`docs/deployment/`, `docs/runbooks/`) is transformed into a searchable hybrid index inside `app/rag/runbook_rag.py`.

```mermaid
flowchart LR
    subgraph SOURCES["1. Knowledge Sources"]
        BUILTIN["Built-in SRE Runbooks (Memory, CPU, Disk, DB Outage)"]
        MD_DOCS["Custom Markdown Runbooks (docs/runbooks/*.md)"]
    end

    subgraph CHUNKER["2. Semantic Markdown Splitter"]
        MD_DOCS --> REGEX_SPLIT["Split by Markdown Headings (## and ###)"]
        REGEX_SPLIT --> META_EXT["Extract Section Title, OS Type, Service Tags & Action Slug"]
        BUILTIN --> META_EXT
    end

    subgraph INDEXER["3. Hybrid Lexical & Vector Indexer"]
        META_EXT --> TOKENIZE["Regex Tokenizer (_WORD_RE: lowercase alphanumeric >= 2 chars)"]
        TOKENIZE --> TF["Compute Term Frequency Counter per Chunk"]
        TF --> IDF["Compute Smoothed Inverse Document Frequency: log((1 + N) / (1 + df)) + 1"]
        IDF --> INDEX_STORE["In-Memory Hybrid Runbook Index (Ready for Sub-Millisecond Retrieval)"]
    end
```

---

## Pipeline 5: Multi-Stage RAG — Stage B (Online Query, Metadata Reranking & Prompt Grounding)

Details how an incoming alert queries the RAG pipeline, applies domain-specific metadata boosts, and injects grounded context into the **SaSa AI** prompt.

```mermaid
flowchart TD
    ALERT_IN["Incoming Alert (alert_name + summary + description + labels)"] --> Q_BUILD["1. Query Builder: Concatenate Alert Name & Symptom Annotations"]
    Q_BUILD --> Q_VEC["2. Query Vectorizer: Tokenize & Weight by Corpus IDF"]

    subgraph RETRIEVAL["3. Cosine Similarity + Metadata Reranker"]
        Q_VEC --> COS["Compute TF-IDF Cosine Similarity Against All Runbook Chunks"]
        COS --> BOOST_KW["+0.25 Boost per Matched Alert Keyword (e.g. 'highmemoryandswappressure', 'swap')"]
        BOOST_KW --> BOOST_OS["+0.05 Boost for Matching OS Type (linux / windows / any)"]
        BOOST_OS --> BOOST_SVC["+0.15 Boost for Matching Service Tag (e.g. 'order-worker')"]
        BOOST_SVC --> CLAMP["Clamp Total Score to [0.0, 1.0] & Filter Score > 0.05"]
    end

    subgraph GROUNDING["4. Grounded Context Formatter"]
        CLAMP --> TOP_K["Sort Descending & Select Top-K Chunks (default K=2)"]
        TOP_K --> XML_WRAP["Wrap in <grounded_runbook_context> Tags with Source Citations & Action IDs"]
        XML_WRAP --> LLM_INJECT["Inject into build_rca_user_prompt() for SaSa AI"]
    end
```

---

## Pipeline 6: Model Context Protocol (MCP) Read-Only Diagnostic Tool Pipeline

Shows how `MCPToolRegistry` (`app/tools/mcp_tools.py`) executes strictly bounded, read-only diagnostic queries while preventing arbitrary metric or command access.

```mermaid
flowchart TD
    ORCH["SaSaAgent Stage 6: Diagnostic Collection"] --> REG["MCPToolRegistry (app/tools/mcp_tools.py)"]

    subgraph TOOL_1["Tool 1: query_prometheus"]
        REG --> PROM_SAN["Sanitize metric & server_id"]
        PROM_SAN --> PROM_ALLOW{"metric in ALLOWLISTED_PROMQL_METRICS?"}
        PROM_ALLOW -->|"No"| PROM_ERR["Reject: ValueError (Blocked Unapproved Metric)"]
        PROM_ALLOW -->|"Yes"| PROM_HTTP["GET Prometheus /api/v1/query (Bounded 1..60m Window)"]
        PROM_HTTP -->|"200 OK"| PROM_LIVE["Return Live Time-Series Vector"]
        PROM_HTTP -->|"Offline in Local Lab"| PROM_FALL["Return Validated Telemetry Snapshot Fallback"]
    end

    subgraph TOOL_2["Tool 2: get_server_context"]
        REG --> CTX_SAN["Sanitize server_id"]
        CTX_SAN --> CTX_LOOKUP["Resolve OS, Environment, Role & Allowlisted Actions"]
    end

    subgraph TOOL_3["Tool 3: search_runbook"]
        REG --> RAG_CALL["Invoke RunbookRAGPipeline.retrieve(top_k=2)"]
        RAG_CALL --> RAG_FMT["Return <grounded_runbook_context> Block"]
    end

    subgraph TOOL_4["Tool 4: query_logs"]
        REG --> LOG_SAN["Inspect Log Text via InputSanitizer"]
        LOG_SAN --> LOG_WRAP["Isolate Inside <untrusted_telemetry> Tags"]
    end

    PROM_LIVE --> BUNDLE["Combined Diagnostic Context for LLM"]
    PROM_FALL --> BUNDLE
    CTX_LOOKUP --> BUNDLE
    RAG_FMT --> BUNDLE
    LOG_WRAP --> BUNDLE
```

---

## Pipeline 7: Multi-Provider LLM Inference & Resilient RCA Fallback Pipeline

Details how **SaSa AI** communicates with **DeepSeek Cloud API**, **Local Ollama**, or **Gemini**, strips reasoning tags (`<think>`), validates the JSON output, and guarantees 100% uptime via deterministic fallback.

```mermaid
flowchart TD
    PROMPT_IN["Assembled System Prompt + Isolated User Prompt + RAG Context"] --> PROV_SEL{"Provider Selection"}

    subgraph PROVIDERS["Interchangeable LLM Providers (app/providers/)"]
        PROV_SEL -->|"deepseek + DEEPSEEK_MODE=api"| DS_CLOUD["POST https://api.deepseek.com/v1/chat/completions (Bearer DEEPSEEK_API_KEY)"]
        PROV_SEL -->|"deepseek + DEEPSEEK_MODE=ollama"| DS_LOCAL["POST http://localhost:11434/v1/chat/completions (Local Ollama)"]
        PROV_SEL -->|"gemini"| GEM_CLOUD["POST Gemini OpenAI-Compatible Endpoint (Bearer GEMINI_API_KEY)"]
    end

    DS_CLOUD --> HTTP_CHK{"HTTP Status < 400?"}
    DS_LOCAL --> HTTP_CHK
    GEM_CLOUD --> HTTP_CHK

    subgraph PARSER["Output Sanitization & Schema Validation"]
        HTTP_CHK -->|"Yes"| STRIP_THINK["Strip Optional <think>...</think> Reasoning Blocks & Markdown Fences"]
        STRIP_THINK --> JSON_PARSE["Extract JSON Object & Validate Against Pydantic RCAReport"]
        JSON_PARSE -->|"Valid Schema"| RCA_OK["Verified RCAReport + Token/Latency Telemetry"]
    end

    subgraph FALLBACK["High-Availability Resilience (INTRODUCT.md 16.1)"]
        HTTP_CHK -->|"Timeout / 5xx Error"| DET_FALL[" _build_fallback_rca(): Deterministic Structured RCA Report"]
        JSON_PARSE -->|"Malformed JSON"| DET_FALL
        DET_FALL --> RCA_OK
    end
```

---

## Pipeline 8: Telegram ChatOps & Human-in-the-Loop (HITL) Sequence (`Admin ID: 5841901091`)

Sequence diagram showing the exact interaction between `SaSaAgent`, `TelegramHITLService`, the Telegram Bot API, and Administrator `5841901091`.

```mermaid
sequenceDiagram
    autonumber
    participant G as Grafana Alerting
    participant S as SaSaAgent (aiops-server)
    participant T as TelegramHITLService
    participant B as Telegram Bot API
    participant A as Administrator (ID: 5841901091)

    G->>S: POST /api/v1/webhooks/grafana (Alert Firing)
    S->>S: Sanitize -> Dedup -> Jev -> Policy Gate -> MCP + RAG -> DeepSeek RCA
    S->>T: notify_and_request_approval(alert, policy, rca_report)
    alt Strategy == REQUEST_HITL_APPROVAL (Medium Severity)
        T->>T: Create ApprovalRecord (approval_id, ttl=900s, status=PENDING)
        T->>T: Build Inline Keyboard [Approve] / [Reject]
    else Strategy == ESCALATE_NOTIFY_ONLY (Critical Severity)
        T->>T: Format Urgent Escalation + Read-Only RCA (No Auto-Exec Buttons)
    end
    T->>B: POST /bot<TOKEN>/sendMessage (chat_id=5841901091)
    B-->>A: Deliver Incident Card & Inline Buttons on Telegram
    A->>B: Click [Approve] or [Reject] Button
    B->>S: POST /api/v1/integrations/telegram/webhook (callback_query)
    S->>T: process_callback(chat_id, user_id, callback_id, data)
    T->>T: 1. Verify chat_id == 5841901091 & user_id == 5841901091
    T->>T: 2. Check callback_id Not in _processed_callbacks (Idempotency)
    T->>T: 3. Check ApprovalRecord Status == PENDING & Not Expired (TTL <= 900s)
    T-->>S: Return Updated ApprovalRecord (status=APPROVED / REJECTED)
    S-->>B: HTTP 200 OK (Decision Recorded & Audited)
```

---

## Pipeline 9: Incident & HITL Approval Lifecycle State Machine

State diagram illustrating all legal state transitions for an incident inside `aiops-server`.

```mermaid
stateDiagram-v2
    [*] --> OPEN: Webhook Received & Validated
    OPEN --> SUPPRESSED: Duplicate Fingerprint in Cooldown Window
    SUPPRESSED --> [*]

    OPEN --> INVESTIGATING: Jev Decision + MCP Read-Only Tools + RAG
    INVESTIGATING --> AUTO_EXECUTING: LOW Severity + Allowlisted Action
    INVESTIGATING --> PENDING_APPROVAL: MEDIUM Severity (Sent to Telegram 5841901091)
    INVESTIGATING --> ESCALATED_READONLY: CRITICAL Severity (Immediate Admin Page + Read-Only RCA)

    PENDING_APPROVAL --> APPROVED: Admin 5841901091 Clicks Approve Within 15m TTL
    PENDING_APPROVAL --> REJECTED: Admin 5841901091 Clicks Reject
    PENDING_APPROVAL --> EXPIRED: No Response Within 15m TTL (Default Safe No-Op)

    AUTO_EXECUTING --> RESOLVED: Action Completed & Verified
    APPROVED --> RESOLVED: Approved Action Executed
    REJECTED --> [*]
    EXPIRED --> [*]
    ESCALATED_READONLY --> [*]
    RESOLVED --> [*]
```

---

## Pipeline 10: Loop Engineering Development & Verification Governance Pipeline

Shows how our **Loop Engineering** system (`STATE.md`, `daily-triage`, `maker-checker`, and `loop-state-sync`) governs every code change on the `AgentModels` branch.

```mermaid
flowchart LR
    subgraph STAGE_1["1. Pre-Flight Context Load"]
        READ_STATE["Read STATE.md & AGENTS.md"] --> TRIAGE["Run daily-triage Skill (L1 Report-Only)"]
        TRIAGE --> LOG_N["Write Sequential Log: docs/Loop-run-log/loop-run-log<N>.md"]
    end

    subgraph STAGE_2["2. Bounded Maker Implementation"]
        LOG_N --> MAKER["Implement Scoped Changes in services/aiops-server/ (Branch: AgentModels)"]
        MAKER --> PYTEST["Run Automated Pytest Suite & Live Smoke Tests"]
    end

    subgraph STAGE_3["3. Independent Checker Audit"]
        PYTEST --> CHECKER["Invoke Read-Only 'research' Subagent (maker-checker Skill)"]
        CHECKER --> AUDIT{"Audit: Zero Secrets? Scope Isolated? Contract Pass?"}
        AUDIT -->|"FAIL"| MAKER
    end

    subgraph STAGE_4["4. Durable State Persistence"]
        AUDIT -->|"PASS"| SYNC["Run loop-state-sync Skill"]
        SYNC --> UPD_STATE["Update STATE.md Verified Baseline & Next Queue"]
        UPD_STATE --> LOG_NEXT["Write Next Sequential Log: docs/Loop-run-log/loop-run-log<N+1>.md"]
    end
```
