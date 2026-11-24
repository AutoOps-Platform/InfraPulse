"""Validation tests for provisioned Grafana Unified Alerting rules, contact points, and policies."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[3]
ALERTING_DIR = REPO_ROOT / "observability" / "grafana" / "provisioning" / "alerting"
AMP_DATASOURCE_FILE = (
    REPO_ROOT / "observability" / "grafana" / "provisioning" / "datasources" / "amp.yml"
)

ALL_ALERTING_FILES = [
    "contact-points.yml",
    "notification-policies.yml",
    "rules-vm.yml",
    "rules-containers.yml",
    "rules-ssl.yml",
]

RULE_FILES = [
    "rules-vm.yml",
    "rules-containers.yml",
    "rules-ssl.yml",
]

LEGACY_TELEGRAF_METRICS = (
    "cpu_usage_active",
    "mem_used_percent",
    "disk_used_percent",
    "telegraf",
)

SECRET_LEAK_PATTERNS = (
    re.compile(r"sk-[A-Za-z0-9]{16,}"),
    re.compile(r"AIza[0-9A-Za-z\-_]{20,}"),
    re.compile(r"ghp_[A-Za-z0-9]{20,}"),
    re.compile(r"5841901091"),
)


def _load_yaml(path: Path) -> dict[str, Any]:
    raw = path.read_text(encoding="utf-8")
    data = yaml.safe_load(raw)
    assert isinstance(data, dict), f"{path.name} must parse to a YAML mapping"
    return data


def _extract_rules(rule_file: str) -> dict[str, dict[str, Any]]:
    doc = _load_yaml(ALERTING_DIR / rule_file)
    rules_by_title: dict[str, dict[str, Any]] = {}
    for group in doc.get("groups", []):
        for rule in group.get("rules", []):
            title = rule["title"]
            assert title not in rules_by_title, f"Duplicate rule title {title} in {rule_file}"
            rules_by_title[title] = rule
    return rules_by_title


def _query_expr(rule: dict[str, Any]) -> str:
    for item in rule["data"]:
        if item["refId"] == "A":
            return str(item["model"]["expr"])
    raise AssertionError(f"Rule {rule.get('title')} missing query refId A")


def _condition_model(rule: dict[str, Any]) -> dict[str, Any]:
    cond_ref = rule["condition"]
    for item in rule["data"]:
        if item["refId"] == cond_ref:
            return dict(item["model"])
    raise AssertionError(f"Rule {rule.get('title')} missing condition refId {cond_ref}")


@pytest.mark.parametrize("filename", ALL_ALERTING_FILES)
def test_all_alerting_yaml_files_exist_and_parse_cleanly(filename: str) -> None:
    path = ALERTING_DIR / filename
    assert path.is_file(), f"Missing Grafana alerting provisioning file: {path}"
    doc = _load_yaml(path)
    assert doc.get("apiVersion") == 1


def test_amp_datasource_uid_matches_alert_rules() -> None:
    amp_doc = _load_yaml(AMP_DATASOURCE_FILE)
    datasources = amp_doc.get("datasources", [])
    assert datasources, "amp.yml must define at least one datasource"
    amp_uid = datasources[0]["uid"]
    assert amp_uid == "infrapulse-amp"

    for rule_file in RULE_FILES:
        doc = _load_yaml(ALERTING_DIR / rule_file)
        for group in doc.get("groups", []):
            for rule in group.get("rules", []):
                primary_queries = [d for d in rule["data"] if d["refId"] == "A"]
                assert len(primary_queries) == 1
                assert primary_queries[0]["datasourceUid"] == amp_uid


def test_contact_point_webhook_config_and_zero_hardcoded_secrets() -> None:
    doc = _load_yaml(ALERTING_DIR / "contact-points.yml")
    contact_points = doc.get("contactPoints", [])
    assert len(contact_points) == 1

    cp = contact_points[0]
    assert cp["orgId"] == 1
    assert cp["name"] == "infrapulse-aiops-webhook"

    receivers = cp.get("receivers", [])
    assert len(receivers) == 1
    receiver = receivers[0]
    assert receiver["uid"] == "infrapulse-aiops-webhook"
    assert receiver["type"] == "webhook"

    settings = receiver["settings"]
    assert settings["url"] == (
        "${INFRAPULSE_AIOPS_WEBHOOK_URL:-http://127.0.0.1:8001/api/v1/webhooks/grafana}"
    )
    assert settings["httpMethod"] == "POST"

    headers = settings.get("extra_headers", {})
    assert headers.get("X-AIOps-Webhook-Token") == "${AIOPS_WEBHOOK_SECRET}"


def test_notification_policy_routes_infrapulse_alerts_to_aiops_webhook() -> None:
    doc = _load_yaml(ALERTING_DIR / "notification-policies.yml")
    policies = doc.get("policies", [])
    assert len(policies) == 1

    root = policies[0]
    assert root["orgId"] == 1
    assert root["receiver"] == "infrapulse-aiops-webhook"
    assert root["group_by"] == ["alertname", "server_id", "container", "endpoint"]
    assert root["group_wait"]
    assert root["group_interval"]
    assert root["repeat_interval"]

    routes = root.get("routes", [])
    assert len(routes) >= 1
    for route in routes:
        assert route["receiver"] == "infrapulse-aiops-webhook"
        assert route["group_by"] == ["alertname", "server_id", "container", "endpoint"]
        matchers = route.get("object_matchers", [])
        assert ["source_system", "=", "infrapulse"] in matchers
        assert route["group_wait"]
        assert route["group_interval"]
        assert route["repeat_interval"]


def test_vm_alert_rules_cover_all_required_linux_and_windows_signals() -> None:
    rules = _extract_rules("rules-vm.yml")
    expected_specs = {
        "VMHostDown": ("critical", ["up"]),
        "LinuxCPUHigh": ("warning", ["node_cpu_seconds_total", 'mode="idle"']),
        "LinuxMemoryHigh": (
            "warning",
            ["node_memory_MemAvailable_bytes", "node_memory_MemTotal_bytes"],
        ),
        "LinuxMemoryCritical": (
            "critical",
            ["node_memory_MemAvailable_bytes", "node_memory_MemTotal_bytes"],
        ),
        "LinuxDiskLow": (
            "warning",
            ["node_filesystem_avail_bytes", "node_filesystem_size_bytes"],
        ),
        "WindowsCPUHigh": ("warning", ["windows_cpu_time_total", 'mode="idle"']),
        "WindowsMemoryHigh": (
            "warning",
            ["windows_memory_available_bytes", "windows_cs_physical_memory_bytes"],
        ),
        "WindowsDiskLow": (
            "warning",
            ["windows_logical_disk_free_bytes", "windows_logical_disk_size_bytes"],
        ),
    }

    assert set(expected_specs).issubset(rules.keys())
    for title, (expected_severity, metric_tokens) in expected_specs.items():
        rule = rules[title]
        assert rule["labels"]["severity"] == expected_severity
        assert rule["labels"]["domain"] == "vm"
        assert rule["labels"]["source_system"] == "infrapulse"
        expr = _query_expr(rule)
        for token in metric_tokens:
            assert token in expr, f"Expected {token!r} in {title} PromQL: {expr}"

    assert _condition_model(rules["VMHostDown"])["expression"] == "$B == 0"
    assert _condition_model(rules["LinuxCPUHigh"])["conditions"][0]["evaluator"] == {
        "params": [85],
        "type": "gt",
    }
    assert _condition_model(rules["LinuxMemoryHigh"])["conditions"][0]["evaluator"] == {
        "params": [85],
        "type": "gt",
    }
    assert _condition_model(rules["LinuxMemoryCritical"])["conditions"][0]["evaluator"] == {
        "params": [95],
        "type": "gt",
    }
    assert _condition_model(rules["LinuxDiskLow"])["conditions"][0]["evaluator"] == {
        "params": [15],
        "type": "lt",
    }
    assert _condition_model(rules["WindowsCPUHigh"])["conditions"][0]["evaluator"] == {
        "params": [85],
        "type": "gt",
    }
    assert _condition_model(rules["WindowsMemoryHigh"])["conditions"][0]["evaluator"] == {
        "params": [85],
        "type": "gt",
    }
    assert _condition_model(rules["WindowsDiskLow"])["conditions"][0]["evaluator"] == {
        "params": [15],
        "type": "lt",
    }


def test_container_alert_rules_cover_all_required_signals() -> None:
    rules = _extract_rules("rules-containers.yml")
    expected_specs = {
        "ContainerStopped": ("critical", "infrapulse_container_running", "$B == 0"),
        "ContainerUnhealthy": ("warning", "infrapulse_container_health_code", "$B == 2"),
        "ContainerOOMKilled": ("critical", "infrapulse_container_oom_killed", "$B == 1"),
        "ContainerRestartLoop": (
            "warning",
            "increase(infrapulse_container_restarts_total[15m])",
            "$B >= 3",
        ),
    }

    assert set(expected_specs).issubset(rules.keys())
    for title, (expected_severity, expected_metric, expected_cond) in expected_specs.items():
        rule = rules[title]
        assert rule["labels"]["severity"] == expected_severity
        assert rule["labels"]["domain"] == "container"
        assert rule["labels"]["source_system"] == "infrapulse"
        assert expected_metric in _query_expr(rule)
        assert _condition_model(rule)["expression"] == expected_cond


def test_ssl_alert_rules_cover_all_required_signals() -> None:
    rules = _extract_rules("rules-ssl.yml")
    expected_titles = {
        "SSLCertExpired": "critical",
        "SSLCertExpiringCritical": "critical",
        "SSLCertExpiringWarning": "warning",
        "SSLProbeOrReadError": "warning",
    }

    assert set(expected_titles).issubset(rules.keys())
    for title, expected_severity in expected_titles.items():
        rule = rules[title]
        assert rule["labels"]["severity"] == expected_severity
        assert rule["labels"]["domain"] == "ssl"
        assert rule["labels"]["source_system"] == "infrapulse"

    for title in ("SSLCertExpired", "SSLCertExpiringCritical", "SSLCertExpiringWarning"):
        assert "(x509_cert_not_after - time()) / 86400" in _query_expr(rules[title])

    assert _condition_model(rules["SSLCertExpired"])["conditions"][0]["evaluator"] == {
        "params": [0],
        "type": "lt",
    }
    assert _condition_model(rules["SSLCertExpiringCritical"])["expression"] == "$B >= 0 && $B < 7"
    assert _condition_model(rules["SSLCertExpiringWarning"])["expression"] == "$B >= 7 && $B < 28"
    assert "x509_read_errors" in _query_expr(rules["SSLProbeOrReadError"])
    assert _condition_model(rules["SSLProbeOrReadError"])["conditions"][0]["evaluator"] == {
        "params": [0],
        "type": "gt",
    }


def test_rule_uids_are_globally_unique_and_no_reserved_labels_declared() -> None:
    seen_uids: set[str] = set()
    for rule_file in RULE_FILES:
        doc = _load_yaml(ALERTING_DIR / rule_file)
        for group in doc.get("groups", []):
            for rule in group.get("rules", []):
                uid = rule["uid"]
                assert 1 <= len(uid) <= 40, f"Invalid Grafana UID length: {uid}"
                assert uid not in seen_uids, f"Duplicate Grafana rule UID: {uid}"
                seen_uids.add(uid)
                labels = rule.get("labels", {})
                assert "alertname" not in labels, (
                    f"Rule {rule['title']} must not declare reserved label 'alertname'"
                )
                assert "grafana_folder" not in labels
                assert rule.get("noDataState") == "OK"


@pytest.mark.parametrize("filename", ALL_ALERTING_FILES)
def test_zero_legacy_telegraf_metrics_and_zero_hardcoded_secrets(filename: str) -> None:
    raw = (ALERTING_DIR / filename).read_text(encoding="utf-8")
    lower = raw.lower()
    for legacy_metric in LEGACY_TELEGRAF_METRICS:
        assert legacy_metric not in lower, (
            f"Legacy Telegraf metric {legacy_metric!r} found in {filename}"
        )
    for pattern in SECRET_LEAK_PATTERNS:
        assert not pattern.search(raw), f"Potential hardcoded secret found in {filename}"
