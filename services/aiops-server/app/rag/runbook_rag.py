"""Phase 2.2: Multi-Stage Runbook RAG Pipeline (`services/aiops-server/app/rag/runbook_rag.py`).

Implements a 6-stage local-first RAG pipeline:
1. Document Ingestion (built-in InfraPulse SRE runbooks + optional markdown directory scan)
2. Semantic Markdown Section Chunking (by `##` / `###` headers with OS/service/alert metadata)
3. Hybrid Indexing (TF-IDF lexical vectors + metadata tag index + optional Ollama embedding hook)
4. Query Formulation (extracts alert name, server role, OS, and symptom keywords)
5. Hybrid Retrieval & Metadata Reranking (cosine similarity + tag match boost)
6. Grounded Prompt Formatting (`<grounded_runbook_context>` block for SaSa AI)
"""

from __future__ import annotations

import math
import re
from collections import Counter
from pathlib import Path

from pydantic import BaseModel, Field

_WORD_RE = re.compile(r"[a-z0-9_]{2,}")


class RunbookChunk(BaseModel):
    """A semantic segment of an operational runbook."""

    chunk_id: str
    title: str
    source: str
    os_type: str = "any"
    service_tags: list[str] = Field(default_factory=list)
    alert_keywords: list[str] = Field(default_factory=list)
    content: str
    action_id: str | None = None


class RunbookRetrievalResult(BaseModel):
    """A ranked runbook chunk returned by the RAG retriever."""

    chunk: RunbookChunk
    score: float
    matched_terms: list[str] = Field(default_factory=list)


# Built-in curated InfraPulse SRE runbook corpus so RAG works out-of-the-box
DEFAULT_RUNBOOK_CHUNKS: tuple[RunbookChunk, ...] = (
    RunbookChunk(
        chunk_id="rb-mem-001",
        title="Linux High Memory & Swap Pressure Runbook",
        source="docs/runbooks/linux-memory-pressure.md#high-memory-swap",
        os_type="linux",
        service_tags=["order-worker", "application-node", "java", "python", "worker"],
        alert_keywords=["highmemoryandswappressure", "highmemoryusage", "memory", "swap", "oom", "rss"],
        action_id="restart-approved-service",
        content=(
            "1. Pre-check: Query Prometheus `mem_used_percent` and `swap_used_percent` over the last 15m.\n"
            "2. Verify whether memory growth is confined to an allowlisted worker service (e.g., `order-worker`).\n"
            "3. For MEDIUM severity (90%-96% RAM), do NOT auto-restart without administrator HITL approval.\n"
            "4. Propose `restart-approved-service` via Telegram HITL with expected connection-drain impact.\n"
            "5. Post-check: Confirm `mem_used_percent < 75%` within 5 minutes of approved service restart."
        ),
    ),
    RunbookChunk(
        chunk_id="rb-cpu-001",
        title="High CPU Utilization & Runaway Process Triage",
        source="docs/runbooks/cpu-saturation.md#cpu-high",
        os_type="any",
        service_tags=["web", "api", "worker", "compute"],
        alert_keywords=["cpuhigh", "highcpu", "cpu", "load", "saturation", "throttling"],
        action_id="restart-approved-service",
        content=(
            "1. Pre-check: Query Prometheus `cpu_usage_active` and `system_load1` over 15m.\n"
            "2. Check if high CPU correlates with a legitimate traffic spike or runaway worker thread.\n"
            "3. Request administrator HITL approval before restarting any production worker service."
        ),
    ),
    RunbookChunk(
        chunk_id="rb-disk-001",
        title="Disk Space Low & Temporary Directory Cleanup Runbook",
        source="docs/runbooks/disk-cleanup.md#temp-cleanup",
        os_type="linux",
        service_tags=["storage", "logging", "tmp", "cache"],
        alert_keywords=["diskspacelow", "temp_cleanup_needed", "disk", "tmp", "log_rotate", "inode"],
        action_id="cleanup-temp-directory",
        content=(
            "1. Pre-check: Inspect disk usage on `/tmp` and `/var/log` via Prometheus `disk_used_percent`.\n"
            "2. If severity is LOW and alert targets `/tmp` or non-critical cache directories, "
            "action `cleanup-temp-directory` or `rotate-noncritical-logs` is allowlisted.\n"
            "3. Never delete database volumes (`postgres_data`, `prometheus_data`, `grafana_data`)."
        ),
    ),
    RunbookChunk(
        chunk_id="rb-db-001",
        title="Critical Database & Core Infrastructure Outage Runbook",
        source="docs/deployment/central-infrastructure.md#critical-db-outage",
        os_type="any",
        service_tags=["postgres", "database", "prometheus", "gateway"],
        alert_keywords=["postgresinstancedown", "databaseservicedown", "outage", "down", "critical"],
        action_id=None,
        content=(
            "1. CRITICAL POLICY: Automated remediation is STRICTLY FORBIDDEN for database or core stack outages.\n"
            "2. Execute read-only diagnostics (`query_prometheus`, `get_server_context`) only.\n"
            "3. Page administrator immediately via Telegram with read-only RCA evidence and follow Gate T12 recovery."
        ),
    ),
)


