# Ingestion Gateway — Step3 authenticated lab contract

## Current code versus historical shared runtime

The [Step2 GW-01–GW-15 acceptance](<ingestion-gateway-acceptance.md>) is historical evidence (including its UI/native-host checks and limitations), not proof of Step3 deployment. That old lab accepted arbitrary nonempty Bearer/self-declared IDs. **Current Step3 code requires a real scoped Agent credential verified by Management→primary PostgreSQL**. It has no insecure legacy mode. Task13 does not upgrade, bootstrap, migrate or restart the existing four shared services. [Management acceptance](<management-backend-acceptance.md>) records the isolated scope; [Gate T12](<management-backend.md>) is mandatory before any separately authorized shared rollout.

No TLS/LAN/public ingress, real Grafana adapter identity, installer/renderer/VM Telegraf, HA/multi-worker or load qualification is claimed. HTTP lab signatures do not encrypt credentials. Do not widen bindings or edit firewall to make a VM example work.

## Pins and development

Python host3.12; runtime `python:3.12.16-slim-bookworm@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337`, uv0.13.6. Preserve [project pins](<../../services/ingestion-gateway/pyproject.toml>), [frozen lock](<../../services/ingestion-gateway/uv.lock>) and [generated protobuf](<../../services/ingestion-gateway/app/proto/remote_write_pb2.py>); no global upgrade or manual regeneration. The [Dockerfile](<../../services/ingestion-gateway/Dockerfile>) has explicit test and default nonroot runtime targets; runtime has no uv/test development environment.

From Gateway, check each exit before continuing:

```powershell
uv tool run --from uv==0.13.6 uv sync --frozen --group dev
uv tool run --from uv==0.13.6 uv lock --check
# Set a NEW nonexistent basetemp under the ignored task workspace, never its root:
uv tool run --from uv==0.13.6 uv run --frozen pytest -q --basetemp <new-private-task-temp-path>
```

Leave historical `TASK7_RUN_COMPOSE_PATH_CHECK` **unset** (it consults real root dotenv). `TASK12_RUN_COMPOSE_PATH_CHECK=1` is a distinct generated-NONSECRET CLI-path regression. It is not permission to read live dotenv. Default tests never send E2E traffic: [all five retained cases](<../../services/ingestion-gateway/tests/e2e/test_remote_write.py>) skip unless exactly `INFRAPULSE_RUN_E2E=1`; [helper contracts](<../../services/ingestion-gateway/tests/unit/test_e2e_contract.py>) prove offline collection, retry bytes/deadline and whole absence windows. Host tests use fresh private basetemps, never clear shared/global temp or the evidence ledger.

## Real credentials, identity and protocol

Use [the Step4 provisioning contract](<../contracts/agent-provisioning.md>) to obtain the server-configured ingest origin and authoritative UUIDs. Required single-valued headers:

| Header | Current Step3 contract |
|---|---|
| Authorization | `Bearer <issued UUID.secret43 credential>`, `metrics:write`; never arbitrary dummy token |
| X-Server-ID / X-Agent-ID | Optional comparison with trusted proof; malformed/duplicate400, mismatch403 |
| Content-Type | `application/x-protobuf` |
| Content-Encoding | raw/block `snappy`, not framed/gzip/encoding chain |
| X-Prometheus-Remote-Write-Version | `0.1.0` |
| User-Agent | nonempty, bounded256bytes |

`POST /api/v1/ingest/remote-write` accepts the existing scalar Remote Write1.0 subset. Missing payload IDs are injected from the authenticated proof, matching labels retained, conflicting identity/duplicate labels/canonical series reject the **whole batch before forward**. No timestamp correction, finite-float coercion or partial ignore. Empty request/series, recursive unknown fields, metadata, exemplars/native histograms remain rejected. Never call NestJS with raw metrics or choose another Server ID in an installer.

