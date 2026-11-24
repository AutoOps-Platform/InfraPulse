"""Phase 2.2 & P1.2: Multi-Stage Runbook RAG Pipeline (`services/aiops-server/app/rag/runbook_rag.py`).

Implements a 6-stage local-first RAG pipeline:
1. Document Ingestion (curated built-in InfraPulse SRE runbooks + automatic `runbooks/*.md` scan)
2. Semantic Markdown Section Chunking (by `##` / `###` headers with domain/OS/service/alert metadata)
3. Hybrid Indexing (TF-IDF lexical vectors + metadata tag index)
4. Query Formulation (extracts alert name, domain, server role, OS, and symptom keywords)
5. Hybrid Retrieval & Metadata Reranking (cosine similarity + domain/OS/service/keyword boost)
6. Grounded Prompt Formatting (`<grounded_runbook_context>` block for SaSa AI)
"""

from __future__ import annotations

import math
import re
from collections import Counter
from pathlib import Path

from pydantic import BaseModel, Field

_WORD_RE = re.compile(r"[a-z0-9_]{2,}")
_ACTION_RE = re.compile(r"\*\*Recommended Action:\*\*\s*`([^`]+)`", re.IGNORECASE)
_DOMAIN_RE = re.compile(r"\*\*Domain:\*\*\s*`([^`]+)`", re.IGNORECASE)
_OS_RE = re.compile(r"\*\*OS:\*\*\s*`([^`]+)`", re.IGNORECASE)
_SIGNALS_RE = re.compile(r"\*\*Signals:\*\*\s*(.+)", re.IGNORECASE)

DEFAULT_RUNBOOKS_DIR: Path = Path(__file__).resolve().parents[2] / "runbooks"


class RunbookChunk(BaseModel):
    """A semantic segment of an operational runbook."""

    chunk_id: str
    title: str
    source: str
    domain: str = "vm"
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


# Built-in curated InfraPulse SRE runbook corpus (grounded in AWS SSM + Grafana Alloy + AMP)
DEFAULT_RUNBOOK_CHUNKS: tuple[RunbookChunk, ...] = (
    RunbookChunk(
        chunk_id="rb-mem-001",
        title="Linux High Memory & Swap Pressure Runbook",
        source="runbooks/linux-vm.md#high-memory-swap",
        domain="vm",
        os_type="linux",
        service_tags=["order-worker", "application-node", "java", "python", "worker"],
        alert_keywords=[
            "highmemoryandswappressure",
            "highmemoryusage",
            "linuxmemoryhigh",
            "memory",
            "swap",
            "oom",
            "rss",
        ],
        action_id="restart-approved-service",
        content=(
            "1. Pre-check: Query AMP `node_memory_MemAvailable_bytes`, `node_memory_MemTotal_bytes`, "
            "`node_memory_SwapFree_bytes`, and `node_pressure_memory_waiting_seconds_total` over the last 15m.\n"
            "2. Verify whether memory growth is confined to an approved worker service (e.g., `order-worker`) "
            "using `get_server_context` (`server_id`, `managed_node_id`).\n"
            "3. For MEDIUM severity (85%-95% RAM), do NOT auto-restart without administrator HITL approval.\n"
            "4. Propose `restart-approved-service` via Telegram HITL with expected connection-drain impact.\n"
            "5. Post-check: Confirm Linux memory utilization drops below 75% within 5 minutes of approved restart."
        ),
    ),
    RunbookChunk(
        chunk_id="rb-cpu-001",
        title="High CPU Utilization & Runaway Process Triage",
        source="runbooks/linux-vm.md#cpu-high",
        domain="vm",
        os_type="any",
        service_tags=["web", "api", "worker", "compute"],
        alert_keywords=["cpuhigh", "highcpu", "linuxcpuhigh", "cpu", "load", "saturation", "throttling"],
        action_id="restart-approved-service",
        content=(
            "1. Pre-check: Query AMP `node_cpu_seconds_total{mode=\"idle\"}`, `node_load1`, and "
            "`node_pressure_cpu_waiting_seconds_total` (or `windows_cpu_time_total` on Windows) over 15m.\n"
            "2. Check if high CPU correlates with a legitimate traffic spike or runaway worker thread.\n"
            "3. Request administrator HITL approval before restarting any production worker service."
        ),
    ),
    RunbookChunk(
        chunk_id="rb-disk-001",
        title="Disk Space Low & Temporary Directory Cleanup Runbook",
        source="runbooks/linux-vm.md#temp-cleanup",
        domain="vm",
        os_type="linux",
        service_tags=["storage", "logging", "tmp", "cache"],
        alert_keywords=["diskspacelow", "linuxdisklow", "temp_cleanup_needed", "disk", "tmp", "log_rotate", "inode"],
        action_id="cleanup-temp-directory",
        content=(
            "1. Pre-check: Inspect filesystem availability via AMP `node_filesystem_avail_bytes` and "
            "`node_filesystem_size_bytes` (Grafana Alloy excludes virtual mounts).\n"
            "2. If severity is LOW and alert targets `/tmp` or non-critical cache directories, "
            "action `cleanup-temp-directory` or `rotate-noncritical-logs` is allowlisted.\n"
            "3. Never delete persistent application data directories or active Grafana Alloy spool files."
        ),
    ),
    RunbookChunk(
        chunk_id="rb-db-001",
        title="Critical Database & Core Infrastructure Outage Runbook",
        source="runbooks/linux-vm.md#critical-outage",
        domain="vm",
        os_type="any",
        service_tags=["postgres", "database", "amp", "alloy", "ssm"],
        alert_keywords=["postgresinstancedown", "databaseservicedown", "vmhostdown", "hostdown", "alloy_down", "outage", "down", "critical"],
        action_id=None,
        content=(
            "1. CRITICAL POLICY: Automated remediation is STRICTLY FORBIDDEN for database, host, or Grafana Alloy outages.\n"
            "2. Execute read-only diagnostics (`query_domain_metrics`, `get_server_context`) only.\n"
            "3. Page administrator immediately via Telegram with read-only RCA evidence and verify AWS SSM / Neon PostgreSQL health."
        ),
    ),
)


