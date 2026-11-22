# Management backend — external PostgreSQL connection

## Current deployment — ECS on EC2

[Terraform ECS](<../../infra/terraform/ecs.tf>) runs **Management and Grafana**. Store the complete external PostgreSQL runtime URL in the Management `database-url` SSM Parameter Store `SecureString` and set `ecs_parameter_arns.management.database_url` to its ARN. The task initializer writes the value to `/run/secrets/management-db-url`; `MANAGEMENT_DATABASE_URL_FILE` selects that file. Use the same file interface for Neon or another compatible PostgreSQL provider. Do not put credentials in Terraform inputs or logs.

Management passes the connection string to Prisma without rewriting it or requiring specific URL parameters. The adapter targets the `management` schema, and `pg` handles the URL's TLS options; use `sslmode=verify-full` for remote databases. `/health/ready` runs `SELECT 1` only: it proves connectivity, not that the schema or grants are correct. Prepare the schema separately and use a least-privilege runtime role. The application does not create, migrate, seed, or inspect the catalog at startup.

Management UID10002 receives only the DB file and `/run/secrets/assertion-trust`. It receives no owner/bootstrap/alert DB credentials, Grafana Admin or private signing key. Grafana UID472 receives its assertion key and first-start admin user/password files and uses its own persistent SQLite volume. New admin-file values do not reset an existing SQLite account.

Use the [ECS runbook](<aws-lab.md>) for image builds, runtime inputs and rollout. Alert-sync source and host-loopback transport are **unchanged and deferred**; ECS does not reconcile alerts automatically.

## Current code layout — modular NestJS

The [composition root](<../../services/management-backend/src/app.module.ts>) keeps one Management application. [Config](<../../services/management-backend/src/config/config.ts>) composes app, PostgreSQL, Grafana and AWS settings. [PrismaService](<../../services/management-backend/src/database/prisma.service.ts>) extends the generated Prisma client and sets adapter, pool, deadline and shutdown behavior. Callers use `$transaction` and the generated client directly; readiness belongs to the health module.

Business modules live under `src/modules`: auth, servers, groups, audit, health, onboarding and monitoring. Controllers handle HTTP; services validate and coordinate transactions/audit; typed repositories execute queries using the caller's transaction. [ServersService](<../../services/management-backend/src/modules/servers/services/servers.service.ts>) and [ServersRepository](<../../services/management-backend/src/modules/servers/repositories/servers.repository.ts>) show this split. Auth still verifies the raw request and authorizes before consuming its nonce. DTOs, routes and OpenAPI contracts are unchanged.

The [onboarding module](<../../services/management-backend/src/modules/onboarding/onboarding.module.ts>) injects one shared store, [worker](<../../services/management-backend/src/modules/onboarding/workers/onboarding.worker.ts>) and decommission service. Its domain state/CAS/lease and uncertain-send logic remain in the same process, not another container or a generic CRUD layer. [AWS integration](<../../services/management-backend/src/integrations/aws/aws.module.ts>) and monitoring share the qualified port. No BFF, gRPC or Redis is added.

Image entry remains `node dist/main.js`; root-owned release and generated assets remain under `/app/release` and `/app/generated`, outside `dist`. The legacy migrations and alert-sync host-loopback transport are unchanged. The separate owner-only push operator is not invoked by the application and currently accepts only the local synthetic fixture. The pinned Prisma engine passes the URL in subprocess arguments, so the operator must not be used with real credentials. Local PostgreSQL fixture results do not qualify the live Neon endpoint, ECS network, or alert delivery.

## Historical AWS source notes — superseded deployment matrix

Everything below is retained history, including “current” headings, staged-executor commands, local PostgreSQL and old admin/secret matrices. The current deployment section above and linked runbook take precedence.

> **Source retirement — 2026-11-20:** legacy Gateway/Telegraf, old Compose/Prometheus provisioning and unmounted management editors are deleted from current source. Historical instructions below are records only, not runnable installation paths. Existing live lab/data/secrets are unchanged. Use the [current AWS architecture](<../architecture/aws-ssm-cloudwatch.md>).


The standalone AWS Compose used during this checkpoint is retired. Use the [ECS runbook](<aws-lab.md>) and [AWS architecture](<../architecture/aws-ssm-cloudwatch.md>) for current deployment. The historical source notes here are not commands to run.

## Current composition and data policy

Production main validates AWS context before reading DB/trust secrets and calls the same protected `createQualifiedRuntime` before listen. Missing real canonical inputs, bundle/published pins or full AWS context cannot become an inventory-only ready server. Agent TLS startup is removed; normal lifecycle/safe failure logs and separate identity/Management TLS trust remain.

