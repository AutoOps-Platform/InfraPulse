"""Whole-batch rules tested against real Protobuf messages, without IO or mocks."""

from dataclasses import FrozenInstanceError
import struct

import pytest

from app.errors import GatewayError
from app.proto.remote_write_pb2 import Sample, WriteRequest
from app.validation import NormalizedBatch, validate_and_normalize


def _reject(message, identity, settings, now, code, status=400):
    before = message.SerializeToString()
    with pytest.raises(GatewayError) as error:
        validate_and_normalize(message, identity, settings, received_at_ms=now)
    assert (error.value.status_code, error.value.code) == (status, code)
    assert message.SerializeToString() == before


@pytest.mark.parametrize("existing", [[], [("server_id", "srv-lab")],
                                      [("agent_id", "agent-lab")],
                                      [("server_id", "srv-lab"), ("agent_id", "agent-lab")]])
def test_inject_missing_and_keep_matching_ids(existing, make_write, identity, settings, received_at_ms):
    message = make_write(labels=[("zone", "west"), *existing, ("__name__", "up")])
    before = message.SerializeToString()
    out = validate_and_normalize(message, identity, settings, received_at_ms=received_at_ms)
    assert isinstance(out, NormalizedBatch)
    assert [(label.name, label.value) for label in out.message.timeseries[0].labels] == [
        ("__name__", "up"), ("agent_id", "agent-lab"),
        ("server_id", "srv-lab"), ("zone", "west"),
    ]
    assert (out.series_count, out.sample_count) == (1, 1)
    assert message.SerializeToString() == before
    assert out.message is not message
    with pytest.raises(FrozenInstanceError):
        out.sample_count = 2


@pytest.mark.parametrize("name,value", [("server_id", "other-server"), ("agent_id", "other-agent")])
def test_conflict_rejects_whole_batch(name, value, make_write, identity, settings, received_at_ms):
    message = make_write()
    message.timeseries.add().CopyFrom(make_write(labels=[("__name__", "other"), (name, value)]).timeseries[0])
    _reject(message, identity, settings, received_at_ms, "identity_conflict")


def test_host_is_not_an_identity_source(make_write, identity, settings, received_at_ms):
    message = make_write(labels=[("__name__", "up"), ("host", "unrelated-host")])
    out = validate_and_normalize(message, identity, settings, received_at_ms=received_at_ms)
    assert [(label.name, label.value) for label in out.message.timeseries[0].labels] == [
        ("__name__", "up"), ("agent_id", "agent-lab"),
        ("host", "unrelated-host"), ("server_id", "srv-lab"),
    ]


@pytest.mark.parametrize("input_count,accepted", [(62, True), (63, False)])
def test_labels_after_injection(input_count, accepted, make_write, identity, settings, received_at_ms):
    labels = [("__name__", "up")] + [(f"label_{i}", "v") for i in range(input_count - 1)]
    message = make_write(labels=labels)
    if accepted:
        out = validate_and_normalize(message, identity, settings, received_at_ms=received_at_ms)
        assert len(out.message.timeseries[0].labels) == 64
    else:
        _reject(message, identity, settings, received_at_ms, "invalid_labels")


@pytest.mark.parametrize("existing", [[("server_id", "srv-lab")],
                                      [("server_id", "srv-lab"), ("agent_id", "agent-lab")]])
def test_label_limit_counts_only_missing_ids(existing, make_write, identity, settings, received_at_ms):
    labels = [("__name__", "up"), *existing, *[(f"label_{i}", "v") for i in range(61)]]
    message = make_write(labels=labels)
    out = validate_and_normalize(message, identity, settings, received_at_ms=received_at_ms)
    assert len(out.message.timeseries[0].labels) == 64
    message.timeseries[0].labels.add(name="overflow", value="v")
    _reject(message, identity, settings, received_at_ms, "invalid_labels")


def test_duplicate_canonical_series(make_write, identity, settings, received_at_ms):
    message = make_write(labels=[("zone", "west"), ("__name__", "up")])
    message.timeseries.add().CopyFrom(make_write(
        labels=[("agent_id", "agent-lab"), ("__name__", "up"), ("zone", "west"), ("server_id", "srv-lab")],
        samples=[(9.0, received_at_ms + 1)],
    ).timeseries[0])
    _reject(message, identity, settings, received_at_ms, "duplicate_series")


