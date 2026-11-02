"""Deployment contracts: catch exposure, credential leakage and build-context drift.

These parse actual repository configuration without Docker or root dotenv reads.
Runtime hardening and native host isolation require separate live verification.
"""
from fnmatch import fnmatchcase
from pathlib import Path
import json
import os
import shlex
import subprocess
import tempfile

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[4]
PROJECT = ROOT / "services" / "ingestion-gateway"
pytestmark = pytest.mark.deployment
DEFAULTS = {
    "INGEST_MAX_COMPRESSED_BYTES": "1048576",
    "INGEST_MAX_DECOMPRESSED_BYTES": "8388608",
    "INGEST_MAX_SERIES": "5000",
    "INGEST_MAX_SAMPLES": "20000",
    "INGEST_MAX_LABELS_PER_SERIES": "64",
    "INGEST_MAX_INFLIGHT": "2",
    "INGEST_RATE_PER_SECOND": "10",
    "INGEST_RATE_BURST": "20",
    "INGEST_MAX_SAMPLE_AGE_SECONDS": "3600",
    "INGEST_MAX_FUTURE_SKEW_SECONDS": "120",
    "INGEST_BODY_READ_TIMEOUT_SECONDS": "5",
    "INGEST_CONNECT_TIMEOUT_SECONDS": "2",
    "INGEST_READ_TIMEOUT_SECONDS": "10",
    "INGEST_WRITE_TIMEOUT_SECONDS": "10",
    "INGEST_POOL_TIMEOUT_SECONDS": "1",
    "INGEST_UPSTREAM_DEADLINE_SECONDS": "12",
    "INGEST_READY_TIMEOUT_SECONDS": "1",
    "INGEST_PROMETHEUS_WRITE_URL": "http://prometheus:9090/api/v1/write",
    "INGEST_PROMETHEUS_READY_URL": "http://prometheus:9090/-/ready",
    "INGEST_LOG_LEVEL": "INFO",
    "INGEST_MANAGEMENT_BASE_URL": "http://management:3000",
    "INGEST_CREDENTIAL_TIMEOUT_SECONDS": "2",
    "INGEST_CREDENTIAL_CACHE_TTL_SECONDS": "30",
    "INGEST_CREDENTIAL_CACHE_MAX_ENTRIES": "1024",
    "INGEST_STATUS_INTERVAL_SECONDS": "10",
    "INGEST_STATUS_TIMEOUT_SECONDS": "2",
    "INGEST_STATUS_MAX_PENDING_AGENTS": "1024",
}
REQUIRED = {
    "INGEST_GATEWAY_ID": "${INGEST_GATEWAY_ID:?fixed canonical gateway UUID required}",
    "INGEST_SERVICE_KEY_ID": "${INGEST_SERVICE_KEY_ID:?trusted Gateway kid required}",
    "INGEST_SERVICE_SIGNING_KEY_FILE": "/run/secrets/gateway-signing-key",
}


@pytest.fixture
def compose():
    return yaml.safe_load((ROOT / "deploy/compose/compose.yaml").read_text(encoding="utf-8"))


def test_ingest_is_loopback_only_and_not_a_test_or_source_container(compose):
    ingest = compose["services"].get("ingest")
    assert ingest is not None, "Task 7 ingest service is missing"
    assert ingest["build"] == {"context": "../../services/ingestion-gateway"}
    assert ingest["ports"] == ["127.0.0.1:${INGEST_HOST_PORT:-8000}:8000"]
    assert ingest["networks"] == ["monitoring"]
    assert ingest["depends_on"] == {"prometheus": {"condition": "service_healthy"}, "management": {"condition": "service_healthy"}}
    assert not set(ingest) & {"env_file", "command", "entrypoint", "privileged", "network_mode"}
    assert ingest["user"] == "10001:10001"
    assert ingest["volumes"] == [{
        "type": "bind", "source": "${INGEST_SERVICE_SIGNING_KEY_FILE:?Gateway private key path required}",
        "target": "/run/secrets/gateway-signing-key", "read_only": True,
        "bind": {"create_host_path": False},
    }]


def test_ingest_enforces_resource_security_and_restart_policy(compose):
    ingest = compose["services"].get("ingest")
    assert ingest is not None, "Task 7 ingest service is missing"
    assert ingest["read_only"] is True
    assert ingest["tmpfs"] == ["/tmp"]
    assert ingest["cap_drop"] == ["ALL"]
    assert ingest["security_opt"] == ["no-new-privileges:true"]
    assert ingest["mem_limit"] == "512m"
    assert ingest["pids_limit"] == 128
    assert ingest["restart"] == "unless-stopped"
    assert ingest["logging"] == {"driver": "json-file", "options": {"max-size": "10m", "max-file": "3"}}


