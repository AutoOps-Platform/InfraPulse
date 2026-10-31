"""Fail if defaults drift, env bypasses bounds, or unsafe URLs reach clients."""

import pytest

from app.config import Settings


DEFAULTS = {
    "max_compressed_bytes": 1048576,
    "max_decompressed_bytes": 8388608,
    "max_series": 5000,
    "max_samples": 20000,
    "max_labels_per_series": 64,
    "max_inflight": 2,
    "rate_per_second": 10,
    "rate_burst": 20,
    "max_sample_age_seconds": 3600,
    "max_future_skew_seconds": 120,
    "body_read_timeout_seconds": 5,
    "connect_timeout_seconds": 2,
    "read_timeout_seconds": 10,
    "write_timeout_seconds": 10,
    "pool_timeout_seconds": 1,
    "upstream_deadline_seconds": 12,
    "ready_timeout_seconds": 1,
    "prometheus_write_url": "http://prometheus:9090/api/v1/write",
    "prometheus_ready_url": "http://prometheus:9090/-/ready",
    "log_level": "INFO",
    "host_port": 8000,
}
NUMERIC_FIELDS = [name for name, value in DEFAULTS.items() if isinstance(value, int)]


@pytest.mark.parametrize("name,expected", DEFAULTS.items())
def test_default_limits(settings, name, expected):
    assert getattr(settings, name) == expected


@pytest.mark.parametrize("name", NUMERIC_FIELDS)
def test_settings_read_prefixed_environment(monkeypatch, name):
    monkeypatch.setenv(f"INGEST_{name.upper()}", "7")
    assert getattr(Settings(), name) == 7


@pytest.mark.parametrize("name", NUMERIC_FIELDS)
@pytest.mark.parametrize("value", ["NaN", "Infinity", "-Infinity", "-1"])
def test_numeric_environment_rejects_unbounded_values(monkeypatch, name, value):
    monkeypatch.setenv(f"INGEST_{name.upper()}", value)
    with pytest.raises(ValueError):
        Settings()


@pytest.mark.parametrize("name", [n for n in NUMERIC_FIELDS if n != "max_future_skew_seconds"])
def test_numeric_environment_rejects_zero(monkeypatch, name):
    monkeypatch.setenv(f"INGEST_{name.upper()}", "0")
    with pytest.raises(ValueError):
        Settings()


@pytest.mark.parametrize("name,value", [
    ("rate_per_second", "NaN"),
    ("read_timeout_seconds", "Infinity"),
    ("max_inflight", 0),
    ("max_samples", -1),
    ("prometheus_write_url", "http://user:pass@prometheus:9090/api/v1/write"),
    ("prometheus_ready_url", "http://prometheus:9090/-/ready#fragment"),
])
def test_settings_reject_nonfinite_and_unsafe_urls(name, value):
    with pytest.raises(ValueError):
        Settings(**{name: value})


@pytest.mark.parametrize("name", ["prometheus_write_url", "prometheus_ready_url"])
@pytest.mark.parametrize("value", [
    "ftp://prometheus:9090/write", "http:///write", "/write", "",
    "http://@prometheus/write", "http://prometheus/write#",
    "http://prometheus:99999/write", "http://prometheus/\nwrite",
])
def test_upstream_urls_reject_unsafe_environment(monkeypatch, name, value):
    monkeypatch.setenv(f"INGEST_{name.upper()}", value)
    with pytest.raises(ValueError):
        Settings()


@pytest.mark.parametrize("name", ["prometheus_write_url", "prometheus_ready_url"])
@pytest.mark.parametrize("value", ["https://example.test:9090/custom", "http://[::1]:9090/custom"])
def test_server_configured_http_urls_are_accepted(monkeypatch, name, value):
    monkeypatch.setenv(f"INGEST_{name.upper()}", value)
    assert str(getattr(Settings(), name)) == value


def test_future_skew_can_be_zero(monkeypatch):
    monkeypatch.setenv("INGEST_MAX_FUTURE_SKEW_SECONDS", "0")
    assert Settings().max_future_skew_seconds == 0


@pytest.mark.parametrize("value", ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL", "NOTSET"])
def test_standard_log_levels(monkeypatch, value):
    monkeypatch.setenv("INGEST_LOG_LEVEL", value)
    assert Settings().log_level == value


@pytest.mark.parametrize("value", ["TRACE", "invalid", "INFO\nsecret"])
def test_log_level_is_finite_enum(monkeypatch, value):
    monkeypatch.setenv("INGEST_LOG_LEVEL", value)
    with pytest.raises(ValueError):
        Settings()


def test_settings_do_not_read_dotenv_or_unprefixed_env(tmp_path, monkeypatch):
    (tmp_path / ".env").write_text("INGEST_MAX_SAMPLES=1\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("MAX_SAMPLES", "2")
    assert Settings().max_samples == 20000


def test_fixture_values(identity, received_at_ms):
    assert (identity.server_id, identity.agent_id) == ("srv-lab", "agent-lab")
    assert received_at_ms == 1800000000000
