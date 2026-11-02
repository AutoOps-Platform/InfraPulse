#!/usr/bin/env python3
"""Root-only, fixed-path Linux lifecycle. Never executes a Telegraf probe.

Invoke through install.sh/uninstall.sh. Only service-manager startup is used as
activation evidence; it is not evidence of metric delivery or backend Online.
All subprocess output is discarded, including provisioning and service errors.
"""
from __future__ import annotations

import argparse
import fcntl
import grp
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import time
from urllib.parse import urlsplit

ROOT = Path("/opt/infrapulse-agent")
RELEASES = ROOT / "releases"
CURRENT = ROOT / "current"
UNIT = Path("/etc/systemd/system/infrapulse-telegraf.service")
UNIT_NAME = UNIT.name
ACCOUNT = "infrapulse-telegraf"
OWNER = "InfraPulse Linux installation v1\n"
RELEASE_OWNER = "InfraPulse Linux release v1\n"
RELEASE_RE = re.compile(r"r-[0-9]{14}-[a-f0-9]{16}\Z")
SCRIPT = Path(__file__).absolute()
BUNDLE = SCRIPT.parent.parent
UNIT_SOURCE = SCRIPT.parent / UNIT_NAME
LOCK = Path("/run/infrapulse-agent.lock")
LOGS = Path("/var/lib/infrapulse-agent")
MAX_FILE = 8 * 1024 * 1024


class Refusal(Exception):
    """Messages must be finite, prewritten, and contain no external data."""


def event(message: str) -> None:
    print("InfraPulse: " + message, file=sys.stderr, flush=True)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise Refusal(message)


def exists(path: Path) -> bool:
    return os.path.lexists(path)


def regular(path: Path, *, private: bool = False, owned: bool = True) -> os.stat_result:
    for parent in path.parents:
        parent_info = parent.lstat()
        require(stat.S_ISDIR(parent_info.st_mode), "refusing a symlink in a source or managed path.")
        if private:
            require(parent_info.st_uid == 0 and (not parent_info.st_mode & 0o022
                    or bool(parent_info.st_mode & stat.S_ISVTX)),
                    "private key ancestors must be root-controlled directories.")
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
            "refusing a link or nonregular file.")
    if owned:
        require(info.st_uid == 0 and not info.st_mode & 0o022,
                "refusing a file with unsafe ownership or permissions.")
    if private:
        require(info.st_uid == 0 and not info.st_mode & 0o077,
                "key source must be a root-owned private file (0600).")
    return info


def directory(path: Path) -> None:
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0
            and not info.st_mode & 0o022,
            "refusing an unsafe directory or directory symlink.")


def ancestors(path: Path) -> None:
    for parent in reversed(path.parents):
        directory(parent)


def small_text(path: Path) -> str:
    info = regular(path)
    require(info.st_size <= MAX_FILE, "managed metadata exceeds the size limit.")
    return path.read_text(encoding="utf-8")


def atomic_bytes(path: Path, data: bytes, mode: int = 0o600, gid: int = 0) -> None:
    directory(path.parent)
    if exists(path):
        regular(path)
    temporary = path.parent / (".write-" + secrets.token_hex(12))
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchown(stream.fileno(), 0, gid)
            os.fchmod(stream.fileno(), mode)
        os.replace(temporary, path)
    finally:
        if exists(temporary):
            regular(temporary)
            temporary.unlink()


def make_dir(path: Path, mode: int = 0o750, gid: int = 0) -> None:
    directory(path.parent)
    path.mkdir(mode=mode)
    os.chown(path, 0, gid)
    os.chmod(path, mode)


def safe_tree(path: Path) -> None:
    """No symlinks, hardlinks, devices, non-root owners or writable groups."""
    directory(path)
    for entry in path.iterdir():
        info = entry.lstat()
        if stat.S_ISDIR(info.st_mode):
            safe_tree(entry)
        else:
            regular(entry)
            require(not info.st_mode & 0o007 or entry.name == "telegraf"
                    and entry.parent.name == "bin" and stat.S_IMODE(info.st_mode) == 0o755,
                    "refusing world-accessible managed data.")


