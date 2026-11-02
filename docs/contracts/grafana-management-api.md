# Step6 handoff — Grafana adapter and Management API

The Task13 test signer is **not a Grafana login/SDK integration**. Step6 must verify a stable, immutable subject from the real Grafana server-side identity API and instance context before enabling the adapter. Never substitute username/email, browser role headers, default organization metadata or a lab UUID for that verification. No Nest password/organization module or public test-signer service is supplied. Browser never holds signing/service private keys.

## Server-side assertions and exact binding

Separate Ed25519 key pairs/trust maps for Admin adapter and Gateway. Admin public trust entry: `{public_key_pem,issuer,audience}` under an explicit `kid`; deployment also sets `MANAGEMENT_GRAFANA_CONTEXT`. Private key stays in the server-side adapter. JOSE protected header `{alg:"EdDSA",kid:"<trusted kid>"}`. Payload:

```json
{
  "iss": "<configured adapter issuer>", "aud": "<Management audience>",
  "sub": "<verified stable opaque Grafana user subject>",
  "kind": "user", "ctx": "<exact configured Grafana instance context>",
  "grafana_role": "Admin", "iat": 0, "nbf": 0, "exp": 60,
  "jti": "<fresh unpredictable UUID per request>",
  "m": "POST", "t": "/api/v1/servers?name=a%2Fb",
  "b": "<base64url-no-padding SHA256 of exact raw UTF8 body bytes>"
}
```

Numeric times above are explanatory only; generate actual seconds at request time. Maximum lifetime60seconds/leeway5seconds. Bind uppercase method, exact raw origin-form target including query order/escaping, and raw body (empty GET body hashes empty bytes). Do **not** decode/reorder a query, canonicalize body JSON, reserialize after signing, or sign a reconstructed route. `{"x":1e0}` and `{"x":1}` bind differently. Durable `(issuer,jti)` nonce reservation fails closed on replay/capacity/DB failure and survives Nest restart; no live-nonce eviction to make room. A retry must make a fresh assertion while preserving an application operation UUID when required. `GET /api/v1/me` returns effective principal/RBAC, not signing material.

Run the [runtime vector generator](<../../services/management-backend/test/support/scripts/task13-vector.mjs>) from Management with `node test/support/scripts/task13-vector.mjs`. It generates an in-memory key, signs/verifies a raw-target/raw-body vector, and emits only public hash/boolean results, no private key or assertion. The [fixture signer](<../../services/management-backend/test/support/stack-harness.ts>) is isolated test code, never a production identity endpoint. [Assertion tests](<../../services/management-backend/test/unit/assertions.spec.ts>) and [DB replay tests](<../../services/management-backend/test/integration/replay-db.spec.ts>) cover negative bindings, trust/TTL/role and durable nonce behavior.

Role mapping: Grafana Viewer→Viewer; Editor→Operator (**read-only in Step3**); organization Admin→Admin. Do not let the browser self-assign roles. Service assertions contain `kind:"service"`, fixed trusted source `sub`, issuer/audience/kid, time/jti/m/t/b; permissions derive from public trust, not self-claimed scopes. Gateway cannot call Admin APIs; a valid service principal probing a user-route family receives404 (`not_found`) by policy rather than exposing that family. Agent credentials use a separate guard, never impersonate a user.

## Public API and frontend behavior

The [OpenAPI builder](<../../services/management-backend/src/common/openapi.ts>) is the machine schema source and exports `managementOpenApi(app)`. Normal runtime has **no public Swagger/docs route**; programmatic lab-only `installOpenApi` requires explicit loopback opt-in, disables persisted authorization, and does not publish raw JSON. Do not silently add a docs/auth environment bypass. Step6 can consume the generated document in its build/test integration without exposing private data.

| Resource | API families / UI responsibility |
|---|---|
| Current user | `GET /api/v1/me`; render effective backend RBAC |
| Servers | `/api/v1/servers`, `/{id}` CRUD/archive; OS/environment/name/group/archive filters, UUID identity |
| Groups | `/api/v1/server-groups`, `/{id}` CRUD; membership `PUT/DELETE /api/v1/servers/{id}/groups/{group_id}` |
| Agents | `/api/v1/agents`, `/{id}`, registration `POST /api/v1/servers/{id}/agents`, `POST /api/v1/agents/{id}/{disable|enable|retire}` |
| Credentials | Admin-only `/api/v1/credentials`, `/{id}`, issue under Agent, `/{id}/rotate`, `/{id}/revoke`; reveal-once/no-store |
| Profiles | `/api/v1/monitoring-profiles`, `/{id}/versions`, `/api/v1/profile-versions/{id}`, `/{id}/publish`; exact assignment `PUT/DELETE /api/v1/servers/{id}/profile` |
| Audit | Admin-only `GET /api/v1/audit-logs`; immutable actor snapshot and safe allowlisted delta |