Defaults remain compressed1MiB/decompressed8MiB,5000series,20000samples,64labels **after injection**,2inflight,rate10/s/burst20,age3600seconds/future120seconds/body5seconds. Name/label-name/value UTF8 caps256/128/1024. Connect/read/write/pool/upstream-total/readiness-total seconds2/10/10/1/12/1. A single admission lease includes verification; auth flood is bounded too. This is not a throughput qualification.

Credential verification uses a dedicated signed Management pool/deadline≤2seconds,8KiB response. Whole-key fingerprint cache defaults1024/max10000 entries, positive TTL≤30seconds measured **before RPC**, further bounded by credential expiry. No sliding/negative/error cache or stale fallback. Wrong-secret/same-public-ID is a different fingerprint. Revoke/disable does not promise canceling already authenticated requests or deleting stored samples. Rotation overlap≤300seconds never extends an earlier cutoff.

| Result | Meaning / caller behavior |
|---|---|
| 204 | Auth+validation+Prometheus2xx, not just parse success; do not retry |
| 400 | Invalid headers/body/wire/labels/timestamps or payload identity conflict; fix data |
| 401 | Missing/malformed/expired/revoked/inactive credential; not merely Bearer syntax |
| 403 | Valid optional identity claim conflicts with trusted proof |
| 408/413/415 | Body deadline / byte-count limits / unsupported protocol |
| 429 | Admission/rate; respect Retry-After inside a total caller deadline |
| 502 | Upstream redirect/unexpected status |
| 503 | Verification cold/expired+dependency unavailable, or upstream unavailable; no fallback |
| 504 | Upstream transport/total deadline, uncertain partial outcome |
| 500 | Sanitized internal failure; diagnose with request_id only |

Gateway forwards once, does not redirect/retry/queue durable delivery or roll back TSDB. Uncertain partial writes are not exactly-once. The E2E sender alone retries transport/5xx/429 at most3attempts/20seconds, identical bytes/timestamps; exponential0.5s×2^attempt+jitter0–0.25, Retry-After1–60seconds cannot consume the remaining budget then start another attempt. This does not configure Telegraf delivery.

## Deployment, health and failure recovery

Canonical root anchor remains `docker compose --env-file .env -f deploy/compose/compose.yaml ...`, **never `--project-directory .`**. The wrong override resolves existing relative build/bind paths outside the repository; preserve paths/networks/volume names. Do not execute shared commands until separately approved and [Management Gate T12](<management-backend.md>) proves backup/destination, explicit owner/runtime/bootstrap roles, migrations/seed and signing trust. Never print expanded config, Config.Env, dotenv, raw logs or URL/key values.

Gateway source UUID is fixed in `INGEST_GATEWAY_ID`, equal to service-trust `subject` and seeded gateway source. `INGEST_SERVICE_KEY_ID` selects a local trusted public kid; private PEM only in `INGEST_SERVICE_SIGNING_KEY_FILE`. Real signer issuer/audience are `infrapulse-gateway` / `infrapulse-management-internal`, scopes in trust are `credentials:verify` and `status:write`. No service→Admin or browser trust bypass. Admin adapter has a distinct private key/trust map; see [Step6 contract](<../contracts/grafana-management-api.md>).

Runtime selects Uvicorn `--loop asyncio` explicitly rather than AUTO. Task13's isolated readiness/outage diagnosis measured delayed same-process Prometheus DNS under AUTO/uvloop and a fast stdlib-loop control; this is a measured mitigation, not proof of exact libuv saturation, universal resolver isolation, throughput, or a permanent flake fix. Current uninstrumented runtime outage/E2E receipts, not the diagnostic control alone, determine qualification. Pins, cache/deadline/retry policy and resource budgets are unchanged.