AppModule mounts auth, inventory/groups, audit and AWS onboarding, not public Profiles/Agents/Credentials/Provisioning/Gateway status modules. Immutable profile/version READ/FKs remain for AWS preset lookup. Current inventory projections contain onboarding/dashboard context, no Agent count/include. OS-change/archive Server-first locks and exact AWS terminal/idle guards remain; they no longer count Agents, inspect assignments, revoke keys or disable archived legacy Agents.

All eight accepted migrations stay immutable/unapplied here. The additive ninth [190007 migration](<../../services/management-backend/prisma/migrations/202611190007_retire_legacy_telemetry/migration.sql>) is source only: runtime loses all legacy Agent/key/assignment/provisioning/Gateway table privileges and profile DML, but retains shared immutable preset SELECT. No rows/tables/FKs/published versions are dropped. Readiness requires complete final migration history and the final privilege policy; it preserves protected 004/005 column/function checks and 006 operator boundaries. Bootstrap validates that same final policy when installed, and excludes all protected receipt/provenance columns from ordinary runtime-write requirements. It never regrants retired capabilities to make a refresh pass.

## Public input / protected-file matrix

Public input means reviewed configuration, not credential contents. No root legacy dotenv injection, static AWS access keys, host AWS credential mount, browser credentials or runtime owner/Admin fallback.

| Input | Current authority / boundary |
| --- | --- |
| Account/region/deployment/Owner | Exact reviewed outputs: Singapore, one account/deployment; Owner propagated, not a browser override |
| Hybrid role/eligibility/namespace | Reviewed fixed role, deployment eligibility and `InfraPulse/Lab` |
| Configure/Decommission/preset names + versions | Actual immutable published service versions, never defaults or latest |
| Association ID/version, bundle hash | Actual reviewed current association and canonical bundled bytes |
| Linux/Windows preset DB version UUIDs | Committed owner seed output bound to canonical version/hash, not fabricated UUIDs |
| Grafana issuer/JWKS/org/namespace/auth methods/context | Actual enrolled instance, experimental identity acknowledgement; not token claims as config |
| Image/release/target metadata | Reviewed public build/release/target inputs and actual role digests; no package/deploy existence inferred |

Linux host secrets live outside checkout under `/etc/infrapulse/<deployment_id>/secrets`, selected by role subdirectory. No parent directory mount. `0400`/`0600` and actual image UID readability are source custody requirements, not a Windows ACL equivalence claim. Existing Windows permissions are accepted; this task starts no new ACL/backup workflow.

| Consumer | Host role files → fixed container files | Never mounted |
| --- | --- | --- |
| Management UID10002 | `runtime/management-db-url` → `/run/secrets/management-db-url`; `runtime/assertion-trust` → `/run/secrets/assertion-trust` (public Ed25519 trust) | owner/bootstrap/alert DB, private assertion key, service trust, Grafana Admin |
| PostgreSQL UID999 | `postgres/postgres-password` → `/run/secrets/postgres-password` | application/Admin keys |
| Grafana + Go UID472 | `grafana/assertion-key` → `/run/secrets/assertion-key` | Grafana Admin and all DB URLs |
| Explicit bootstrap UID10002 | `bootstrap/{bootstrap-db-url,owner-db-url,management-db-url,alert-db-url}` → matching `/run/secrets/*` | Grafana Admin/private assertion key |
| Explicit migrate / seed UID10002 | `owner/owner-db-url` → `/run/secrets/owner-db-url` | runtime/alert/Admin/private assertion key |
| Explicit alert-sync UID10002 | `alert/{alert-db-url,grafana-admin}` → matching `/run/secrets/*` | owner/bootstrap/private assertion key |

Grafana user initialization is separate and stopped/removed at enrolled handoff; normal app runtime has no Admin secret. Operator alert-sync resolves the exact owned PostgreSQL bridge endpoint on each invocation; no published 5432 or hardcoded substitute. SDK EC2 default credentials require actual IMDSv2 qualification in both containers; shared host authority is explicitly **not container IAM isolation**.

## Explicit setup sequence — future permission only

The finite staged executor separates preflight/create-once secrets, PostgreSQL, fresh-owned-DB preparation, bootstrap, migrate, canonical seed, Grafana initialization, identity enrollment, start, operator alert sync and observation. Each stage needs its own matching permission; this document does not activate a chain. Bootstrap validates/creates only the dedicated marked DB roles; migration uses owner; seed imports genuine canonical release inputs and returns committed immutable preset UUID/hash mapping. None runs at app startup, overwrites historical published versions or regenerates credentials on rerun. Existing incompatible/foreign state fails closed rather than reset/adopt. Full fresh history→final grants/seed/readiness is **NOT RUN**.