def remove_release(path: Path) -> None:
    # Validate the absolute deletion boundary immediately before recursive removal.
    require(path.parent == RELEASES and (RELEASE_RE.fullmatch(path.name)
            or re.fullmatch(r"\.stage-[a-f0-9]{16}", path.name)),
            "refusing cleanup outside the managed releases directory.")
    directory(ROOT)
    directory(RELEASES)
    safe_tree(path)
    require(small_text(path / ".release-owner") == RELEASE_OWNER,
            "refusing cleanup of an unrecognized release.")
    shutil.rmtree(path)


def current_release() -> Path | None:
    if not exists(CURRENT):
        return None
    info = CURRENT.lstat()
    require(stat.S_ISLNK(info.st_mode) and info.st_uid == 0,
            "current must be the root-owned internal managed pointer.")
    target = os.readlink(CURRENT)
    require(target.startswith("releases/") and target.count("/") == 1
            and RELEASE_RE.fullmatch(target.split("/")[1]) is not None,
            "refusing an external or unrecognized current pointer.")
    result = ROOT / target
    directory(result)
    require(small_text(result / ".release-owner") == RELEASE_OWNER,
            "current does not identify a managed release.")
    return result


def inspect_root() -> Path | None:
    ancestors(ROOT)
    if not exists(ROOT):
        return None
    directory(ROOT)
    require(small_text(ROOT / ".owner") == OWNER,
            "installation root is not owned by this installer.")
    require({p.name for p in ROOT.iterdir()} <= {".owner", "releases", "current", ".transaction"},
            "installation root contains unrecognized entries.")
    require(not exists(ROOT / ".transaction"),
            "an interrupted transaction requires administrator recovery before changes.")
    directory(RELEASES)
    for release in RELEASES.iterdir():
        require(RELEASE_RE.fullmatch(release.name) is not None,
                "releases directory contains an unrecognized entry.")
        safe_tree(release)
        require(small_text(release / ".release-owner") == RELEASE_OWNER,
                "refusing an unrecognized release.")
    return current_release()


def unit_template() -> bytes:
    # Source bundle is operator-controlled, but must not introduce linked files.
    info = regular(UNIT_SOURCE, owned=False)
    require(info.st_size <= 16384, "unit template exceeds its size limit.")
    return UNIT_SOURCE.read_bytes()


def systemd_property(name: str) -> str:
    try:
        completed = subprocess.run(["systemctl", "show", "--property=" + name, "--value", UNIT_NAME],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, check=False, timeout=30,
                                   env=clean_environment())
    except (OSError, subprocess.TimeoutExpired):
        raise Refusal("cannot establish ownership of the systemd service.") from None
    require(completed.returncode == 0 and len(completed.stdout) <= 16384,
            "cannot establish ownership of the systemd service.")
    return completed.stdout.decode("utf-8", errors="strict").strip()


def inspect_unit(template: bytes, have_installation: bool) -> bool:
    ancestors(UNIT)
    directory(UNIT.parent)
    for base in (Path("/etc/systemd/system"), Path("/run/systemd/system"),
                 Path("/usr/local/lib/systemd/system"), Path("/usr/lib/systemd/system"),
                 Path("/lib/systemd/system"), Path("/etc/systemd/system.control"),
                 Path("/run/systemd/system.control"), Path("/run/systemd/transient"),
                 Path("/run/systemd/generator"), Path("/run/systemd/generator.early"),
                 Path("/run/systemd/generator.late")):
        # Vendor directories may themselves be distribution-managed symlinks.
        require(not exists(base / (UNIT_NAME + ".d")),
                "refusing systemd overrides for the managed unit.")
        if base != UNIT.parent:
            require(not exists(base / UNIT_NAME),
                    "refusing an external unit with the managed service name.")
    for base in (Path("/etc/systemd/system"), Path("/run/systemd/system")):
        for link in base.glob("*.wants/" + UNIT_NAME):
            item = link.lstat()
            require(link == UNIT.parent / "multi-user.target.wants" / UNIT_NAME
                    and stat.S_ISLNK(item.st_mode) and item.st_uid == 0
                    and os.readlink(link) == str(UNIT) and have_installation,
                    "refusing an unrelated or unsafe service enablement link.")
        require(not any(base.glob("*.requires/" + UNIT_NAME)),
                "refusing unrecognized service dependency links.")
    # Inspect effective service-manager metadata as well as disk ownership. This
    # catches transient units, global drop-ins and a still-loaded deleted unit.
    fragment = systemd_property("FragmentPath")
    require(not systemd_property("DropInPaths"), "refusing effective systemd unit overrides.")
    if not exists(UNIT):
        require(not have_installation and not fragment,
                "managed unit is absent or an external loaded service exists.")
        require(not systemctl("is-active", "--quiet", UNIT_NAME, required=False),
                "an active unrecognized service uses the managed name.")
        return False
    regular(UNIT)
    require(have_installation and UNIT.read_bytes() == template and fragment == str(UNIT),
            "refusing an unrelated or locally modified service unit.")
    return True