def test_canonical_key_uses_names_and_values_without_string_join_collisions(make_write, identity, settings, received_at_ms):
    message = make_write(labels=[("__name__", "up"), ("a", "b,c=d")])
    message.timeseries.add().CopyFrom(make_write(labels=[("__name__", "up"), ("a", "b"), ("c", "d")]).timeseries[0])
    message.timeseries.add().CopyFrom(make_write(labels=[("__name__", "up"), ("a", "different")]).timeseries[0])
    out = validate_and_normalize(message, identity, settings, received_at_ms=received_at_ms)
    assert (out.series_count, out.sample_count) == (3, 3)


@pytest.mark.parametrize("labels", [
    [], [("job", "gateway")],
    [("__name__", "up"), ("__name__", "up")],
    [("__name__", "up"), ("job", "a"), ("job", "b")],
    [("__name__", "up"), ("server_id", "srv-lab"), ("server_id", "srv-lab")],
    [("__name__", "up"), ("agent_id", "agent-lab"), ("agent_id", "agent-lab")],
    [("__name__", "")], [("__name__", "9up")], [("__name__", "up-total")],
    [("__name__", "up\n")], [("__name__", "up total")], [("__name__", "métric")],
    [("__name__", "m" * 257)],
    [("__name__", "up"), ("", "v")], [("__name__", "up"), ("9label", "v")],
    [("__name__", "up"), ("a:b", "v")], [("__name__", "up"), ("a-b", "v")],
    [("__name__", "up"), ("a\n", "v")], [("__name__", "up"), ("é", "v")],
    [("__name__", "up"), ("l" * 129, "v")],
    [("__name__", "up"), ("job", "")], [("__name__", "up"), ("job", "v" * 1025)],
    [("__name__", "up"), ("job", "é" * 513)],
    [("__name__", "up"), ("job", "😀" * 257)],
])
def test_label_and_metric_contract(labels, make_write, identity, settings, received_at_ms):
    _reject(make_write(labels=labels), identity, settings, received_at_ms, "invalid_labels")


@pytest.mark.parametrize("metric,label,value", [
    ("m" * 256, "l" * 128, "v" * 1024),
    (":metric_9:total", "_label_9", "é" * 512),
    ("_", "label", "😀" * 256),
    (":", "label", "nonempty\n\x00value"),
])
def test_valid_label_and_metric_boundaries(metric, label, value, make_write, identity, settings, received_at_ms):
    message = make_write(labels=[("__name__", metric), (label, value)])
    out = validate_and_normalize(message, identity, settings, received_at_ms=received_at_ms)
    assert [(item.name, item.value) for item in out.message.timeseries[0].labels] == sorted([
        ("__name__", metric), (label, value), ("server_id", "srv-lab"), ("agent_id", "agent-lab"),
    ])


@pytest.mark.parametrize("delta,accepted", [(-3600000, True), (120000, True), (-3600001, False), (120001, False)])
def test_timestamp_window_boundaries(delta, accepted, make_write, identity, settings, received_at_ms):
    message = make_write(samples=[(1.0, received_at_ms + delta)])
    if accepted:
        out = validate_and_normalize(message, identity, settings, received_at_ms=received_at_ms)
        assert out.message.timeseries[0].samples[0].timestamp == received_at_ms + delta
    else:
        _reject(message, identity, settings, received_at_ms, "invalid_timestamp")


@pytest.mark.parametrize("delta,accepted", [(-1, True), (0, True), (1, False), (-2, False)])
def test_custom_fractional_window_and_zero_future_skew(delta, accepted, make_write, identity, settings, received_at_ms):
    settings = settings.model_copy(update={"max_sample_age_seconds": 0.0015, "max_future_skew_seconds": 0})
    message = make_write(samples=[(1.0, received_at_ms + delta)])
    if accepted:
        out = validate_and_normalize(message, identity, settings, received_at_ms=received_at_ms)
        assert out.message.timeseries[0].samples[0].timestamp == received_at_ms + delta
    else:
        _reject(message, identity, settings, received_at_ms, "invalid_timestamp")


@pytest.mark.parametrize("timestamps", [[0, 0], [1, 0], [0, 2, 1]])
def test_strict_timestamp_order(timestamps, make_write, identity, settings, received_at_ms):
    message = make_write(samples=[(1.0, received_at_ms + delta) for delta in timestamps])
    _reject(message, identity, settings, received_at_ms, "invalid_timestamp")