## HISTORICAL — previous management lab runbook (not current commands)

Everything below, including Task12/13 tests, Gateway trust, legacy seed, prior acceptance and command blocks, is retained historical material. It is not the current AWS file matrix, a supported dual mode or AWS proof. Do not execute it for the new deployment or old lab.

This is an **operator procedure, not authorization to execute it**. Task 12 uses only a disposable, uniquely labelled PostgreSQL 18.6 test stack. The existing shared PostgreSQL/Grafana/Prometheus/Gateway stack must not be bootstrapped, migrated, seeded, or restarted without a separate approved change window, operator-provided files, and verified backup. Shared rollout is NOT RUN by this task.

HTTP is permitted here only for the loopback/private Docker lab. Ed25519 signatures do not encrypt API keys or database traffic and do not replace TLS. This is not a production, LAN, TLS, HA, load, VM/Telegraf, or real Grafana SDK stable-identity qualification.

## Artifacts and boundaries

- Compose (`../../deploy/compose/compose.yaml`, retired source) preserves the original three services, three named volumes, Prometheus receiver/storage and networks. Management listens internally on 3000 and publishes only `127.0.0.1:${MANAGEMENT_HOST_PORT:-3001}:3000`; Grafana 3000 and Gateway 8000 stay unchanged.
- Management joins `monitoring` and `database`; Gateway joins **only** `monitoring`. PostgreSQL joins only `database` in the root deployment. No Docker socket is mounted.
- [Dockerfile](../../services/management-backend/Dockerfile) defaults to `runtime`, Node 24.20.0's pinned linux/amd64 child digest, UID/GID 10002. `build` installs pnpm 11.24.0 and the frozen lock/workspace policy, generates Prisma offline, then compiles `dist/main.js`. `test` and `migrate` are explicit targets. Gateway keeps UID 10001.
- Runtime contains only compiled application/generated Prisma assets, production dependencies and package metadata. It does not contain tests, source, operations, Prisma CLI, TypeScript compiler, signing keys, or test private fixtures. Never copy host node_modules or generated output into a build context.
- Runtime services and operator jobs are single-process, read-only rootfs with `/tmp` tmpfs, `cap_drop: ALL`, `no-new-privileges:true`, memory 512 MiB, pids 128, and json-file logs 10m × 3. These are initial bounds, not a load qualification.
- Management mounts only its runtime-role URL and two **public** trust maps. Gateway mounts only its own signing key. `management-migrate` and `management-seed` mount only the owner URL; the separately invoked bootstrap job additionally needs bootstrap and runtime URL files. No root dotenv `env_file` injection into either application.

## 1. Approve, inventory and back up first

Record existing healthy container IDs, volume identities and available loopback host ports before an approved shared change. Preserve `prometheus_data`, `grafana_data`, `postgres_data`, and the `public` schema. Use the existing database `infrapulse`; **never the Grafana database**. Take and verify an operator-managed database backup including role/grant metadata and a tested restore path. Keep backups private and outside image contexts. Database credential files must not be passed as raw URL argv values or dumped in logs.

Do not use `down -v`, prune, reset, `db push`, auto-synchronize, drop/recreate volumes, TSDB deletion, firewall changes, or fallback to the PostgreSQL superuser for the application. This procedure grants no authority over shared data until separately approved.

## 2. Prepare operator-owned files (never application startup)

Use [the template](../../.env.example) for **defaults and host file paths**, not live credential contents. Keep files under the ignored `deploy/secrets/` directory or another private operator-managed location outside both service build contexts. Use absolute host paths for every `*_FILE` Compose interpolation value. Relative Compose paths otherwise resolve from `deploy/compose`, not the shell cwd.

Prepare three distinct password-bearing connection-string files, never print them:

1. `MANAGEMENT_BOOTSTRAP_DATABASE_URL_FILE`: an authorized PostgreSQL bootstrap identity for that exact host/port/database; used only by the explicit bootstrap job.
2. `MANAGEMENT_MIGRATION_DATABASE_URL_FILE`: `management_owner`, a separate password and `?schema=management` on the same database.
3. `MANAGEMENT_DATABASE_URL_FILE`: `management_runtime`, a third password and `?schema=management` on the same database.