def test_ingest_healthcheck_uses_stdlib_readiness_with_bounded_time(compose):
    ingest = compose["services"].get("ingest")
    assert ingest is not None, "Task 7 ingest service is missing"
    health = ingest["healthcheck"]
    assert {key: health[key] for key in ("interval", "timeout", "retries", "start_period")} == {
        "interval": "10s", "timeout": "3s", "retries": 3, "start_period": "10s"}
    command = health["test"]
    assert command[:3] == ["CMD", "python", "-c"]
    # Parse the actual Python command rather than invoking network traffic in static tests.
    import ast
    tree = ast.parse(command[3])
    calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call)]
    urlopen = next(node for node in calls if isinstance(node.func, ast.Attribute) and node.func.attr == "urlopen")
    assert ast.literal_eval(urlopen.args[0]) == "http://127.0.0.1:8000/health/ready"
    assert {kw.arg: ast.literal_eval(kw.value) for kw in urlopen.keywords} == {"timeout": 2}


def test_ingest_only_receives_explicit_gateway_settings_with_safe_defaults(compose):
    ingest = compose["services"].get("ingest")
    assert ingest is not None, "Task 7 ingest service is missing"
    assert ingest["environment"] == {**{key: "${" + key + ":-" + value + "}" for key, value in DEFAULTS.items()}, **REQUIRED}
    example = dict(line.split("=", 1) for line in (ROOT / ".env.example").read_text(encoding="utf-8").splitlines()
                   if line and not line.startswith("#"))
    assert {key: value for key, value in example.items() if key.startswith("INGEST_")} == {
        **DEFAULTS, "INGEST_HOST_PORT": "8000", "INGEST_GATEWAY_ID": "", "INGEST_SERVICE_KEY_ID": "",
        "INGEST_SERVICE_SIGNING_KEY_FILE": "",  # paths/identity explicitly supplied by operator
    }


def test_existing_project_services_storage_networks_and_receiver_are_preserved(compose):
    assert compose["name"] == "infrapulse"
    assert set(compose["services"]) == {"prometheus", "grafana", "postgres", "ingest", "management",
                                        "management-bootstrap", "management-migrate", "management-seed"}
    assert compose["volumes"] == {"prometheus_data": None, "grafana_data": None, "postgres_data": None}
    assert compose["networks"] == {"monitoring": {"driver": "bridge"}, "database": {"driver": "bridge", "internal": True}}
    services = compose["services"]
    assert "--web.enable-remote-write-receiver" in services["prometheus"]["command"]
    assert "ports" not in services["prometheus"] and "ports" not in services["postgres"]
    assert services["grafana"]["ports"] == ["127.0.0.1:3000:3000"]
    for service, volume, target, network in [
        ("prometheus", "prometheus_data", "/prometheus", "monitoring"),
        ("grafana", "grafana_data", "/var/lib/grafana", "monitoring"),
        ("postgres", "postgres_data", "/var/lib/postgresql", "database"),
    ]:
        assert {"type": "volume", "source": volume, "target": target} in services[service]["volumes"]
        assert services[service]["networks"] == [network]


def test_scrape_reaches_ingest_without_changing_existing_self_scrape():
    config = yaml.safe_load((ROOT / "observability/prometheus/prometheus.yml").read_text(encoding="utf-8"))
    assert config["global"] == {"scrape_interval": "30s", "evaluation_interval": "30s"}
    assert config["scrape_configs"] == [
        {"job_name": "prometheus", "static_configs": [{"targets": ["prometheus:9090"]}]},
        {"job_name": "ingestion-gateway", "metrics_path": "/metrics", "static_configs": [{"targets": ["ingest:8000"]}]},
    ]


def docker_stages():
    path = PROJECT / "Dockerfile"
    assert path.is_file(), "Task 7 Dockerfile is missing"
    stages = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        instruction, value = line.split(None, 1)
        if instruction.upper() == "FROM":
            base, _, name = shlex.split(value)
            stage = stages[name] = [("FROM", base)]
        else:
            stage.append((instruction.upper(), value))
    return stages