def run(arguments: list[str], *, required: bool = True, timeout: int = 120,
        failure: str = "a required local operation failed; raw output was suppressed.") -> bool:
    try:
        completed = subprocess.run(arguments, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   timeout=timeout, check=False, env=clean_environment())
        ok = completed.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        ok = False
    if required:
        require(ok, failure)
    return ok


def clean_environment() -> dict[str, str]:
    # No inherited API keys, Python hooks or service environment reach children.
    return {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8",
            "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1"}


def systemctl(*arguments: str, required: bool = True) -> bool:
    operation = arguments[0] if arguments else "unknown"
    require(operation in {"is-active", "is-enabled", "daemon-reload", "enable", "disable", "restart", "stop", "start"},
            "unrecognized service-manager operation.")
    return run(["systemctl", *arguments], required=required,
               failure="systemd " + operation + " failed; inspect the private local log and owned unit.")


def ensure_account(create: bool) -> int:
    try:
        user = pwd.getpwnam(ACCOUNT)
    except KeyError:
        require(create, "managed service account is missing.")
        try:
            grp.getgrnam(ACCOUNT)
        except KeyError:
            run(["groupadd", "--system", ACCOUNT], failure="dedicated service group creation failed.")
        else:
            raise Refusal("refusing a preexisting group without the dedicated account.")
        shell = next((p for p in ("/usr/sbin/nologin", "/sbin/nologin") if Path(p).is_file()), None)
        require(shell is not None, "a nologin shell is required.")
        run(["useradd", "--system", "--gid", ACCOUNT, "--home-dir", str(ROOT),
             "--no-create-home", "--shell", shell, ACCOUNT],
            failure="dedicated service account creation failed.")
        user = pwd.getpwnam(ACCOUNT)
    group = grp.getgrnam(ACCOUNT)
    require(0 < user.pw_uid < 1000 and user.pw_gid == group.gr_gid
            and user.pw_dir == str(ROOT)
            and user.pw_shell in ("/usr/sbin/nologin", "/sbin/nologin")
            and set(group.gr_mem) <= {ACCOUNT},
            "refusing an account or group not dedicated to this installation.")
    require(not any(p.pw_name != ACCOUNT and (p.pw_gid == group.gr_gid or p.pw_uid == user.pw_uid)
                    for p in pwd.getpwall()),
            "the service UID or group is shared by another account.")
    require(set(os.getgrouplist(ACCOUNT, group.gr_gid)) == {group.gr_gid},
            "the dedicated account has unexpected supplementary groups.")
    return group.gr_gid


def inspect_logs(uid: int, gid: int, *, recognized: bool) -> None:
    ancestors(LOGS)
    if not exists(LOGS):
        return
    require(recognized, "refusing a preexisting log directory without a managed installation.")
    info = LOGS.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == uid and info.st_gid == gid
            and stat.S_IMODE(info.st_mode) == 0o700,
            "private log directory ownership or permissions are not recognized.")
    for path in LOGS.iterdir():
        item = regular(path, owned=False)
        require(item.st_uid == uid and item.st_gid == gid and stat.S_IMODE(item.st_mode) == 0o600,
                "refusing unsafe entries in the private log directory.")


def create_logs(uid: int, gid: int) -> None:
    if exists(LOGS):
        return
    directory(LOGS.parent)
    LOGS.mkdir(mode=0o700)
    os.chown(LOGS, uid, gid)
    os.chmod(LOGS, 0o700)