class RunbookRAGPipeline:
    """Local-first hybrid RAG pipeline for grounding SaSa AI in InfraPulse runbooks."""

    def __init__(
        self,
        chunks: list[RunbookChunk] | None = None,
        *,
        runbooks_dir: Path | None = None,
    ) -> None:
        self.chunks: list[RunbookChunk] = (
            list(chunks) if chunks is not None else list(DEFAULT_RUNBOOK_CHUNKS)
        )
        self._seen_keys: set[tuple[str, str]] = {
            (c.source.lower(), c.title.lower()) for c in self.chunks
        }
        self._doc_tokens: dict[str, Counter[str]] = {}
        self._idf: dict[str, float] = {}

        if chunks is None:
            target_dir = runbooks_dir if runbooks_dir is not None else DEFAULT_RUNBOOKS_DIR
            self.load_runbooks_directory(target_dir)
        elif runbooks_dir is not None:
            self.load_runbooks_directory(runbooks_dir)

        self._rebuild_index()

    @staticmethod
    def tokenize(text: str) -> list[str]:
        """Extract normalized lowercase alphanumeric tokens."""
        return _WORD_RE.findall(text.lower())

    @staticmethod
    def _infer_file_defaults(file_path: Path) -> tuple[str, str, list[str]]:
        """Infer `(domain, os_type, service_tags)` from a runbook filename."""
        stem = file_path.stem.lower()
        if "ssl" in stem or "cert" in stem:
            return "ssl", "any", ["ssl", "tls", "x509", "https", "certificate"]
        if "docker" in stem or "container" in stem:
            return "container", "any", ["docker", "container", "cadvisor", "runtime"]
        if "windows" in stem:
            return "vm", "windows", ["windows", "vm", "alloy", "ssm"]
        if "linux" in stem:
            return "vm", "linux", ["linux", "vm", "alloy", "ssm"]
        return "vm", "any", [stem]

    def _rebuild_index(self) -> None:
        """Build TF-IDF statistics across all registered runbook chunks."""
        self._doc_tokens.clear()
        df: Counter[str] = Counter()
        total_docs = max(1, len(self.chunks))

        for chunk in self.chunks:
            combined = " ".join(
                [
                    chunk.title,
                    chunk.domain,
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

    def load_runbooks_directory(self, runbooks_dir: Path) -> list[RunbookChunk]:
        """Auto-load all `*.md` runbook files from `runbooks_dir`, skipping duplicates."""
        if not runbooks_dir.is_dir():
            return []

        added: list[RunbookChunk] = []
        for md_file in sorted(runbooks_dir.glob("*.md")):
            if not md_file.is_file():
                continue
            domain, os_type, service_tags = self._infer_file_defaults(md_file)
            text = md_file.read_text(encoding="utf-8")
            added.extend(
                self.ingest_markdown_text(
                    text,
                    source=f"runbooks/{md_file.name}",
                    os_type=os_type,
                    domain=domain,
                    service_tags=service_tags,
                    _rebuild=False,
                )
            )
        if added:
            self._rebuild_index()
        return added

    def ingest_markdown_text(
        self,
        markdown_text: str,
        *,
        source: str = "custom-runbook.md",
        os_type: str = "any",
        domain: str = "vm",
        service_tags: list[str] | None = None,
        _rebuild: bool = True,
    ) -> list[RunbookChunk]:
        """Chunk a Markdown document by `##` / `###` headings and index the resulting segments."""
        added: list[RunbookChunk] = []
        sections = re.split(r"(?m)^(#{2,3}\s+.+)$", markdown_text)
        stem = Path(source).stem
        current_title: str | None = None
        seq = len(self.chunks) + 1
        base_tags = list(service_tags) if service_tags else []

        for part in sections:
            stripped = part.strip()
            if not stripped:
                continue
            if stripped.startswith("##"):
                current_title = stripped.lstrip("#").strip()
                continue
            if current_title is None:
                # Skip top-level `# Title` preamble before the first `##` section unless there are no sections
                if stripped.startswith("#") and "## " in markdown_text:
                    continue
                current_title = stem

            dedup_key = (source.lower(), current_title.lower())
            if dedup_key in self._seen_keys:
                continue

            # Parse optional inline metadata markers from curated runbooks
            sec_domain = domain
            dom_match = _DOMAIN_RE.search(stripped)
            if dom_match:
                sec_domain = dom_match.group(1).strip().lower()

            sec_os = os_type
            os_match = _OS_RE.search(stripped)
            if os_match:
                sec_os = os_match.group(1).strip().lower()

            action_id: str | None = None
            act_match = _ACTION_RE.search(stripped)
            if act_match:
                raw_action = act_match.group(1).strip()
                if raw_action and raw_action.lower() not in {"none", "manual-review"}:
                    action_id = raw_action

            keywords = self.tokenize(current_title)[:8]
            sig_match = _SIGNALS_RE.search(stripped)
            if sig_match:
                sig_tokens = re.findall(r"`([^`]+)`", sig_match.group(1))
                for tok in sig_tokens:
                    norm = tok.strip().lower()
                    if norm and norm not in keywords:
                        keywords.append(norm)

            chunk = RunbookChunk(
                chunk_id=f"rb-{stem}-{seq:03d}",
                title=current_title,
                source=source,
                domain=sec_domain,
                os_type=sec_os,
                service_tags=list(base_tags),
                alert_keywords=keywords,
                content=stripped[:2000],
                action_id=action_id,
            )
            self.chunks.append(chunk)
            self._seen_keys.add(dedup_key)
            added.append(chunk)
            seq += 1

        if _rebuild and added:
            self._rebuild_index()
        return added

    def retrieve(
        self,
        query: str,
        *,
        os_type: str | None = None,
        service: str | None = None,
        domain: str | None = None,
        top_k: int = 2,
    ) -> list[RunbookRetrievalResult]:
        """Retrieve and rerank the top-K most relevant runbook chunks for `query`."""
        query_tokens = Counter(self.tokenize(query))
        if not query_tokens:
            return []

        norm_os = os_type.lower().strip() if os_type else None
        norm_service = service.lower().strip() if service else None
        norm_domain = domain.lower().strip() if domain else None

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

            # Metadata reranking boosts for exact alert keyword, domain, OS, and service match
            boost = 0.0
            q_lower = query.lower()
            kw_matches = 0
            for kw in chunk.alert_keywords:
                if kw.lower() in q_lower:
                    kw_matches += 1
            if kw_matches:
                boost += min(0.45, kw_matches * 0.22)

            if norm_domain:
                if chunk.domain.lower() == norm_domain:
                    boost += 0.25
                elif norm_domain in {"linux", "windows"} and chunk.os_type.lower() == norm_domain:
                    boost += 0.25

            if norm_os:
                if chunk.os_type.lower() == norm_os:
                    boost += 0.15
                elif chunk.os_type.lower() == "any":
                    boost += 0.03

            if norm_service and norm_service in {s.lower() for s in chunk.service_tags}:
                boost += 0.20

            total_score = round(min(1.0, cosine + boost), 4)
            if total_score > 0.05:
                results.append(
                    RunbookRetrievalResult(
                        chunk=chunk,
                        score=total_score,
                        matched_terms=sorted(set(matched)),
                    )
                )

        results.sort(key=lambda r: (r.score, len(r.matched_terms)), reverse=True)
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
                f"[{idx}] Runbook: {c.title} (id={c.chunk_id}, domain={c.domain}, source={c.source}, "
                f"relevance={item.score}, recommended_action={c.action_id or 'manual-review'})\n"
                f"{c.content}"
            )
        blocks.append("</grounded_runbook_context>")
        return "\n\n".join(blocks)
