#!/usr/bin/env python3
"""InfraPulse provisioning/rendering. Python 3.11+, standard library only.

Never collects metrics, executes plugins or accepts arbitrary remote TOML.
All diagnostics are finite, credential-free codes; never print remote bodies.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import ssl
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

VERSION = "infrapulse-installer/1.0.0"
UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
ROOT = Path(__file__).resolve().parent.parent


class AgentError(Exception):
    """Message must always be a finite local code, never untrusted input."""


def require(condition: bool, code: str = "invalid_provisioning_contract") -> None:
    if not condition:
        raise AgentError(code)


def object_only(value, allowed: set[str], required: set[str] | None = None):
    require(type(value) is dict and set(value) <= allowed)
    require((required if required is not None else allowed) <= set(value))
    return value


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate_json_key")
        result[key] = value
    return result


def reject_constant(_):
    raise AgentError("nonfinite_json_number")


def decode(body: bytes):
    require(len(body) <= 262144, "response_too_large")
    return json.loads(body.decode("utf-8"), object_pairs_hook=unique_object,
                      parse_constant=reject_constant)


def private_file(path: Path, limit: int = 262144) -> bytes:
    require(not path.is_symlink(), "unsafe_file_link")
    info = path.stat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= limit, "unsafe_file")
    if os.name != "nt":
        require(info.st_uid == os.geteuid() and info.st_mode & 0o077 == 0,
                "file_requires_owner_only_permissions")
    return path.read_bytes()


def key_file(path: Path) -> str:
    value = private_file(path, 512).decode("ascii").strip("\r\n")
    require(re.fullmatch(UUID + r"\.[A-Za-z0-9_-]{43}", value) is not None,
            "invalid_api_key_file")
    return value


def write_private(path: Path, value: str) -> None:
    require(not path.exists() and not path.is_symlink(), "destination_exists")
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        os.chmod(path, 0o600)
        stream.write(value)


def json_text(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def origin(value: str) -> str:
    require(type(value) is str and re.fullmatch(r"https://[^/?#]+/?", value) is not None,
            "https_origin_required")
    require(not re.search(r"[\x00-\x20\x7f\\@$%{}]", value) and value.isascii(),
            "invalid_https_origin")
    parsed = urllib.parse.urlsplit(value)
    require(bool(parsed.hostname) and not parsed.username and not parsed.password,
            "invalid_https_origin")
    try:
        port = parsed.port
    except ValueError:
        raise AgentError("invalid_https_origin") from None
    require(port is None or 1 <= port <= 65535, "invalid_https_origin")
    # Normalize standard HTTPS port without weakening exact destination pinning.
    host = parsed.hostname.lower()
    if ":" in host:
        host = "[" + host + "]"
    return "https://" + host + (":" + str(port) if port not in (None, 443) else "")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(base: str, path: str, key: str, ca: str | None, payload=None):
    context = ssl.create_default_context(cafile=ca)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    # Do not forward credentials via environment proxy settings or redirects.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(),
                                        urllib.request.HTTPSHandler(context=context))
    headers = {"Authorization": "Bearer " + key, "Accept": "application/json",
               "User-Agent": VERSION}
    data = None if payload is None else json_text(payload).encode("utf-8")
    if data is not None:
        headers["Content-Type"] = "application/json"
    for attempt in range(3):
        try:
            req = urllib.request.Request(origin(base) + path, data=data, headers=headers,
                                         method="GET" if data is None else "POST")
            with opener.open(req, timeout=10) as response:
                status = response.status
                body = response.read(262145)
                require(len(body) <= 262144, "response_too_large")
                require(status == (200 if data is None else 204), "unexpected_http_status")
                return decode(body) if data is None else None
        except urllib.error.HTTPError as error:
            code = error.code
            error.close()
            if code in (429, 502, 503, 504) and attempt < 2:
                time.sleep(attempt + 1)
                continue
            hints = {401: "credential_expired_revoked_or_invalid", 403: "credential_scope_denied",
                     409: "provisioning_or_profile_receipt_not_ready", 429: "management_rate_limited"}
            raise AgentError(hints.get(code, "management_http_" + str(code))) from None
        except (urllib.error.URLError, TimeoutError, ssl.SSLError):
            if attempt < 2:
                time.sleep(attempt + 1)
                continue
            raise AgentError("management_tls_or_connection_failed") from None


def strings(value, absolute=False):
    require(type(value) is list and len(value) <= 64)
    for item in value:
        require(type(item) is str and 1 <= len(item.encode("utf-16-le")) // 2 <= 128)
        require(not re.search(r"[\x00-\x1f\x7f;|&<>`]|\$\{|\$\(|\{\{|\}\}|[a-z][a-z0-9+.-]*://", item, re.I))
        require(re.match(r"^(?:https?|ftp|file|data|javascript):", item, re.I) is None)
        require(not absolute or item.startswith("/"))
    return value


def profile_config(value, os_name):
    object_only(value, {"schema_version", "os", "interval_seconds", "metric_groups", "options"},
                {"schema_version", "os", "metric_groups", "options"})
    require(type(value["schema_version"]) is int and value["schema_version"] == 1
            and value["os"] == os_name)
    interval = value.get("interval_seconds", 15)
    require(type(interval) is int and 5 <= interval <= 300)
    groups = object_only(value["metric_groups"], {"cpu", "memory", "disk", "network"})
    require(all(type(item) is bool for item in groups.values()))
    options = object_only(value["options"], {"disk", "network"}, set())
    allowed_disk = {"exclude_filesystems", "mount_points"} if os_name == "linux" else {"include_volumes"}
    for section, fields in (("disk", allowed_disk), ("network", {"interfaces"})):
        if section in options:
            object_only(options[section], fields, set())
            for name, items in options[section].items():
                strings(items, name == "mount_points")
    result = {"schema_version": 1, "os": os_name, "interval_seconds": interval,
              "metric_groups": groups, "options": options}
    require(len(json_text(result).encode("utf-8")) <= 65536)
    return result


def validate_provisioning(body, os_name, pinned_gateway):
    object_only(body, {"server_id", "agent_id", "os", "profile", "ingestion"})
    require(body["os"] == os_name)
    for name in ("server_id", "agent_id"):
        require(type(body[name]) is str and re.fullmatch(UUID, body[name]) is not None)
    profile = object_only(body["profile"], {"id", "version_id", "version", "checksum", "config"})
    for name in ("id", "version_id"):
        require(type(profile[name]) is str and re.fullmatch(UUID, profile[name]) is not None)
    require(type(profile["version"]) is int and profile["version"] > 0)
    require(type(profile["checksum"]) is str and re.fullmatch(r"[0-9a-f]{64}", profile["checksum"]) is not None)
    config = profile_config(profile["config"], os_name)
    # All allowed object keys are ASCII; numbers are bounded integers. Sorted
    # compact UTF-8 JSON therefore equals RFC8785 for this deliberately small schema.
    require(hashlib.sha256(json_text(config).encode("utf-8")).hexdigest() == profile["checksum"],
            "profile_checksum_mismatch")
    ingestion = object_only(body["ingestion"], {"base_url", "path", "content_type", "content_encoding",
                           "remote_write_version", "authorization_scheme", "identity_headers"})
    require(origin(ingestion["base_url"]) == origin(pinned_gateway), "gateway_origin_pin_mismatch")
    fixed = {"path": "/api/v1/ingest/remote-write", "content_type": "application/x-protobuf",
             "content_encoding": "snappy", "remote_write_version": "0.1.0", "authorization_scheme": "Bearer"}
    require(all(ingestion.get(k) == v for k, v in fixed.items()))
    require(ingestion["identity_headers"] == {"X-Server-ID": body["server_id"], "X-Agent-ID": body["agent_id"]})
    return config


def toml(value) -> str:
    # Telegraf 1.38 strict substitution runs AFTER TOML parsing (config/envvar.go).
    # Compose-template '$$' represents a literal dollar, not an environment lookup.
    # Preserve valid backend values such as literal '$name' without expansion.
    if isinstance(value, str):
        value = value.replace("$", "$$")
    elif isinstance(value, list):
        return "[" + ", ".join(toml(item) for item in value) + "]"
    return json.dumps(value, ensure_ascii=False)


def template(name: str, **values) -> str:
    source = (ROOT / "templates" / name).read_text(encoding="utf-8")
    pattern = re.compile(r"@([A-Z_]+)@")
    require(set(pattern.findall(source)) == set(values), "unresolved_template_variable")
    # One pass over trusted template source only. Never interpret placeholders
    # inside a substituted interface/path value (e.g. a literal '@NIC@').
    return pattern.sub(lambda match: str(values[match[1]]), source)


def render_inputs(config):
    os_name = config["os"]
    groups = config["metric_groups"]
    options = config["options"]
    result = template(os_name + "/system.toml")
    for group in ("cpu", "memory", "disk", "network"):
        if not groups[group]:
            continue
        values = {}
        if group == "disk":
            disk = options.get("disk", {})
            if os_name == "linux":
                values["DISK_OPTIONS"] = "\n".join(
                    "  " + target + " = " + toml(disk[key])
                    for key, target in (("exclude_filesystems", "ignore_fs"), ("mount_points", "mount_points"))
                    if key in disk)
            else:
                # These are PDH LogicalDisk instance names, e.g. C:, not paths.
                values["VOLUMES"] = toml(disk.get("include_volumes") or ["*"])
        if group == "network":
            interfaces = options.get("network", {}).get("interfaces")
            values["NETWORK_OPTIONS"] = "" if interfaces is None else "  interfaces = " + toml(interfaces)
        result += "\n" + template(os_name + "/" + group + ".toml", **values)
    return result


def prepare(args):
    require((os.name == "nt") == (args.os == "windows"), "installer_os_mismatch")
    destination = Path(args.destination)
    require(destination.is_dir() and not destination.is_symlink() and not any(destination.iterdir()),
            "destination_must_be_empty_private_directory")
    runtime = Path(args.runtime_dir)
    require(runtime.is_absolute() and not re.search(r"[$\x00-\x1f\x7f]", str(runtime)), "unsafe_runtime_path")
    management = origin(args.management_url)
    gateway = origin(args.gateway_origin)
    key = key_file(Path(args.key_file))
    body = request(management, "/api/v1/agent/provisioning", key, args.management_ca)
    config = validate_provisioning(body, args.os, gateway)
    if args.previous_state:
        previous = decode(private_file(Path(args.previous_state)))
        require(all(previous.get(name) == body[name] for name in ("os", "server_id", "agent_id")),
                "existing_agent_identity_mismatch")
        require(previous.get("management_url") == management, "management_origin_change_requires_reenrollment")
    ca_paths = {}
    for name in ("management", "gateway"):
        source = getattr(args, name + "_ca")
        if source:
            path = Path(source)
            require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 1048576,
                    "invalid_ca_file")
            # Verify that this is a loadable PEM trust bundle, not arbitrary text.
            ssl.create_default_context(cafile=str(path))
            write_private(destination / (name + "-ca.pem"), path.read_text(encoding="ascii"))
            ca_paths[name] = str(runtime / (name + "-ca.pem"))
        else:
            ca_paths[name] = None
    os.chmod(destination, 0o700)
    (destination / "conf.d").mkdir(mode=0o700)
    write_private(destination / "api-key", key + "\n")
    write_private(destination / "telegraf.conf", template("agent.toml.tpl",
                  INTERVAL=config["interval_seconds"], SERVER_ID=toml(body["server_id"]),
                  AGENT_ID=toml(body["agent_id"]), OS=toml(args.os),
                  LOGFILE=toml("/var/lib/infrapulse-agent/telegraf.log" if args.os == "linux" else str(runtime / "telegraf.log"))))
    write_private(destination / "conf.d" / "inputs.conf", render_inputs(config))
    write_private(destination / "conf.d" / "output.conf", template("output-http.toml.tpl",
                  URL=toml(gateway + body["ingestion"]["path"]), AUTHORIZATION=toml("Bearer " + key),
                  SERVER_ID=toml(body["server_id"]), AGENT_ID=toml(body["agent_id"]),
                  CA_OPTION="" if ca_paths["gateway"] is None else "  tls_ca = " + toml(ca_paths["gateway"])))
    profile = body["profile"]
    state = {"schema_version": 1, "os": args.os, "server_id": body["server_id"], "agent_id": body["agent_id"],
             "management_url": management, "gateway_origin": gateway,
             "management_ca": ca_paths["management"], "gateway_ca": ca_paths["gateway"],
             "profile_id": profile["id"], "profile_version_id": profile["version_id"],
             "profile_version": profile["version"], "checksum": profile["checksum"],
             "interval_seconds": config["interval_seconds"], "report_pending": True}
    write_private(destination / "state.json", json_text(state) + "\n")
    print("agent_configuration_prepared")


def report(args):
    path = Path(args.state)
    state = decode(private_file(path))
    require(state.get("schema_version") == 1, "invalid_local_state")
    require(type(state.get("profile_version_id")) is str and re.fullmatch(UUID, state["profile_version_id"]) is not None,
            "invalid_local_state")
    require(type(state.get("checksum")) is str and re.fullmatch(r"[0-9a-f]{64}", state["checksum"]) is not None,
            "invalid_local_state")
    request(state["management_url"], "/api/v1/agent/config-reports", key_file(Path(args.key_file)),
            state.get("management_ca"), {"profile_version_id": state["profile_version_id"],
            "checksum": state["checksum"], "result": args.result, "agent_version": VERSION})
    state["report_pending"] = False
    state["last_report_result"] = args.result
    temporary = path.with_name("state.report-" + str(os.getpid()) + ".tmp")
    write_private(temporary, json_text(state) + "\n")
    os.replace(temporary, path)
    print("agent_configuration_reported_" + args.result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    prepare_parser = sub.add_parser("prepare")
    for name in ("os", "management-url", "gateway-origin", "key-file", "destination", "runtime-dir"):
        prepare_parser.add_argument("--" + name, required=True, choices=("linux", "windows") if name == "os" else None)
    for name in ("management-ca", "gateway-ca", "previous-state"):
        prepare_parser.add_argument("--" + name)
    report_parser = sub.add_parser("report")
    report_parser.add_argument("--state", required=True)
    report_parser.add_argument("--key-file", required=True)
    report_parser.add_argument("--result", required=True, choices=("applied", "failed"))
    args = parser.parse_args()
    try:
        require(sys.version_info >= (3, 11), "python_3_11_required")
        (prepare if args.command == "prepare" else report)(args)
        return 0
    except AgentError as error:
        print("agent_error: " + str(error), file=sys.stderr)
    except Exception:
        # Includes malformed/deep JSON, TLS PEM and filesystem/runtime failures.
        # Never expose exception text or a traceback containing sensitive paths.
        print("agent_error: local_file_or_configuration_error", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
