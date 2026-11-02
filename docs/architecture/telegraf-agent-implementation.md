# Step 4 implementation decisions

Historical status of the original implementation stage: source-only, runtime acceptance explicitly deferred, with no test/installer/service/metric execution authorized then. The user subsequently authorized a separate Linux vm-1 lab on 2026-11-02; see the [measured lab record](<../testing/telegraf-agent-vm1-20261102.md>) for its limited runtime evidence and Ubuntu log-path correction. Windows/full acceptance remain pending.

## Contract and boundaries

- Reuse NestJS `GET /api/v1/agent/provisioning` and `POST /api/v1/agent/config-reports`, authoritative IDs, immutable profile versions and SHA-256 of canonical JSON config. No enrollment, issuance, SQL, new heartbeat, custom Telegraf collector or automatic remote executor.
- Shared Python 3.11+ standard-library provisioning/rendering tool; Bash/systemd Linux lifecycle and PowerShell/SCM Windows lifecycle. Python is an explicit installation prerequisite, not a persistent companion service. Profiles from NestJS remain authoritative; local JSON documents mirror seed defaults for review, never override provisioning.
- Administrator supplies a reviewed official Telegraf executable and independently verified SHA-256. No implicit package manager or download, no `latest` version, no executing a downloaded installer. The package supports native architecture when the operator supplies the correct binary; baseline qualification will use Telegraf 1.38.2 on Linux/Windows amd64.
- Fixed owned installation paths, private staging, single-writer lock, refuse unrelated services/path ownership and unsafe links; reinstall/update preserves immutable Server/Agent binding. Full desired configuration regenerated per update, no arbitrary plugin/script injection.
- Credentials are passed only in private files or a protected interactive prompt, never argv or machine-wide environment. Rendered output configuration contains the key and is treated as secret. Dedicated unprivileged Linux service user; Windows LocalSystem with SYSTEM/Administrators-only installation ACL. No service command line includes a key.
- HTTPS is mandatory for provisioning and output. Explicit operator-pinned Gateway origin must equal provisioning origin before forwarding credential. TLS hostname/certificate verification and optional separate CA bundles; no insecure switch. Provisioning/report redirects are disabled. Upstream Telegraf HTTP output follows standard redirects and has no exposed disable option: this is a documented limitation, so use a final non-redirecting trusted HTTPS metrics endpoint; the origin pin is an initial-target check, not redirect/egress confinement. Existing loopback HTTP Compose remains unchanged; optional direct TLS listeners/Compose override expose reviewed bind addresses only, no Nginx.
- Config report `applied` means local files activated and service manager accepted startup, never ingestion/Online proof. Failed activation restores the prior local installation where possible and reports failed for the attempted receipt. Failed report after successful activation must not roll back a healthy service; retain protected state for explicit report retry. No automatic config polling or binary auto-update.

## Work ledger

| Task | Interface / overlap | Decision |
| --- | --- | --- |
| Shared renderer/provisioning | Emits staged `telegraf.conf`, `conf.d/inputs.conf`, `conf.d/output.conf`, `api-key`, `state.json`; lifecycle activates a concrete protected release | Secret-free state carries profile receipt and management TLS settings; report reads separate key |
| Linux / Windows lifecycle | Consume same CLI and same staged layout, own disjoint platform files | Retain prior installation for rollback until activation succeeds; never mutate external Telegraf |
| TLS deployment | Optional Management HTTPS listener + Gateway Uvicorn TLS override | Preserve management HTTP for internal Gateway RPC; do not break Step 3 internal service auth |
| Docs/source review | Describe implemented CLI, protected files, offline preparation and pending tests | Static source/diff review only; no runtime or syntax-check claims |

Ruling: use a shared Python provisioning/renderer and operator-supplied checksum-verified upstream Telegraf instead of patched collectors or installers that fetch latest — minimizes supply-chain and duplicated rendering logic; costs an explicit Python prerequisite on Windows.

Ruling: preserve existing HTTP internal management listener and add opt-in direct HTTPS for Agent control-plane access — avoids changing Gateway RPC trust; operators must configure certificates, bind address and firewall before VM deployment.

Ruling: execute directly in the requested repository without staging/committing or a separate design-approval cycle — follows the explicit implementation request and Git safety; changes remain reviewable in the working tree.

## Source review record (not runtime validation)

- Read the complete project introduction, actual backend provisioning/profile/credential code and Gateway CredentialProvider/wire limits. Existing routes, profile schema, seed records and Gateway source were not changed.
- Referenced the older project's Agent README and Linux filesystem/Windows transaction source for ownership/lock/rollback ideas only. No OpsGrid enrollment API, patched binary, custom collector, identity policy or code was imported.
- Read official Telegraf 1.38.2 source for HTTP output, raw-Snappy serializer, Windows service construction, TLS/proxy and environment substitution. Output must use `data_format = "prometheusremotewrite"` with HTTP `content_encoding = "identity"`: the serializer already performs Snappy compression. Literal dollars are escaped with Compose `$$` after TOML parsing; trusted template substitution is single-pass and never interprets placeholder-like profile values.
- Parent inspected the Linux source and shared interfaces; independent scoped source review covered the shared helper, Windows lifecycle, profiles/templates and optional TLS. Review corrections include Windows JSON closure, native CRT argument quoting, validating existing ACLs before trusting state, private logging, isolated Python execution, bounded old-release cleanup, exact backend dollar restrictions, retaining Windows ownership marker under the lock, and cleanup of partially successful native SCM installation only after candidate ownership validation (foreign pre-existing EventLog sources are refused). Follow-up source review found the scoped code findings addressed; architecture redirect wording corrected to match the upstream limitation.
- Git status/diff and Code Graph change-impact inspection found the intended Step 4 additions plus optional TLS bootstrap/example changes. Graph results are bounded/best-effort; changed source was read directly. No application code, test, parser, syntax check, lint, build, installer, service or metric request was executed. This record does not establish compilation, platform compatibility or runtime acceptance.