def remove_logs(uid: int, gid: int) -> None:
    # Only flat, nonlinked service-owned files under this exact fixed directory.
    require(LOGS == Path("/var/lib/infrapulse-agent"), "refusing an unexpected log cleanup boundary.")
    inspect_logs(uid, gid, recognized=True)
    if exists(LOGS):
        for path in list(LOGS.iterdir()):
            regular(path, owned=False)
            path.unlink()
        LOGS.rmdir()


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def copy_binary(source: Path, destination: Path, expected: str) -> None:
    regular(source, owned=False)
    require(re.fullmatch(r"[a-fA-F0-9]{64}", expected) is not None,
            "a complete independently verified SHA-256 is required.")
    shutil.copyfile(source, destination, follow_symlinks=False)
    os.chown(destination, 0, 0)
    os.chmod(destination, 0o755)
    require(digest(destination) == expected.lower(), "Telegraf binary SHA-256 did not match.")
    # Deliberately do not execute --version, --test or configuration validation.


def copy_sources(source: Path, destination: Path) -> None:
    info = source.lstat()
    require(stat.S_ISDIR(info.st_mode), "bundle source directory must not be a symlink.")
    make_dir(destination, 0o700)
    for entry in source.iterdir():
        if entry.name == "__pycache__" or entry.suffix == ".pyc":
            continue
        item = entry.lstat()
        require(not stat.S_ISLNK(item.st_mode), "bundle sources must not contain symlinks.")
        target = destination / entry.name
        if stat.S_ISDIR(item.st_mode):
            copy_sources(entry, target)
        else:
            regular(entry, owned=False)
            shutil.copyfile(entry, target, follow_symlinks=False)
            os.chown(target, 0, 0)
            os.chmod(target, 0o600)


def read_metadata(previous: Path | None) -> dict:
    if previous is None:
        return {}
    metadata = json.loads(small_text(previous / "install.json"))
    require(isinstance(metadata, dict) and set(metadata) == {
        "schema_version", "management_url", "gateway_origin", "binary_sha256",
        "management_ca", "gateway_ca"} and metadata["schema_version"] == 1,
        "installed lifecycle metadata is unrecognized.")
    state = json.loads(small_text(previous / "state.json"))
    require(isinstance(state, dict) and state.get("schema_version") == 1
            and state.get("os") == "linux"
            and state.get("management_url") == metadata["management_url"]
            and state.get("gateway_origin") == metadata["gateway_origin"],
            "installed provisioning state does not match lifecycle metadata.")
    return metadata


def origin(value: str | None) -> str:
    require(isinstance(value, str), "explicit HTTPS origins are required on initial installation.")
    parsed = urlsplit(value)
    require(parsed.scheme == "https" and parsed.hostname is not None
            and not parsed.username and not parsed.password and parsed.path in ("", "/")
            and not parsed.query and not parsed.fragment and not any(c.isspace() for c in value),
            "an origin must be HTTPS with no path, credentials, query or fragment.")
    port = parsed.port
    require(port is None or 1 <= port <= 65535, "invalid HTTPS origin port.")
    require(value.isascii() and not re.search(r"[\x00-\x20\x7f\\@$%{}]", value),
            "invalid HTTPS origin characters.")
    host = parsed.hostname.lower()
    if ":" in host:
        host = "[" + host + "]"
    return "https://" + host + (":" + str(port) if port not in (None, 443) else "")


def switch_current(release: Path | None) -> None:
    old = current_release()
    if release is None:
        if old is not None:
            CURRENT.unlink()
        return
    require(release.parent == RELEASES and RELEASE_RE.fullmatch(release.name) is not None,
            "refusing a current pointer outside managed releases.")
    directory(release)
    temporary = ROOT / (".pointer-" + secrets.token_hex(12))
    os.symlink("releases/" + release.name, temporary)
    try:
        os.replace(temporary, CURRENT)
    finally:
        if exists(temporary):
            require(temporary.is_symlink(), "temporary pointer was replaced unexpectedly.")
            temporary.unlink()


def report(release: Path, result: str) -> bool:
    return run([sys.executable, "-I", str(release / "bundle/common/agentctl.py"),
                "report", "--state", str(release / "state.json"),
                "--key-file", str(release / "api-key"), "--result", result],
               required=False, timeout=90)


def retire_previous(previous: Path | None) -> None:
    if previous is None:
        return
    try:
        # Do not destroy an explicit retry receipt/key that still needs reporting.
        state = json.loads(small_text(previous / "state.json"))
        if state.get("report_pending") is not False:
            event("previous protected release retained because its config report is pending.")
            return
        require(current_release() != previous, "refusing cleanup of the active release.")
        remove_release(previous)
        event("superseded acknowledged release and its local credentials removed.")
    except (Refusal, OSError, ValueError, KeyError, TypeError, UnicodeError):
        event("WARNING: superseded release cleanup deferred; protected credentials remain.")