def test_image_build_is_frozen_and_runtime_is_default_without_dev_tools():
    stages = docker_stages()
    assert list(stages) == ["build", "test", "runtime"]
    base = "python:3.12.16-slim-bookworm@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337"
    assert stages["build"][0] == stages["runtime"][0] == ("FROM", base)
    assert ("COPY", "--from=ghcr.io/astral-sh/uv:0.13.6 /uv /uvx /bin/") in stages["build"]
    assert ("RUN", "uv sync --frozen --no-dev --no-install-project") in stages["build"]
    runtime = stages["runtime"]
    assert ("WORKDIR", "/app") in runtime
    assert ("USER", "10001:10001") in runtime
    copies = [shlex.split(value) for instruction, value in runtime if instruction == "COPY"]
    assert copies == [["--from=build", "/app/.venv", "/app/.venv"], ["app/", "./app/"]]
    env = dict(token.split("=", 1) for instruction, value in runtime if instruction == "ENV" for token in shlex.split(value))
    assert env["PATH"] == "/app/.venv/bin:$PATH"
    assert env["PYTHONDONTWRITEBYTECODE"] == "1"
    cmd = next(json.loads(value) for instruction, value in runtime if instruction == "CMD")
    assert cmd == ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-access-log", "--loop", "asyncio"]


def test_test_stage_keeps_linux_tests_available_without_using_it_for_runtime():
    test = docker_stages()["test"]
    assert test[0] == ("FROM", "build")
    assert ("RUN", "uv sync --frozen --group dev --no-install-project") in test
    assert ("COPY", "app/ ./app/") in test and ("COPY", "tests/ ./tests/") in test
    assert ("ENV", "PYTHONPATH=/app") in test
    assert next(json.loads(value) for instruction, value in test if instruction == "ENTRYPOINT") == ["/app/.venv/bin/python", "-m"]
    assert next(json.loads(value) for instruction, value in test if instruction == "CMD") == ["pytest"]


@pytest.mark.parametrize("path,excluded", [
    (".venv/Scripts/python.exe", True), (".env", True), (".env.local", True),
    ("app/__pycache__/main.pyc", True), (".git/config", True),
    (".pytest_cache/state", True), (".coverage", True), ("htmlcov/index.html", True),
    ("test-results/report.xml", True), ("uv.lock", False), ("pyproject.toml", False),
    ("app/main.py", False), ("app/proto/remote_write.proto", False),
    ("app/proto/remote_write_pb2.py", False), ("tests/fixtures/remote_write_scalar.hex", False),
    ("tests/integration/test_ingestion.py", False),
])
def test_build_context_excludes_secrets_and_artifacts_not_test_sources(path, excluded):
    ignore = PROJECT / ".dockerignore"
    assert ignore.is_file(), "Task 7 .dockerignore is missing"
    patterns = [line.strip().strip("/") for line in ignore.read_text(encoding="utf-8").splitlines()
                if line.strip() and not line.lstrip().startswith("#")]
    # These deliberately simple basename patterns apply at all directory depths.
    parts = path.split("/")
    result = False
    for pattern in patterns:
        negate = pattern.startswith("!")
        pattern = pattern.removeprefix("!")
        if any(fnmatchcase(part, pattern) for part in parts):
            result = not negate
    assert result is excluded, path


def resolved_compose_paths():
    """Only return nonsecret allowlisted fields from Compose's private stdout.

    Never print expanded configuration/stderr or attach it to an assertion.
    The optional override reproduces the rejected CLI anchor without changing YAML.
    """
    command = ["docker", "compose"]
    if override := os.environ.get("TASK7_COMPOSE_PROJECT_DIRECTORY"):
        command += ["--project-directory", override]
    command += ["--env-file", ".env", "-f", "deploy/compose/compose.yaml", "config", "--format", "json"]
    process = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=30)
    if process.returncode:
        raise RuntimeError("Compose path verification failed; expanded output withheld")
    try:
        expanded = json.loads(process.stdout)
        services = expanded["services"]
        allowed = {
            "project": expanded["name"],
            "build": services["ingest"]["build"]["context"],
            "prometheus_bind": [mount["source"] for mount in services["prometheus"]["volumes"] if mount["type"] == "bind"],
            "grafana_bind": [mount["source"] for mount in services["grafana"]["volumes"] if mount["type"] == "bind"],
        }
    except (ValueError, KeyError, TypeError):
        raise RuntimeError("Compose allowlisted paths unavailable; expanded output withheld") from None
    return allowed


@pytest.mark.skipif(os.environ.get("TASK7_RUN_COMPOSE_PATH_CHECK") != "1", reason="opt-in real Compose path regression; static checks need no Docker")
def test_canonical_compose_command_resolves_build_and_existing_binds_inside_repository():
    actual = resolved_compose_paths()
    assert actual == {
        "project": "infrapulse",
        "build": str(PROJECT),
        "prometheus_bind": [str(ROOT / "observability/prometheus/prometheus.yml")],
        "grafana_bind": [str(ROOT / "observability/grafana/provisioning"), str(ROOT / "observability/grafana/dashboards")],
    }
    assert PROJECT.is_dir()
    assert (ROOT / "observability/prometheus/prometheus.yml").is_file()
    assert (ROOT / "observability/grafana/provisioning").is_dir()
    assert (ROOT / "observability/grafana/dashboards").is_dir()


