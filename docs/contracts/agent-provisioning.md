# Step4 handoff — Agent provisioning and Remote Write

This is the Step3 API contract, not a Telegraf renderer, installer or VM acceptance. HTTP examples are loopback/private lab only; signatures are not encryption. Deploying to a VM/LAN needs separately approved TLS, routing and secret protection. Actual verdicts/limits: [Management acceptance](<../deployment/management-backend-acceptance.md>); operator sequence: [deployment runbook](<../deployment/management-backend.md>).

## Registration and one-time credentials

An authorized Admin adapter creates a Server (`POST /api/v1/servers`, OS `linux` or `windows`), then `POST /api/v1/servers/{server_id}/agents` with `{}`. UUIDs returned by the API are authoritative. One active Agent per Server; active is lifecycle, **not Online**. Server link is immutable. Disable/retire/archive revokes keys atomically with audit; enable does not revive them; retired is terminal.

`POST /api/v1/agents/{agent_id}/credentials` accepts a unique `issuance_request_id` UUID, optional nonempty scopes from `metrics:write`, `provisioning:read`, `config:report`, and optional future `expires_at`. Default expiry30days, maximum365days. Response201 is `Cache-Control: no-store` and contains `api_key` **once**: canonical lowercase UUID + `.` +43 unpadded base64url characters from32 CSPRNG bytes. Store privately; never put it in query strings, command arguments, shell history, logs, telemetry, browser persistent storage or screenshots. Only SHA-256 verifier32bytes is persisted; metadata/audit/provisioning cannot retrieve plaintext.

A lost issue/rotate response cannot be recovered by retry: the same operation UUID yields409 `secret_already_issued` with safe metadata, not another secret. Inspect metadata, revoke the inaccessible key, then issue with a **new** operation UUID. A new UUID is a new issuance decision, not a safe blind retry.

`POST /api/v1/credentials/{id}/rotate` uses the same issuance input and reveals the successor once. Old key cutoff is the earlier of its existing cutoff/expiry and DB now+300seconds; repeated rotation never extends it. `POST /api/v1/credentials/{id}/revoke` with `{}` returns204. Gateway may accept a previously authenticated key only until its existing positive-cache deadline (maximum30seconds from before verification RPC, or earlier credential expiry). After commit+30seconds a new healthy-control-plane authentication decision must return401. This does not cancel in-flight authentication or delete old samples.

## Exact desired profile and provisioning

Admin creates profile and draft version, publishes it, then `PUT /api/v1/servers/{server_id}/profile` with `{"profile_version_id":"<exact UUID>"}`. No latest-version guessing. Assignment must be published and OS-compatible. Published versions are immutable; rollback means assigning a reviewed prior published version, never editing history.

`GET /api/v1/agent/provisioning` uses `Authorization: Bearer <issued key>` with `provisioning:read`. It returns200/no-store or409 `provisioning_not_ready` if no assignment. Response shape:

```json
{
  "server_id": "<server UUID>", "agent_id": "<Agent UUID>", "os": "linux",
  "profile": {
    "id": "<profile UUID>", "version_id": "<exact version UUID>", "version": 1,
    "checksum": "<lowercase SHA256 hex of RFC8785 canonical config>",
    "config": {
      "schema_version": 1, "os": "linux", "interval_seconds": 15,
      "metric_groups": {"cpu": true, "memory": true, "disk": true, "network": true},
      "options": {}
    }
  },
  "ingestion": {
    "base_url": "<server-configured trusted origin>", "path": "/api/v1/ingest/remote-write",
    "content_type": "application/x-protobuf", "content_encoding": "snappy",
    "remote_write_version": "0.1.0", "authorization_scheme": "Bearer",
    "identity_headers": {"X-Server-ID": "<server UUID>", "X-Agent-ID": "<Agent UUID>"}
  }
}
```

Config is bounded64KiB, unknown properties/scripts/secrets/arbitrary destinations are rejected. Interval default15seconds, allowed integer5–300. All four metric groups are booleans. Linux `options.disk` allows `exclude_filesystems`/absolute `mount_points`; Windows allows `include_volumes`; both allow `options.network.interfaces`. Optional arrays maximum64 entries, strings1–128/no controls; other-OS fields reject. Do not hash pretty JSON or a Telegraf rendering: hash exactly RFC8785 canonical **config**. [Runtime schema/OpenAPI builder](<../../services/management-backend/src/common/openapi.ts>) and [profile validator](<../../services/management-backend/src/profiles/profile-config.ts>) are authoritative; no default public Swagger JSON route is promised.

Provisioning creates/updates a receipt only; GET is neither application success nor metric success, and does not mark Online/applied. After actual Step4 render/write/service application, `POST /api/v1/agent/config-reports` with `config:report` sends `{profile_version_id,checksum,result:"applied"|"failed",agent_version?}`. The version/checksum must have been provisioned to this Agent. Reported result/time and applied version are distinct from desired assignment. These are Agent statements, not independent machine installation proof. Step4 owns permissions, rendering, install/upgrade/service lifecycle and reporting; no direct SQL or chosen identity reassignment.

## Scalar Remote Write and failure mapping

Send to the returned trusted origin/path, using the issued credential. Single-valued Authorization, Content-Type `application/x-protobuf`, Content-Encoding raw/block `snappy`, X-Prometheus-Remote-Write-Version `0.1.0`, nonempty User-Agent. `X-Server-ID`/`X-Agent-ID` are **optional comparisons**, never an identity authority: supplied valid mismatches403; malformed/duplicate headers400. Missing payload IDs are injected from proof, matching IDs retained; conflicting labels400 and the entire batch is not forwarded. No raw metrics endpoint exists on NestJS.

401 = missing/malformed/expired/revoked/inactive credential. 503 = cold/expired cache and verification dependency unavailable; no insecure/stale fallback. 400 = malformed body/identity/whole-batch failure; 408 body deadline,413 limits,415 format,429 admission/rate. Forwarding retains bounded one-attempt/no-redirect behavior; 502/503/504 can have uncertain partial write outcomes. Caller retry, if used, is bounded and reuses exact bytes/timestamps; not exactly-once delivery. Never interpret a timeout as proof nothing was stored. Initial bounds remain compressed1MiB/decompressed8MiB,5000series/20000samples/64labels after injection,2inflight; not a load qualification.

## Telemetry is observation, not lifecycle or machine power

Gateway records receipt time only after authenticated, validated Prometheus2xx, not sender sample time. Reporter10seconds, dedicated pool1/deadline2seconds, coalesces latest success, at most1024Agents,256records/64KiB per chunk,4chunks/256KiB per snapshot,3attempts of immutable snapshot bytes, no raw metrics/key/durable queue.

Nested `telemetry` returns `status`, `last_metric_seen_at`, `status_as_of`, `source_health`, `confidence_reason`. Age at `status_as_of` ≤90seconds is Online;90<age≤300 Stale;>300 Offline only with enough continuous coverage. Never-seen, source stale>30seconds, unavailable/gap/insufficient coverage are Unknown. Offline does not mean powered off. Report receipt lag can be calculated from now minus `status_as_of`; do not relabel it as current wall time. Restart/recovery does not invent continuity; historical inactive Agent success never makes a replacement active Agent Online.