def secure_release(release: Path, gid: int) -> None:
    # Only Telegraf's config, CA and binary hierarchy is service-readable.
    for path in release.rglob("*"):
        info = path.lstat()
        require(not stat.S_ISLNK(info.st_mode), "renderer emitted a forbidden symlink.")
        if stat.S_ISDIR(info.st_mode):
            os.chown(path, 0, gid if path.name in ("conf.d", "bin") else 0)
            os.chmod(path, 0o750 if path.name in ("conf.d", "bin") else 0o700)
        else:
            regular(path)
            binary = path == release / "bin/telegraf"
            readable = (path.name in ("telegraf.conf", "management-ca.pem", "gateway-ca.pem")
                        and path.parent == release) or path.parent == release / "conf.d"
            os.chown(path, 0, gid if readable else 0)
            os.chmod(path, 0o755 if binary else 0o640 if readable else 0o600)
    os.chown(release, 0, gid)
    os.chmod(release, 0o750)
    safe_tree(release)


def rendered_layout(stage: Path) -> None:
    conf = stage / "conf.d"
    if not exists(conf):
        make_dir(conf, 0o700)
    directory(conf)
    for name in ("inputs.conf", "output.conf"):
        if exists(stage / name):
            regular(stage / name)
            require(not exists(conf / name), "renderer emitted conflicting config layouts.")
            (stage / name).rename(conf / name)
        regular(conf / name)
    require({p.name for p in conf.iterdir()} == {"inputs.conf", "output.conf"},
            "renderer emitted unrecognized additional plugins.")
    for name in ("telegraf.conf", "api-key", "state.json"):
        regular(stage / name)
    require({p.name for p in stage.iterdir()} <= {
        "telegraf.conf", "api-key", "state.json", "conf.d", "management-ca.pem", "gateway-ca.pem"},
        "renderer emitted unrecognized release files.")
    safe_tree(stage)