def test_ordering_is_per_series_and_not_cached_across_calls(make_write, identity, settings, received_at_ms):
    message = make_write(samples=[(1.0, received_at_ms), (2.0, received_at_ms + 1)])
    message.timeseries.add().CopyFrom(make_write(
        labels=[("__name__", "other")], samples=[(3.0, received_at_ms - 2), (4.0, received_at_ms - 1)],
    ).timeseries[0])
    out = validate_and_normalize(message, identity, settings, received_at_ms=received_at_ms)
    assert (out.series_count, out.sample_count) == (2, 4)
    earlier = make_write(samples=[(5.0, received_at_ms - 10)])
    again = validate_and_normalize(earlier, identity, settings, received_at_ms=received_at_ms)
    assert again.message.timeseries[0].samples[0].timestamp == received_at_ms - 10


@pytest.mark.parametrize("timestamp", [-(2**63), 2**63 - 1])
def test_extreme_timestamps_are_rejected_without_overflow(timestamp, make_write, identity, settings, received_at_ms):
    _reject(make_write(samples=[(1.0, timestamp)]), identity, settings, received_at_ms, "invalid_timestamp")


@pytest.mark.parametrize("series_count,samples_per_series,extra,code", [
    (5000, 4, 0, None), (5001, 1, 0, "too_many_series"), (5000, 4, 1, "too_many_samples"),
])
def test_resource_counts(series_count, samples_per_series, extra, code, make_write, identity, settings, received_at_ms):
    message = WriteRequest()
    for index in range(series_count):
        count = samples_per_series + (extra if index == 0 else 0)
        message.timeseries.add().CopyFrom(make_write(
            labels=[("__name__", "up"), ("series", str(index))],
            samples=[(1.0, received_at_ms + offset) for offset in range(count)],
        ).timeseries[0])
    if code is not None:
        _reject(message, identity, settings, received_at_ms, code, 413)
    else:
        out = validate_and_normalize(message, identity, settings, received_at_ms=received_at_ms)
        assert (out.series_count, out.sample_count) == (5000, 20000)
        assert len(out.message.timeseries) == 5000
        assert all(len(series.samples) == 4 for series in out.message.timeseries)


@pytest.mark.parametrize("limit,code,status", [
    ({"max_series": 1}, "too_many_series", 413),
    ({"max_samples": 1}, "too_many_samples", 413),
    ({"max_labels_per_series": 2}, "invalid_labels", 400),
])
def test_configured_limits_are_used(limit, code, status, make_write, identity, settings, received_at_ms):
    message = make_write()
    message.timeseries.add().CopyFrom(make_write(labels=[("__name__", "other")]).timeseries[0])
    _reject(message, identity, settings.model_copy(update=limit), received_at_ms, code, status)


def test_empty_series(make_write, identity, settings, received_at_ms):
    message = make_write()
    message.timeseries.add().CopyFrom(make_write(labels=[("__name__", "other")], samples=[]).timeseries[0])
    _reject(message, identity, settings, received_at_ms, "empty_series")


def test_empty_write(identity, settings, received_at_ms):
    _reject(WriteRequest(), identity, settings, received_at_ms, "empty_write")


@pytest.mark.parametrize("bits", [
    0x0000000000000000, 0x8000000000000000, 0x7FF0000000000000, 0xFFF0000000000000,
    0x7FF8000000000001, 0x7FF0000000000002, 0x0000000000000001, 0x7FEFFFFFFFFFFFFF,
])
def test_sample_bits_unchanged(bits, make_write, identity, settings):
    message = make_write(samples=[])
    # Independent fixed64 + int64 wire bytes, including the signaling stale marker.
    sample = Sample.FromString(b"\x09" + struct.pack("<Q", bits) + b"\x10\xe8\x07")
    message.timeseries[0].samples.add().CopyFrom(sample)
    before = message.SerializeToString()
    out = validate_and_normalize(message, identity, settings, received_at_ms=1000)
    actual = out.message.timeseries[0].samples[0]
    assert struct.pack("<d", actual.value) == struct.pack("<Q", bits)
    assert actual.timestamp == 1000
    assert actual.SerializeToString() == sample.SerializeToString()
    assert message.SerializeToString() == before


def test_output_is_detached_from_input(make_write, identity, settings, received_at_ms):
    message = make_write()
    out = validate_and_normalize(message, identity, settings, received_at_ms=received_at_ms)
    out.message.timeseries[0].samples[0].timestamp = 123
    out.message.timeseries[0].samples[0].value = 42.0
    out.message.timeseries[0].labels[0].value = "changed"
    assert message.timeseries[0].samples[0].timestamp == received_at_ms
    assert message.timeseries[0].samples[0].value == 1.0
    assert message.timeseries[0].labels[0].value == "infrapulse_unit_value"
    message.timeseries[0].samples.add(value=3.0, timestamp=received_at_ms + 1)
    assert len(out.message.timeseries[0].samples) == 1
