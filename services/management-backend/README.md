# InfraPulse Management backend — Step3

NestJS/ESM control plane for Server/Agent inventory, one-time scoped credentials, signed Admin/service requests, immutable OS profiles/provisioning and confidence-aware telemetry. It does **not** receive raw metrics, render/install Telegraf, supply a Grafana login adapter, or qualify TLS/LAN/HA/load.

- [Protected deployment / Gate T12](<../../docs/deployment/management-backend.md>): distinct owner/runtime roles, explicit bootstrap→deploy migrations→seed, fixed Gateway UUID, UID-readable files and rollback preserving DB/volumes.
- [Acceptance and actual limits](<../../docs/deployment/management-backend-acceptance.md>).
- [Step4 Agent provisioning contract](<../../docs/contracts/agent-provisioning.md>).
- [Step6 signed adapter/API contract](<../../docs/contracts/grafana-management-api.md>).
- [Programmatic OpenAPI](<src/common/openapi.ts>): normal runtime has no public docs/raw JSON endpoint.

## Development and separate gates

Use Node24.20.0, pnpm11.24.0 and the committed frozen lock. No implicit dotenv, scaffold regeneration, Observe registration, external deployment or global tool upgrade.

```powershell
pnpm install --frozen-lockfile
pnpm db:generate
pnpm test
pnpm typecheck
pnpm lint
pnpm build
# Docker prerequisite; uniquely named tmpfs PostgreSQL only, never shared DB:
pnpm test:integration
```

Check each native exit before the next operation. `pnpm lint` is `oxlint --type-aware src/ test/`, not autofix. Integration retains [the original HTTP/DB scaffold test](<test/app.e2e-spec.ts>) and validates exact generated DB name/run marker plus container labels. A missing prerequisite is failure, not business/security RED. Private files and native stdout/stderr captures belong only in the ignored task workspace; never print values or expanded config.

## Opted real cross-service gate

The [E2E runner](<vitest.config.e2e.ts>) now selects [Management real flow](<test/e2e/management-flow.spec.ts>) and [security evidence](<test/e2e/security-evidence.spec.ts>), not the old in-process scaffold. Default `pnpm test:e2e` collects/skips safely without network/DB/Compose/images. With exact opt-in, missing Docker/images/keys/bootstrap/readiness fails the suite rather than skipping it.

From repository root, build prerequisites (not inside the180second startup budget):

```powershell
docker build --target runtime -t infrapulse-task13-management:runtime services/management-backend
docker build --target migrate -t infrapulse-task13-management:migrate services/management-backend
docker build --target runtime -t infrapulse-task13-gateway:runtime services/ingestion-gateway
# From services/ingestion-gateway, prepare the frozen native Python environment:
uv tool run --from uv==0.13.6 uv sync --frozen --group dev
# From services/management-backend:
$env:INFRAPULSE_RUN_MANAGEMENT_E2E = '1'
pnpm test:e2e
Remove-Item Env:INFRAPULSE_RUN_MANAGEMENT_E2E
```

Optional `TASK13_MANAGEMENT_RUNTIME_IMAGE`, `TASK13_MANAGEMENT_MIGRATE_IMAGE`, `TASK13_GATEWAY_RUNTIME_IMAGE` select separately qualified local tags; `TASK13_PYTHON` is an executable path, never a credential. Harness creates its own generated keys/public trust, exact guarded DB, dynamic-loopback/tmpfs stack and private overrides using the existing fullstack profile. It issues real credentials over Node-signed HTTP, invokes real Python HTTPX→Gateway→Nest→primary DB→Prometheus, and queries exact sample labels/value/timestamp. Every flow120seconds, test150seconds, startup180seconds, teardown60seconds. It retains all five Gateway E2E cases and unit retry/query contracts. No test signer is deployed to the shared stack.

Cleanup always uses the exact labelled project with **`--profile fullstack`**; default down omits profiled applications. Guard before teardown and prove zero exact-owned containers/networks; never `down -v`, prune, broad cleanup, root-env expansion or shared outage. Linux integration is parent-owned external DB mode (`INFRAPULSE_TEST_DB_EXTERNAL=1` plus private URL-file mounts and exact `TEST_DB_RUN_ID`), with no Docker socket/lifecycle in the child.

The [runtime vector generator](<test/support/scripts/task13-vector.mjs>) signs/verifies generated in-memory Ed25519 material and prints only a public raw-body hash/boolean verdict: `node test/support/scripts/task13-vector.mjs`. It is not real Grafana identity acceptance. Test fixture secrets are intentionally private artifacts; count-only scans cover captured errors/logs/audit, not publishing those fixtures.