The scripts check matching bootstrap/owner/runtime destination and distinct credentials. Bootstrap creates/validates non-superuser, non-CREATEDB/non-CREATEROLE/non-BYPASSRLS/non-replication login roles without inherited memberships, the new `management` schema owned by `management_owner`, and constrained default privileges. It refuses unsafe adoption/permissive existing `public` CREATE instead of rewriting unrelated policy. Existing roles are validated, **not automatically password-rotated**; an inconsistent deployment must be investigated by the operator.

Migrations define explicit runtime table privileges. Runtime must not CREATE/ALTER/DROP/TRUNCATE, own schema/tables, inherit owner, or write migration history. Audit is SELECT/INSERT only, never UPDATE/DELETE/TRUNCATE. No app startup path performs bootstrap, migration or seeding.

### Mount readability and host protection

Every required file is a read-only bind with `create_host_path:false`; missing files fail closed instead of silently creating a directory. The Management runtime and operations must actually read their required files as UID/GID 10002, and Gateway its key as 10001. On Linux, arrange minimal ownership/group/permissions for those specific UIDs. Do not make a private directory world-readable to fix a mount.

On Windows/Docker Desktop, POSIX chmod/mode declarations do **not** prove NTFS ACL protection or container UID readability. Restrict host ACLs to the intended operator/service account, protect the private parent directory, and qualify readability inside the exact image under its configured UID **before** rollout. Do not automatically alter unrelated ACLs. Task12's disposable-fixture runtime gate proves actual UID reads on the current Docker carrier; it does not qualify production-file ACLs, IPv4/IPv6 native bind isolation, or other Windows hosts. Those live host checks belong to Task13.

## 3. Fixed source identity and separate keys

Choose one canonical lowercase UUID once for this Gateway deployment. Store it as `INGEST_GATEWAY_ID`; do not generate a new identity on restart or key rotation. Use a separate Ed25519 key pair from the future Grafana administrator adapter. Private key stays only in `INGEST_SERVICE_SIGNING_KEY_FILE`; Management receives only the public key in `MANAGEMENT_SERVICE_TRUST_FILE`.

A service trust-map entry has this shape (replace placeholders privately):

```json
{
  "chosen-gateway-kid": {
    "public_key_pem": "<Ed25519 PUBLIC KEY PEM>",
    "issuer": "infrapulse-gateway",
    "audience": "infrapulse-management-internal",
    "subject": "<same fixed canonical lowercase INGEST_GATEWAY_ID>",
    "scopes": ["credentials:verify", "status:write"]
  }
}
```

Set `INGEST_SERVICE_KEY_ID` to that exact kid. The Gateway's actual signer uses the issuer/audience above and subject `INGEST_GATEWAY_ID`. **Both** permissions may belong to the same fixed source. The trusted issuer/subject plus `status:write` bind StatusService to its UUID subject, which must equal the explicitly seeded `management.gateway_sources.gateway_id`. Neither headers nor report body choose a source. No username/opaque-subject fallback or registry API exists. Key rotation can allow a second kid for the **same** source identity; it must not silently create a new source.

`MANAGEMENT_ADMIN_TRUST_FILE` is a different local public-key map with distinct issuer/audience and a different Ed25519 key pair for the future Grafana adapter. Determine `MANAGEMENT_GRAFANA_CONTEXT` from the actual instance before real adapter rollout. Do not invent a context, use a username as a stable user ID, accept browser role headers, or promote Gateway to Admin. A lab fixture is not evidence of real Grafana SDK identity. Viewer stays Viewer, Editor maps to read-only Operator for Step3, organization Admin to Admin. Assertions bind raw method/target/body, live at most 60 seconds with five-second leeway, and reserve durable replay nonces.

## 4. Build and execute explicit operations in order

Run from the **repository root**. The canonical anchor remains:

```text
docker compose --env-file .env -f deploy/compose/compose.yaml ...
```

**Do not add `--project-directory .`**: it breaks existing `../../` build/bind paths. Never print expanded config, Config.Env, real dotenv, URLs, keys or assertions. Use `config --quiet` with approved files for an operator configuration check. Task12's separate path regression uses only a generated NONSECRET env and tightly controlled interpolation, privately projects only normalized project/build/bind paths and tests the incorrect anchor; it is not permission to enable the historical root-env test opt-in.

The following commands are an **unexecuted approved-operator runbook**, not Task12 shared operations:

```text
docker compose --env-file .env -f deploy/compose/compose.yaml config --quiet
docker compose --env-file .env -f deploy/compose/compose.yaml --profile management-ops build management management-bootstrap management-migrate management-seed ingest
# Only after destination/backup/PG-health/UID-readability checks and explicit approval:
docker compose --env-file .env -f deploy/compose/compose.yaml --profile management-ops run --rm --no-deps management-bootstrap
docker compose --env-file .env -f deploy/compose/compose.yaml --profile management-ops run --rm --no-deps management-migrate
docker compose --env-file .env -f deploy/compose/compose.yaml --profile management-ops run --rm --no-deps management-seed
```

Require success after **each** command before proceeding. Migration wrapper invokes only `prisma migrate deploy` with the owner URL privately supplied to the child; no URL is an argv value. Seed is an explicit owner action **after build and deployment**, imports the compiled profile validator, creates immutable Linux/Windows base v1 profiles (15-second interval, all four metric groups enabled, options `{}`) and inserts the fixed Gateway source. It does not overwrite incompatible published data and is never automatic.

Operator must verify migration history/grants and source identity before starting Management. Its readiness checks required auth config, primary DB, runtime role/grants and expected completed migration state; failed/missing migration stays unready. Because ops are intentionally profiled one-offs, there is no hidden automatic bootstrap/seed dependency.

Only in the approved change window, with PostgreSQL and Prometheus already healthy, start/qualify Management before a Gateway cold-cache restart:

```text
docker compose --env-file .env -f deploy/compose/compose.yaml up -d --no-deps --wait management
docker compose --env-file .env -f deploy/compose/compose.yaml up -d --no-deps --wait ingest
```

Do not treat the commands as approval to restart the existing shared stack. Without that separate approval, record **shared rollout NOT RUN** and stop at isolated packaging/runtime evidence.

## 5. Runtime meaning, failure handling and rollback

Management liveness performs no dependency IO; readiness is bounded and checks DB/auth state, not Grafana login or Prometheus. Its healthcheck uses Node's built-in fetch with a two-second abort. Gateway readiness uses bounded Prometheus and **signed** Management credential-health probes, not anonymous health and not a real Agent key. Docker unhealthy does not itself request a restart during a dependency outage.

Credential positive cache is at most 30 seconds, starts before the RPC, and is never sliding or served stale after expiry. Cold/expired cache plus dependency outage yields 503; inactive credentials yield 401. Do not disable verification to recover readiness. Revoke cannot cancel an already authenticated request or delete old samples.

Reporter captures truthful boot ID/start time once. A delayed first registration after a control-plane outage remains that same boot (Controller T10 Ruling6); future skew is bounded and a stale earlier boot cannot replace a newer one. Never refresh timestamps/UUIDs, fake an epoch, or add auth fallback to disguise downtime. Coverage begins no earlier than server activation. Status is monitoring evidence, not proof a machine is powered off; gaps/stale source/never-seen yield Unknown rather than fabricated Offline.

On failure, keep errors finite/sanitized, protect private evidence, preserve DB/volumes and inspect the failed stage. Use only a reviewed schema-compatible previous image as application rollback; no destructive schema rollback, broad grant escalation, root-role fallback, auto password rotation, or disabling signatures. Database restoration or grant/secret changes require their own operator plan and approval.

## Isolated qualification commands

Management's `pnpm test` is unit-only; `pnpm test:integration` uses the guarded uniquely named tmpfs PostgreSQL harness. The opt-in `TASK12_RUN_IMAGES=1 pnpm test:deployment` builds all four Management targets plus Gateway test/runtime, creates local private fixtures, performs explicit bootstrap/deploy/seed on its own database, checks generated Prisma runtime queries/health/least grants/UID mounts/read-only rootfs, runs Management Linux unit/integration and Gateway Linux tests, then tears down only its positively identified project. No named volumes or Docker socket mounts are used. Linux integration sets `INFRAPULSE_TEST_DB_EXTERNAL=1` and checks exact run/database marker on that parent-owned DB; the Linux child cannot operate Docker.

Gateway deployment tests are selectable using `pytest -m deployment`. `TASK12_RUN_COMPOSE_PATH_CHECK=1` enables only the new generated-nonsecret CLI path regression. Leave `TASK7_RUN_COMPOSE_PATH_CHECK` **unset**. Use the isolated uv 0.13.6 runner (`uv tool run --from uv==0.13.6 uv ...`), not a global upgrade. Each host pytest invocation needs a new nonexistent `--basetemp` under the ignored task workspace. Do not reuse/clear its root or another task's evidence.

Actual execution counts/exits/limitations are in the controller-reviewed Task12 report, not inferred from this runbook. Full cross-service adversarial acceptance, native Windows host IPv4/IPv6 probes and final whole-change security evidence remain Task13.