def isolated_compose_paths(directory: Path, *, wrong_anchor=False):
    """Controller Ruling1: private NONSECRET config, only path projection escapes.

    Neither ambient interpolation/COMPOSE overrides nor root dotenv participates.
    Output uses guarded native FDs, bounded reads and finite errors, never dumps.
    """
    fixture = directory / "fixture.env"
    values = {
        "PROMETHEUS_IMAGE_TAG": "v3.13.5-busybox", "GRAFANA_IMAGE_TAG": "13.3.0",
        "POSTGRES_IMAGE_TAG": "18.6-bookworm", "GRAFANA_ADMIN_PASSWORD": "nonsecret-placeholder",
        "POSTGRES_PASSWORD": "nonsecret-placeholder", "MANAGEMENT_GRAFANA_CONTEXT": "fixture-only",
        "INGEST_GATEWAY_ID": "10000000-0000-4000-8000-000000000001", "INGEST_SERVICE_KEY_ID": "fixture-gateway",
    }
    for key in ("MANAGEMENT_DATABASE_URL_FILE", "MANAGEMENT_MIGRATION_DATABASE_URL_FILE",
                "MANAGEMENT_BOOTSTRAP_DATABASE_URL_FILE", "MANAGEMENT_ADMIN_TRUST_FILE",
                "MANAGEMENT_SERVICE_TRUST_FILE", "INGEST_SERVICE_SIGNING_KEY_FILE"):
        values[key] = (directory / "nonsecret-placeholder").as_posix()
    fixture.write_text("".join(f"{key}={value}\n" for key, value in values.items()), encoding="utf-8")
    env = {key: value for key, value in os.environ.items() if key.upper() in {
        "PATH", "SYSTEMROOT", "WINDIR", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA",
        "PROGRAMFILES", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "TEMP", "TMP",
    }}
    command = ["docker", "compose", "--env-file", str(fixture.resolve()), "-f", "deploy/compose/compose.yaml"]
    if wrong_anchor:
        command[2:2] = ["--project-directory", "."]
    def invoke(arguments, out, err):
        try:
            return subprocess.run(command + arguments, cwd=ROOT, env=env,
                                  stdin=subprocess.DEVNULL, stdout=out, stderr=err, timeout=30)
        except (OSError, subprocess.SubprocessError):
            raise RuntimeError("Isolated Compose invocation unavailable; output withheld") from None

    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        quiet = invoke(["config", "--quiet"], out, err)
        if quiet.returncode:
            if wrong_anchor:
                return None
            raise RuntimeError("Isolated Compose quiet qualification failed; output withheld")
        out.seek(0); out.truncate()
        result = invoke(["config", "--format", "json"], out, err)
        if result.returncode:
            if wrong_anchor:
                return None
            raise RuntimeError("Isolated Compose path qualification failed; output withheld")
        out.seek(0)
        raw = out.read(1048577)
        if len(raw) > 1048576:
            raise RuntimeError("Isolated Compose output exceeded bound")
    try:
        expanded = json.loads(raw)
        services = expanded["services"]
        return {
            "project": expanded["name"],
            "ingest_build": services["ingest"]["build"]["context"],
            "management_build": services["management"]["build"]["context"],
            "prometheus_bind": [v["source"] for v in services["prometheus"]["volumes"] if v["type"] == "bind"],
            "grafana_bind": [v["source"] for v in services["grafana"]["volumes"] if v["type"] == "bind"],
        }
    except (ValueError, KeyError, TypeError):
        raise RuntimeError("Isolated Compose allowlisted projection unavailable") from None


@pytest.mark.skipif(os.environ.get("TASK12_RUN_COMPOSE_PATH_CHECK") != "1", reason="opt-in generated-nonsecret Compose qualification")
def test_task12_real_compose_paths_use_safe_fixture_and_reject_root_anchor(tmp_path):
    expected = {
        "project": "infrapulse", "ingest_build": str(PROJECT),
        "management_build": str(ROOT / "services/management-backend"),
        "prometheus_bind": [str(ROOT / "observability/prometheus/prometheus.yml")],
        "grafana_bind": [str(ROOT / "observability/grafana/provisioning"), str(ROOT / "observability/grafana/dashboards")],
    }
    # Do not expose configuration or assertion object dumps, even on failure.
    if isolated_compose_paths(tmp_path) != expected:
        pytest.fail("Canonical normalized Compose paths differ from repository paths", pytrace=False)
    wrong = isolated_compose_paths(tmp_path, wrong_anchor=True)
    if wrong is not None and wrong == expected:
        pytest.fail("Incorrect project-directory anchor was not rejected", pytrace=False)