def install(options: argparse.Namespace) -> None:
    previous = inspect_root()
    template = unit_template()
    had_unit = inspect_unit(template, previous is not None)
    # A failed first activation retains its receipt. Reinstallation must not
    # silently bind that protected root to a different Server/Agent either.
    binding = previous
    if binding is None and exists(RELEASES):
        retained = sorted(RELEASES.iterdir(), key=lambda path: path.name)
        if retained:
            binding = retained[-1]
    metadata = read_metadata(binding)
    management = origin(options.management_url or metadata.get("management_url"))
    gateway = origin(options.gateway_origin or metadata.get("gateway_origin"))
    require((options.telegraf_binary is None) == (options.telegraf_sha256 is None),
            "--telegraf-binary and --telegraf-sha256 must be supplied together.")
    if options.telegraf_binary is not None:
        binary = Path(options.telegraf_binary).absolute()
        expected_hash = options.telegraf_sha256
    else:
        require(binding is not None and options.update_config,
                "supply a reviewed Telegraf binary and checksum, or use --update-config on an installation.")
        binary = binding / "bin/telegraf"
        expected_hash = metadata["binary_sha256"]
    regular(binary, owned=False)
    require(isinstance(expected_hash, str) and re.fullmatch(r"[a-fA-F0-9]{64}", expected_hash) is not None,
            "a complete independently verified SHA-256 is required.")
    key = Path(options.key_file).absolute() if options.key_file else None
    if key is not None:
        regular(key, private=True)
        # The core also validates key format without printing it.
    else:
        require(binding is not None, "a private --key-file or interactive prompt is required.")
        key = binding / "api-key"
        regular(key)
        regular(key, private=True)
        require(stat.S_IMODE(key.stat().st_mode) == 0o600,
                "installed credential permissions are not recognized.")
    cas = {}
    for kind in ("management", "gateway"):
        supplied = getattr(options, kind + "_ca")
        ca = Path(supplied).absolute() if supplied else (
            binding / (kind + "-ca.pem") if binding and metadata.get(kind + "_ca") else None)
        if ca is not None:
            regular(ca, owned=not bool(supplied))
        cas[kind] = ca
    gid = ensure_account(create=True)
    uid = pwd.getpwnam(ACCOUNT).pw_uid
    inspect_logs(uid, gid, recognized=exists(ROOT))
    if not exists(ROOT):
        make_dir(ROOT, 0o750, gid)
        atomic_bytes(ROOT / ".owner", OWNER.encode())
        make_dir(RELEASES, 0o750, gid)
    create_logs(uid, gid)
    was_active = had_unit and systemctl("is-active", "--quiet", UNIT_NAME, required=False)
    was_enabled = had_unit and systemctl("is-enabled", "--quiet", UNIT_NAME, required=False)
    name = "r-" + time.strftime("%Y%m%d%H%M%S", time.gmtime()) + "-" + secrets.token_hex(8)
    final = RELEASES / name
    stage = RELEASES / (".stage-" + secrets.token_hex(8))
    # The shared CLI requires an existing empty private destination. Keep its
    # owner marker outside until rendering succeeds; partial failures remain
    # bounded by this transaction's unpredictable staging path.
    journal = ROOT / ".transaction"
    atomic_bytes(journal, json.dumps({"operation": "install", "previous": previous.name if previous else None,
                                     "attempted": name}).encode())
    activated = False
    attempted_activation = False
    try:
        make_dir(stage, 0o700)
        prepare = [sys.executable, "-I", str(BUNDLE / "common/agentctl.py"), "prepare", "--os", "linux",
                   "--management-url", management, "--gateway-origin", gateway,
                   "--key-file", str(key), "--destination", str(stage), "--runtime-dir", str(final)]
        for kind, ca in cas.items():
            if ca is not None:
                prepare.extend(["--" + kind + "-ca", str(ca)])
        if binding is not None:
            prepare.extend(["--previous-state", str(binding / "state.json")])
        run(prepare, timeout=180,
            failure="provisioning/rendering failed; check HTTPS trust, private key, pinned gateway and profile binding.")
        rendered_layout(stage)
        atomic_bytes(stage / ".release-owner", RELEASE_OWNER.encode())
        make_dir(stage / "bin", 0o700)
        copy_binary(binary, stage / "bin/telegraf", expected_hash)
        make_dir(stage / "bundle", 0o700)
        for directory_name in ("common", "templates", "linux"):
            copy_sources(BUNDLE / directory_name, stage / "bundle" / directory_name)
        atomic_bytes(stage / "install.json", json.dumps({
            "schema_version": 1, "management_url": management, "gateway_origin": gateway,
            "binary_sha256": expected_hash.lower(), "management_ca": cas["management"] is not None,
            "gateway_ca": cas["gateway"] is not None}, sort_keys=True).encode())
        secure_release(stage, gid)
        require(not exists(final), "release destination already exists.")
        stage.rename(final)
        # From this point all failures restore local files and service-manager state.
        attempted_activation = True
        atomic_bytes(UNIT, template, mode=0o644)
        switch_current(final)
        systemctl("daemon-reload")
        systemctl("enable", UNIT_NAME)
        systemctl("restart", UNIT_NAME)
        systemctl("is-active", "--quiet", UNIT_NAME)
        journal.unlink()
        event("local activation accepted; ingestion has not been verified.")
        activated = True
    except BaseException:
        activated = False
        rollback_ok = True
        if attempted_activation:
            event("activation failed; restoring the previous local installation.")
            try:
                systemctl("stop", UNIT_NAME)
                switch_current(previous)
                if had_unit:
                    atomic_bytes(UNIT, template, mode=0o644)
                else:
                    systemctl("disable", UNIT_NAME, required=False)
                    regular(UNIT)
                    require(UNIT.read_bytes() == template, "refusing removal of a changed unit.")
                    UNIT.unlink()
                systemctl("daemon-reload")
                if had_unit:
                    systemctl("enable" if was_enabled else "disable", UNIT_NAME)
                    if was_active:
                        systemctl("start", UNIT_NAME)
                        systemctl("is-active", "--quiet", UNIT_NAME)
                event("previous local service state restored.")
            except BaseException:
                rollback_ok = False
                event("WARNING: rollback incomplete; transaction retained for administrator recovery.")
            if exists(final):
                if not report(final, "failed"):
                    event("WARNING: failed-activation report pending; retry from the retained attempted release.")
        if exists(stage):
            try:
                # Only a stage this transaction created may be marked for bounded cleanup.
                safe_tree(stage)
                if not exists(stage / ".release-owner"):
                    atomic_bytes(stage / ".release-owner", RELEASE_OWNER.encode())
                remove_release(stage)
            except BaseException:
                rollback_ok = False
                event("WARNING: protected staging data retained for administrator recovery.")
        if rollback_ok and exists(journal):
            journal.unlink()
        raise
    finally:
        # Never roll back local success merely because the report endpoint failed.
        if activated:
            if not report(final, "applied"):
                event("WARNING: local success retained; config report pending for explicit retry.")
            retire_previous(previous)
            event("release retained with protected report-retry tooling.")


