"""Pure, whole-request scalar validation and copy-only normalization."""

from dataclasses import dataclass
import re

from app.config import Settings
from app.errors import GatewayError
from app.identity import Identity
from app.proto.remote_write_pb2 import WriteRequest


_METRIC_NAME = re.compile(r"[a-zA-Z_:][a-zA-Z0-9_:]*")
_LABEL_NAME = re.compile(r"[a-zA-Z_][a-zA-Z0-9_]*")


@dataclass(frozen=True)
class NormalizedBatch:
    message: WriteRequest
    series_count: int
    sample_count: int


def validate_and_normalize(
    message: WriteRequest,
    identity: Identity,
    settings: Settings,
    *,
    received_at_ms: int,
) -> NormalizedBatch:
    series_count = len(message.timeseries)
    if not series_count:
        raise GatewayError(400, "empty_write")
    if series_count > settings.max_series:
        raise GatewayError(413, "too_many_series")
    sample_count = sum(len(series.samples) for series in message.timeseries)
    if sample_count > settings.max_samples:
        raise GatewayError(413, "too_many_samples")

    max_age_ms = settings.max_sample_age_seconds * 1000
    max_future_ms = settings.max_future_skew_seconds * 1000
    canonical_labels: list[tuple[tuple[str, str], ...]] = []
    seen: set[tuple[tuple[str, str], ...]] = set()
    for series in message.timeseries:
        if not series.samples:
            raise GatewayError(400, "empty_series")
        labels: dict[str, str] = {}
        for label in series.labels:
            name, value = label.name, label.value
            if (
                _LABEL_NAME.fullmatch(name) is None
                or len(name.encode("utf-8")) > 128
                or name in labels
                or not value
                or len(value.encode("utf-8")) > 1024
            ):
                raise GatewayError(400, "invalid_labels")
            labels[name] = value
        metric = labels.get("__name__", "")
        if _METRIC_NAME.fullmatch(metric) is None or len(metric.encode("utf-8")) > 256:
            raise GatewayError(400, "invalid_labels")
        for name, value in (("server_id", identity.server_id), ("agent_id", identity.agent_id)):
            if name in labels and labels[name] != value:
                raise GatewayError(400, "identity_conflict")
            labels[name] = value
        if len(labels) > settings.max_labels_per_series:
            raise GatewayError(400, "invalid_labels")
        key = tuple(sorted(labels.items()))
        if key in seen:
            raise GatewayError(400, "duplicate_series")
        seen.add(key)
        canonical_labels.append(key)

        previous = None
        for sample in series.samples:
            timestamp = sample.timestamp
            # Compare integer deltas, not rounded absolute epoch float bounds.
            if (
                (previous is not None and timestamp <= previous)
                or received_at_ms - timestamp > max_age_ms
                or timestamp - received_at_ms > max_future_ms
            ):
                raise GatewayError(400, "invalid_timestamp")
            previous = timestamp

    # No output is constructed until every series passes. CopyFrom preserves
    # sample float64 payloads (including stale NaN bits) without reading values.
    normalized = WriteRequest()
    normalized.CopyFrom(message)
    for series, labels in zip(normalized.timeseries, canonical_labels):
        del series.labels[:]
        for name, value in labels:
            series.labels.add(name=name, value=value)
    return NormalizedBatch(normalized, series_count, sample_count)