## Changed-file inventory

Original source-only stage inventory: 28 new files, two modified files; not a runtime acceptance record. The later authorized lab adds the [Linux path regression](<../../agents/telegraf/tests/test_linux_paths.py>), [lab report](<../testing/telegraf-agent-vm1-20261102.md>) and [sanitized measured evidence](<../testing/evidence/telegraf-agent-vm1-20261102.json>). It also aligns the existing Linux lifecycle/renderer/unit with the private `/var/lib` log location and updates documentation; it does not change provisioning/profile/credential APIs.

| Area | New/modified files |
| --- | --- |
| Checkout portability | New [`.gitattributes`](<../../.gitattributes>) (explicit script/template line endings) |
| Shared control/config | New [`agentctl.py`](<../../agents/telegraf/common/agentctl.py>) |
| Linux lifecycle | New [`install.sh`](<../../agents/telegraf/linux/install.sh>), [`uninstall.sh`](<../../agents/telegraf/linux/uninstall.sh>), [`lifecycle.py`](<../../agents/telegraf/linux/lifecycle.py>), [`systemd unit`](<../../agents/telegraf/linux/infrapulse-telegraf.service>) |
| Windows lifecycle | New [`install.ps1`](<../../agents/telegraf/windows/install.ps1>), [`uninstall.ps1`](<../../agents/telegraf/windows/uninstall.ps1>), [`AgentLifecycle.psm1`](<../../agents/telegraf/windows/AgentLifecycle.psm1>) |
| Profile mirrors | New [`linux-base.json`](<../../agents/telegraf/profiles/linux-base.json>), [`windows-base.json`](<../../agents/telegraf/profiles/windows-base.json>) |
| Shared templates | New [`agent.toml.tpl`](<../../agents/telegraf/templates/agent.toml.tpl>), [`output-http.toml.tpl`](<../../agents/telegraf/templates/output-http.toml.tpl>) |
| Linux input templates | New [`cpu.toml`](<../../agents/telegraf/templates/linux/cpu.toml>), [`memory.toml`](<../../agents/telegraf/templates/linux/memory.toml>), [`disk.toml`](<../../agents/telegraf/templates/linux/disk.toml>), [`network.toml`](<../../agents/telegraf/templates/linux/network.toml>), [`system.toml`](<../../agents/telegraf/templates/linux/system.toml>) |
| Windows input templates | New [`cpu.toml`](<../../agents/telegraf/templates/windows/cpu.toml>), [`memory.toml`](<../../agents/telegraf/templates/windows/memory.toml>), [`disk.toml`](<../../agents/telegraf/templates/windows/disk.toml>), [`network.toml`](<../../agents/telegraf/templates/windows/network.toml>), [`system.toml`](<../../agents/telegraf/templates/windows/system.toml>) |
| Opt-in central TLS | New [`agent-tls.ts`](<../../services/management-backend/src/agent-tls.ts>), [`compose.agent-tls.yaml`](<../../deploy/compose/compose.agent-tls.yaml>); modified [`main.ts`](<../../services/management-backend/src/main.ts>), [`.env.example`](<../../.env.example>) |
| Documentation | New [implementation record](<telegraf-agent-implementation.md>), [deployment guide](<../deployment/telegraf-agent.md>), [deferred testing checklist](<../testing/telegraf-agent-checklist.md>) |

## Remaining acceptance work / operational limits

- Execute the entire [deferred checklist](<../testing/telegraf-agent-checklist.md>) on prepared Linux/Windows machines, including syntax/build and real TLS/provisioning/Remote Write/identity/lifecycle verification. No test status is inferred from source inspection.
- Certificates/CA/SAN, operator-reviewed Telegraf binary/hash, published Server profile assignment, issued key with all three scopes, reachable TLS binds and firewall are deployment prerequisites, not generated secrets or automatic server setup.
- No autonomous credential renewal, config polling, persistent metrics queue or collector reimplementation. Size/buffer limits must be qualified against actual server cardinality and existing Gateway limits.
- Linux journal deliberately refuses later mutation after interrupted transactions until Admin recovery. Windows does not implement a power-loss journal; SCM/active-pointer mismatch requires manual ownership-checked recovery. Catchable failures use best-effort rollback, not a crash-atomicity guarantee.
- Protected pending receipts/old releases can retain credentials for explicit reporting or recovery. Uninstall purges owned payload; Admin separately revokes credentials. Review upstream HTTP redirect behavior and use only final trusted metrics endpoints.