def uninstall() -> None:
    previous = inspect_root()
    if not exists(ROOT):
        require(not exists(UNIT), "an external service exists without a managed installation.")
        event("no managed installation found; nothing removed.")
        return
    template = unit_template()
    had_unit = inspect_unit(template, previous is not None)
    gid = ensure_account(create=False)
    uid = pwd.getpwnam(ACCOUNT).pw_uid
    inspect_logs(uid, gid, recognized=True)
    if had_unit:
        systemctl("stop", UNIT_NAME)
        require(not systemctl("is-active", "--quiet", UNIT_NAME, required=False),
                "service is still active; removal refused.")
        systemctl("disable", UNIT_NAME)
        regular(UNIT)
        require(UNIT.read_bytes() == template, "refusing removal of a changed unit.")
        UNIT.unlink()
        systemctl("daemon-reload")
    remove_logs(uid, gid)
    # Current is the only allowed symlink. Validate again before unlinking it.
    switch_current(None)
    for release in list(RELEASES.iterdir()):
        remove_release(release)
    directory(RELEASES)
    require(not any(RELEASES.iterdir()), "managed releases directory is not empty.")
    RELEASES.rmdir()
    require(small_text(ROOT / ".owner") == OWNER, "installation owner marker changed.")
    (ROOT / ".owner").unlink()
    require(ROOT == Path("/opt/infrapulse-agent") and not any(ROOT.iterdir()),
            "refusing removal of a nonempty installation root.")
    ROOT.rmdir()
    event("owned local service and credentials removed; service account retained.")
    event("backend credential revocation is a separate Admin task.")


class SafeParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        # argparse's default error can echo untrusted argument contents.
        self.exit(2, "InfraPulse: invalid arguments; use --help for the accepted interface.\n")


def arguments() -> argparse.Namespace:
    parser = SafeParser(description="InfraPulse fixed-path Linux lifecycle (Python 3.11+).")
    commands = parser.add_subparsers(dest="command", required=True, parser_class=SafeParser)
    setup = commands.add_parser("install", help="prepare, atomically activate and report")
    for argument in ("management-url", "gateway-origin", "key-file", "management-ca", "gateway-ca",
                     "telegraf-binary", "telegraf-sha256"):
        setup.add_argument("--" + argument)
    setup.add_argument("--update-config", action="store_true", help="reuse the checksum-pinned installed binary")
    commands.add_parser("uninstall", help="remove only this installer's owned local service and credentials")
    return parser.parse_args()


def interrupted(signum: int, frame: object) -> None:
    # Convert catchable signals into the same transaction rollback path as errors.
    raise Refusal("operation interrupted; local rollback requested.")


def main() -> int:
    options = arguments()
    require(sys.version_info >= (3, 11), "Python 3.11 or newer is required.")
    require(sys.platform.startswith("linux") and os.geteuid() == 0, "Linux root privileges are required.")
    os.umask(0o077)
    # Resolve utilities only from a fixed system path, never the caller's PATH.
    os.environ["PATH"] = clean_environment()["PATH"]
    require(Path("/run/systemd/system").is_dir() and shutil.which("systemctl") is not None,
            "a running systemd installation is required.")
    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, interrupted)
    ancestors(LOCK)
    directory(LOCK.parent)
    fd = os.open(LOCK, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == 0
                and stat.S_IMODE(info.st_mode) == 0o600, "unsafe lifecycle lock file.")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refusal("another installer or uninstaller holds the lifecycle lock.") from None
        if options.command == "install":
            install(options)
        else:
            uninstall()
    finally:
        os.close(fd)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Refusal as failure:
        event(str(failure))
        raise SystemExit(1) from None
    except (OSError, ValueError, KeyError, TypeError, UnicodeError):
        event("operation refused or failed; inspect protected local state, not raw service output.")
        raise SystemExit(1) from None