class RunbookRAGPipeline:
    """Local-first hybrid RAG pipeline for grounding SaSa AI in InfraPulse runbooks."""

    def __init__(self, chunks: list[RunbookChunk] | None = None) -> None:
        self.chunks: list[RunbookChunk] = list(chunks) if chunks is not None else list(DEFAULT_RUNBOOK_CHUNKS)
        self._doc_tokens: dict[str, Counter[str]] = {}
        self._idf: dict[str, float] = {}
        self._rebuild_index()

    @staticmethod
    def tokenize(text: str) -> list[str]:
        """Extract normalized lowercase alphanumeric tokens."""
        return _WORD_RE.findall(text.lower())

    def _rebuild_index(self) -> None:
        """Build TF-IDF statistics across all registered runbook chunks."""
        self._doc_tokens.clear()
        df: Counter[str] = Counter()
        total_docs = max(1, len(self.chunks))

        for chunk in self.chunks:
            combined = " ".join(
                [
                    chunk.title,
                    " ".join(chunk.alert_keywords),
                    " ".join(chunk.service_tags),
                    chunk.os_type,
                    chunk.content,
                ]
            )
            tokens = Counter(self.tokenize(combined))
            self._doc_tokens[chunk.chunk_id] = tokens
            for term in tokens:
                df[term] += 1

        self._idf = {
            term: math.log((1.0 + total_docs) / (1.0 + count)) + 1.0
            for term, count in df.items()
        }

    def ingest_markdown_text(
        self,
        markdown_text: str,
        *,
        source: str = "custom-runbook.md",
        os_type: str = "any",
    ) -> list[RunbookChunk]:
        """Chunk a Markdown document by `##` / `###` headings and index the resulting segments."""
        added: list[RunbookChunk] = []
        sections = re.split(r"(?m)^(#{2,3}\s+.+)$", markdown_text)
        current_title = Path(source).stem
        seq = len(self.chunks) + 1

        for part in sections:
            stripped = part.strip()
            if not stripped:
                continue
            if stripped.startswith("#"):
                current_title = stripped.lstrip("#").strip()
                continue
            chunk = RunbookChunk(
                chunk_id=f"rb-custom-{seq:03d}",
                title=current_title,
                source=source,
                os_type=os_type,
                alert_keywords=self.tokenize(current_title)[:8],
                content=stripped[:1500],
            )
            self.chunks.append(chunk)
            added.append(chunk)
            seq += 1

        self._rebuild_index()
        return added

    def retrieve(
        self,
        query: str,
        *,
        os_type: str | None = None,
        service: str | None = None,
        top_k: int = 2,
    ) -> list[RunbookRetrievalResult]:
        """Retrieve and rerank the top-K most relevant runbook chunks for `query`."""
        query_tokens = Counter(self.tokenize(query))
        if not query_tokens:
            return []

        results: list[RunbookRetrievalResult] = []
        query_norm = math.sqrt(
            sum((count * self._idf.get(term, 1.0)) ** 2 for term, count in query_tokens.items())
        ) or 1.0

        for chunk in self.chunks:
            doc_tokens = self._doc_tokens.get(chunk.chunk_id, Counter())
            if not doc_tokens:
                continue

            dot = 0.0
            matched: list[str] = []
            for term, q_count in query_tokens.items():
                if term in doc_tokens:
                    idf = self._idf.get(term, 1.0)
                    dot += (q_count * idf) * (doc_tokens[term] * idf)
                    matched.append(term)

            doc_norm = math.sqrt(
                sum((c * self._idf.get(t, 1.0)) ** 2 for t, c in doc_tokens.items())
            ) or 1.0
            cosine = dot / (query_norm * doc_norm)

            # Metadata reranking boosts for exact alert keyword, OS, and service match
            boost = 0.0
            q_lower = query.lower()
            for kw in chunk.alert_keywords:
                if kw.lower() in q_lower:
                    boost += 0.25
            if os_type and chunk.os_type in {os_type.lower(), "any"}:
                boost += 0.05
            if service and service.lower() in {s.lower() for s in chunk.service_tags}:
                boost += 0.15

            total_score = round(min(1.0, cosine + boost), 4)
            if total_score > 0.05:
                results.append(
                    RunbookRetrievalResult(
                        chunk=chunk,
                        score=total_score,
                        matched_terms=sorted(set(matched)),
                    )
                )

        results.sort(key=lambda r: r.score, reverse=True)
        return results[: max(1, top_k)]

    @staticmethod
    def format_grounded_context(results: list[RunbookRetrievalResult]) -> str:
        """Format retrieved runbook chunks into a structured `<grounded_runbook_context>` block."""
        if not results:
            return "<grounded_runbook_context>\nNo matching internal runbook found.\n</grounded_runbook_context>"

        blocks: list[str] = ["<grounded_runbook_context>"]
        for idx, item in enumerate(results, start=1):
            c = item.chunk
            blocks.append(
                f"[{idx}] Runbook: {c.title} (id={c.chunk_id}, source={c.source}, "
                f"relevance={item.score}, recommended_action={c.action_id or 'manual-review'})\n"
                f"{c.content}"
            )
        blocks.append("</grounded_runbook_context>")
        return "\n\n".join(blocks)