One worker UID/GID10001, readonly rootfs, `/tmp` tmpfs, capsALL dropped/no-new-privileges,512MiB/pids128/log10m×3; only monitoring network and signing-key bind, no DB/root-env/socket. Host publication stays loopback8000. Management is monitoring+database, container3000/loopback3001; Grafana3000 unchanged. Inspect alone is **not** native isolation proof; finite proxy-disabled loopback/nonloopbackIPv4/IPv6 probes must actually run. Report reachable exposure; do not silently remediate firewall or count inspect as a successful native probe.

`/health/live` is process-only; `/health/ready` separately checks Prometheus and **signed** Management health with dedicated short-budget pools. Unhealthy does not trigger automatic Docker restart. Health/metrics bypass ingest rate/slots; no key is required for those public operational routes. Metrics have finite allowlisted labels, never IDs/key/run_id/URLs. Access logs disabled; HTTPX/httpcore restricted. Logs are finite event/code/status/count/timing fields, not headers/body/query/exception dumps.

Status success records use actual Prometheus2xx receipt time, not sample time. Reporter10seconds, pool1/deadline2seconds, max1024Agents,256records/64KiB per chunk,4chunks/256KiB per immutable snapshot,3attempts, no raw metrics/key/durable queue. Boot UUID/time captured once; delayed registration never forges a fresh boot. Committed duplicate ack does not refresh heartbeat/coverage; digest mismatch409. Stale source>30seconds/gaps/never-seen yield Unknown, not fabricated Offline. [Telemetry contract](<../contracts/agent-provisioning.md#telemetry-is-observation-not-lifecycle-or-machine-power>) explains as_of/confidence and90/300 boundaries.

Outage tests stop **only** the positively identified isolated Management dependency. Live positive cache remains usable until its original deadline; cold/expired503. Recovery must reverify and restore trustworthy observation coverage. Do not stop shared PostgreSQL/Prometheus/Gateway or alter public data for tests. Authorized rollback changes only reviewed schema-compatible app images/config and preserves DB/migrations/keys/volumes. Never `down -v`, prune/reset, TSDB deletion, disabling auth, broad grants, or assumed password rotation by dotenv edit.

## Repeatable real E2E and historical evidence boundary

Use [Management test instructions](<../../services/management-backend/README.md#opted-real-cross-service-gate>) for `INFRAPULSE_RUN_MANAGEMENT_E2E=1 pnpm test:e2e`. It creates generated private Admin/Gateway pairs and trust **only** in its unique guarded fullstack, bootstraps/migrates/seeds its exact tmpfs DB, issues a real credential, and runs all five retained Gateway cases with `E2E_CREDENTIAL_FILE` pointing at a private fixture. Token contents are never argv/environment values. Missing fixture under opt-in is a prerequisite failure, not skipped/pass. Default import/collection performs no I/O. Native test Python can be selected by executable PATH only.

Independent [scalar fixture](<../../services/ingestion-gateway/tests/fixtures/remote_write_scalar.hex>) is hand-derived `__name__=up`,value1,timestamp1000ms. Tests check those constants before changing unique run_id/value/time. Real cross-service cases assert42.25, trusted UUID labels and **`timestamp(metric)`** stored timestamp (instant-vector evaluation time is not sample time), full30second no-forward windows for rejected runs and commit+30second revoke bound. Fresh requests/queries have finite deadlines; no TSDB deletion. Generated test project teardown includes `--profile fullstack`, exact run/database labels/marker and zero-owned-resource receipts, not default down that can omit profiled apps.

Linux integration uses a parent-owned guarded DB with exact `INFRAPULSE_TEST_DB_EXTERNAL=1`, run ID and private URL-file mounts; no Docker socket/lifecycle in the child. Test images include current source; repository-only static tests use a finite safe metadata projection without real dotenv. A successful sample/query is **not** real Grafana login, Step6 stable subject, installer or VM proof. Existing Step1 CI-01 FAIL/CI-07+09 PARTIAL and historical Step2 limits remain in their original reports. No later fixture test retroactively closes them.
