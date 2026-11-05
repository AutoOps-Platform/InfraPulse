"""Alert webhook schemas and deterministic fingerprint computation."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, Field


class AlertStatus(StrEnum):
    """Lifecycle status of an incoming monitoring alert."""

    FIRING = "firing"
    RESOLVED = "resolved"


class AlertItem(BaseModel):
    """Single alert event inside a Grafana or webhook notification batch."""

    status: AlertStatus = AlertStatus.FIRING
    labels: dict[str, str] = Field(default_factory=dict)
    annotations: dict[str, str] = Field(default_factory=dict)
    starts_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    fingerprint: str | None = None

    @property
    def server_id(self) -> str:
        """Extract canonical `server_id` label or default to `unknown-server`."""
        return (
            self.labels.get("server_id")
            or self.labels.get("instance")
            or self.labels.get("host")
            or "unknown-server"
        )

    @property
    def alert_name(self) -> str:
        """Extract alert rule name from labels."""
        return self.labels.get("alertname") or self.labels.get("rule_name") or "unnamed-alert"

    @property
    def declared_severity(self) -> str:
        """Extract raw severity label declared by the alert rule, if any."""
        return (self.labels.get("severity") or "warning").lower()

    def compute_fingerprint(self) -> str:
        """Return existing alert fingerprint or compute a deterministic SHA-256 digest."""
        if self.fingerprint and self.fingerprint.strip():
            return self.fingerprint.strip()
        canonical_labels = {
            k: v
            for k, v in sorted(self.labels.items())
            if k in {"alertname", "rule_name", "server_id", "instance", "service", "mountpoint", "severity"}
        }
        if not canonical_labels:
            canonical_labels = dict(sorted(self.labels.items()))
        raw = json.dumps(canonical_labels, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


class AlertWebhookPayload(BaseModel):
    """Incoming Grafana/AIOps alert webhook payload."""

    receiver: str = "infrapulse-aiops"
    status: AlertStatus = AlertStatus.FIRING
    title: str = ""
    message: str = ""
    alerts: list[AlertItem] = Field(min_length=1)
    external_url: str | None = None

    def primary_alert(self) -> AlertItem:
        """Return the primary alert in the webhook batch."""
        return self.alerts[0]

    def batch_fingerprint(self) -> str:
        """Compute a deterministic fingerprint across all firing alerts in the batch."""
        parts = sorted(alert.compute_fingerprint() for alert in self.alerts)
        joined = f"{self.status.value}:" + "|".join(parts)
        return hashlib.sha256(joined.encode("utf-8")).hexdigest()[:16]