Use OpenAPI for each method/DTO rather than guessing method support from a family. Unknown fields, bounds, unsupported OS/options and malformed IDs fail validation. Pages are `{items,next_cursor}`; default limit20/max100; opaque cursor must be echoed unchanged with its filter context, never forged from a displayed UUID. No hard-delete-history UI. Version numbers, UUIDs, desired assignment, reported applied version/result/time and lifecycle remain distinct. Retired is terminal; enable never revives old keys. Audit actor is the verified immutable issuer/subject/context snapshot, not a browser-provided display name.

For one-time issue/rotate response201, display the plaintext only in a deliberate no-store transient UI; no persistent/browser analytics/error capture. Same `issuance_request_id` retry returns409 safe metadata, never plaintext again. Lost response recovery is inspect→revoke→new operation UUID, not blind retry. Rotation overlaps at most300seconds; Gateway cache maximum30seconds, not instantaneous revocation of in-flight decisions. [Agent contract](<agent-provisioning.md>) supplies full desired/provisioned/reported and failure meanings.

Error envelope is finite `{code,message,request_id}` (issuance409 may additionally contain safe `credential`). No raw DTO, ORM stack, verifier, token, request body or DB URL should enter error telemetry. 400 invalid request,401 invalid authentication/replay,403 policy denial,404 missing resource,409 lifecycle/assignment/issuance conflict,413 raw cap,429 rate/capacity,503 dependency/unready. A503 is not a reason to bypass trust or grant Admin. Surface request_id without logging Authorization/body/query values.

## Status, reporting and source trust

Render nested `telemetry`, not a fabricated root status. Show `status_as_of`, `source_health`, `confidence_reason` and receipt lag. Active is not Online; Offline is not proof of power state. Never-seen, stale source>30seconds, gaps/restart/insufficient coverage produce Unknown rather than fabricated Offline. Online≤90seconds, Stale90–300 inclusive, Offline>300 requires continuous coverage; positive success timestamps use Prometheus2xx receipt clock, not sample timestamps. [Agent telemetry contract](<agent-provisioning.md#telemetry-is-observation-not-lifecycle-or-machine-power>) describes Step4 implications.

Gateway source is one fixed canonical UUID equal in `INGEST_GATEWAY_ID`, service trust subject and seeded `gateway_sources` row. Epoch GET/POST `/internal/v1/status/epoch` is service-only; capture boot UUID/start once per lifespan. CAS activation returns `{gateway_id,boot_id,epoch,activated_at}`. Delayed first registration keeps truthful boot time; future skew≤5seconds, stale earlier unseen boots cannot replace newer epochs. Source never selected by request body/header or username.

`POST /internal/v1/status/reports` uses `epoch,sequence,snapshot_start,snapshot_end,gap,chunk_index,chunk_count,snapshot_hash,chunk_hash,records`. Each record has `agent_id,server_id,credential_id,last_success_at`. Logical digest is SHA256 lowercase hex of RFC8785 `{epoch,sequence,snapshot_start,snapshot_end,gap,records sorted agent_id}` (exclude chunk/digest fields); chunk hash covers canonical subset records. Ack200 `{epoch,sequence,state:"staged"|"committed",accepted_chunk_indexes}`. Committed last-sequence/same-digest duplicate is acknowledgment only: **no received_at, heartbeat, coverage, staging or last-success refresh**; different digest409. Pending chunk/manifest constraints still apply; normal pending does not destroy completed confidence, but sequence loss/expiry/tamper does. This is not durable metric delivery or evidence of new observations on replay.

## Key rotation, deployment and rollback gate

Before a real Step6 adapter exists, trust only explicitly generated keys in the isolated stack; no shared production test issuer. To rotate an authorized adapter/Gateway key, stage a reviewed new public kid for the **same issuer/audience/subject/context**, update the private holder, allow bounded existing assertions, then retire the old public kid in a separate approved rollout. Do not confuse signing-key rotation with Agent credential rotation or change Gateway UUID on restart. Protect files under host ACLs and prove actual configured UID readability; Windows POSIX mode flags alone are insufficient.

Follow [Gate T12 and rollback runbook](<../deployment/management-backend.md>): verified backup/destination, distinct owner/runtime/bootstrap URL files, explicit bootstrap→`prisma migrate deploy`→seed, then readiness before Gateway. No automatic migration/bootstrap at app startup, no schema/public reset, no broad runtime grants, no insecure fallback. Roll back only reviewed schema-compatible app images while retaining DB/migrations/volumes/keys; incompatible schema remains unready for operator recovery from a verified backup. Shared rollout, TLS/LAN, real Grafana adapter/React, installer/VM, HA/load and historical acceptance closures are **not** supplied by these fixture tests.
