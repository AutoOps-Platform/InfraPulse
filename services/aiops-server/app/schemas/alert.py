"""Alert webhook schemas and deterministic domain-aware fingerprint computation."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator, model_validator

_SSL_LABEL_KEYS: frozenset[str] = frozenset({"endpoint", "filepath", "subject_CN"})
_SSL_ALERT_KEYWORDS: tuple[str, ...] = ("ssl", "cert", "x509")
_CONTAINER_ALERT_KEYWORDS: tuple[str, ...] = ("container", "docker", "oom")
_CANONICAL_FINGERPRINT_LABELS: frozenset[str] = frozenset(
    {
        "alertname",
        "rule_name",
        "server_id",
        "instance",
        "service",
        "mountpoint",
        "severity",
        "container",
        "endpoint",
        "target_name",
        "filepath",
        "subject_CN",
        "source",
        "platform",
    }
)


class AlertStatus(StrEnum):
    """Lifecycle status of an incoming monitoring alert."""

    FIRING = "firing"
    RESOLVED = "resolved"


class AlertItem(BaseModel):
    """Single alert event inside a Grafana or webhook notification batch."""

    model_config = ConfigDict(populate_by_name=True)

    status: AlertStatus = AlertStatus.FIRING
    labels: dict[str, str] = Field(default_factory=dict)
    annotations: dict[str, str] = Field(default_factory=dict)
    starts_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        validation_alias=AliasChoices("starts_at", "startsAt"),
    )
    ends_at: datetime | None = Field(
        default=None,
        validation_alias=AliasChoices("ends_at", "endsAt"),
    )
    generator_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices("generator_url", "generatorURL"),
    )
    fingerprint: str | None = None

    @field_validator("starts_at", mode="before")
    @classmethod
    def _coerce_empty_starts_at(cls, value: Any) -> Any:
        if value is None or (isinstance(value, str) and not value.strip()):
            return datetime.now(UTC)
        return value

    @field_validator("ends_at", mode="before")
    @classmethod
    def _coerce_empty_ends_at(cls, value: Any) -> Any:
        if value is None or (isinstance(value, str) and not value.strip()):
            return None
        return value

    @property
    def alert_name(self) -> str:
        """Extract alert rule name from labels."""
        return self.labels.get("alertname") or self.labels.get("rule_name") or "unnamed-alert"

    @property
    def declared_severity(self) -> str:
        """Extract raw severity label declared by the alert rule, if any."""
        return (self.labels.get("severity") or "warning").lower()

    @property
    def domain(self) -> str:
        """Detect operational domain: `ssl`, `container`, or `vm`."""
        alert_lower = self.alert_name.lower()
        if any(bool((self.labels.get(key) or "").strip()) for key in _SSL_LABEL_KEYS) or any(
            kw in alert_lower for kw in _SSL_ALERT_KEYWORDS
        ):
            return "ssl"
        if bool((self.labels.get("container") or "").strip()) or any(
            kw in alert_lower for kw in _CONTAINER_ALERT_KEYWORDS
        ):
            return "container"
        return "vm"

    @property
    def is_external_ssl(self) -> bool:
        """Return True when this alert comes from the central external SSL prober."""
        if self.domain != "ssl":
            return False
        source = (self.labels.get("source") or "").strip().lower()
        instance = (self.labels.get("instance") or "").strip()
        raw_server = (self.labels.get("server_id") or "").strip()
        if source == "external" or instance == "management-ssl-prober" or raw_server == "management-ssl-prober":
            return True
        return not raw_server and not (self.labels.get("filepath") or "").strip() and bool(
            (self.labels.get("endpoint") or self.labels.get("target_name") or "").strip()
        )

    @property
    def server_id(self) -> str:
        """Extract canonical `server_id` without letting `management-ssl-prober` masquerade as a VM."""
        raw_server = (self.labels.get("server_id") or "").strip()
        if raw_server and raw_server != "management-ssl-prober":
            return raw_server

        if self.is_external_ssl:
            return (
                (self.labels.get("endpoint") or "").strip()
                or (self.labels.get("target_name") or "").strip()
                or (self.labels.get("subject_CN") or "").strip()
                or "external-ssl-target"
            )

        raw_instance = (self.labels.get("instance") or "").strip()
        if raw_instance and raw_instance != "management-ssl-prober":
            return raw_instance

        raw_host = (self.labels.get("host") or "").strip()
        if raw_host and raw_host != "management-ssl-prober":
            return raw_host

        return "unknown-server"

    @property
    def target_id(self) -> str:
        """Return domain-aware canonical target identifier for AMP/MCP and deduplication."""
        if self.domain == "ssl":
            if self.is_external_ssl:
                return (
                    (self.labels.get("endpoint") or "").strip()
                    or (self.labels.get("target_name") or "").strip()
                    or (self.labels.get("subject_CN") or "").strip()
                    or self.server_id
                )
            filepath = (
                (self.labels.get("filepath") or "").strip()
                or (self.labels.get("subject_CN") or "").strip()
                or (self.labels.get("endpoint") or "").strip()
                or (self.labels.get("target_name") or "").strip()
            )
            return f"{self.server_id}:{filepath}" if filepath else self.server_id

        if self.domain == "container":
            container = (
                (self.labels.get("container") or "").strip()
                or (self.labels.get("container_name") or "").strip()
                or (self.labels.get("service") or "").strip()
            )
            return f"{self.server_id}:{container}" if container else self.server_id

        return self.server_id

    @property
    def platform(self) -> str:
        """Infer host OS platform (`linux` or `windows`) from alert labels or naming."""
        explicit = (self.labels.get("platform") or self.labels.get("os") or "").strip().lower()
        if explicit in {"linux", "windows"}:
            return explicit
        if "win" in self.alert_name.lower() or "win" in self.server_id.lower():
            return "windows"
        return "linux"

    def compute_fingerprint(self) -> str:
        """Return existing alert fingerprint or compute a deterministic domain-aware SHA-256 digest."""
        if self.fingerprint and self.fingerprint.strip():
            return self.fingerprint.strip()
        canonical_labels = {
            k: v
            for k, v in sorted(self.labels.items())
            if k in _CANONICAL_FINGERPRINT_LABELS
        }
        if not canonical_labels:
            canonical_labels = dict(sorted(self.labels.items()))
        raw = json.dumps(canonical_labels, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


class AlertWebhookPayload(BaseModel):
    """Incoming Grafana Unified Alerting / AIOps alert webhook payload."""

    model_config = ConfigDict(populate_by_name=True)

    receiver: str = "infrapulse-aiops"
    status: AlertStatus = AlertStatus.FIRING
    title: str = ""
    message: str = ""
    alerts: list[AlertItem] = Field(min_length=1)
    external_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices("external_url", "externalURL"),
    )
    common_labels: dict[str, str] = Field(
        default_factory=dict,
        validation_alias=AliasChoices("common_labels", "commonLabels"),
    )
    common_annotations: dict[str, str] = Field(
        default_factory=dict,
        validation_alias=AliasChoices("common_annotations", "commonAnnotations"),
    )
    group_labels: dict[str, str] = Field(
        default_factory=dict,
        validation_alias=AliasChoices("group_labels", "groupLabels"),
    )

    @model_validator(mode="after")
    def _merge_common_defaults(self) -> AlertWebhookPayload:
        """Merge batch-level `group_labels`, `common_labels`, and `common_annotations` into alerts."""
        if not (self.group_labels or self.common_labels or self.common_annotations):
            return self
        default_labels = {**self.group_labels, **self.common_labels}
        for alert in self.alerts:
            if default_labels:
                merged_labels = dict(default_labels)
                merged_labels.update(alert.labels)
                alert.labels = merged_labels
            if self.common_annotations:
                merged_annotations = dict(self.common_annotations)
                merged_annotations.update(alert.annotations)
                alert.annotations = merged_annotations
        return self

    def primary_alert(self) -> AlertItem:
        """Return the primary alert in the webhook batch."""
        return self.alerts[0]

    def batch_fingerprint(self) -> str:
        """Compute a deterministic fingerprint across all firing alerts in the batch."""
        parts = sorted(alert.compute_fingerprint() for alert in self.alerts)
        joined = f"{self.status.value}:" + "|".join(parts)
        return hashlib.sha256(joined.encode("utf-8")).hexdigest()[:16]
