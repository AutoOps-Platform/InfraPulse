# Bước 2 — Ingestion Gateway (local lab)

## Phạm vi và trạng thái

FastAPI nhận Remote Write 1.0 **scalar subset** tại `POST /api/v1/ingest/remote-write`, chuẩn hóa nhãn rồi forward **một lần** tới Prometheus hiện hữu. [Nghiệm thu thực tế GW-01–GW-15](<ingestion-gateway-acceptance.md>) phân biệt tests, runtime, UI và native-host isolation; không dùng HTTP 204 thay bằng chứng query.

**Không phải production authentication.** Bearer chỉ được kiểm tra hình thức/non-empty; token bất kỳ hợp lệ về hình thức đều được nhận. `X-Server-ID`/`X-Agent-ID` tự khai báo, không chống giả mạo. Không gửi production key; chưa có credential provider, TLS, public/LAN ingress, HA/multi-worker, installer hay VM Telegraf đã nghiệm thu.

## Prerequisites, pins và dev checks

- Windows Docker Desktop WSL2/Linux containers; PowerShell 7.3+ cho operator (native argument passing `Standard`). Các test host của implementation chạy PowerShell 5.1 với argument đơn giản, không phải hỗ trợ mọi lệnh runbook trên Legacy.
- Giữ stack Bước 1 và [environment riêng](<../../.env>); **không đọc/in/copy đè credential**. [Template](<../../.env.example>) mô tả từng `INGEST_` input; app không tự load dotenv.
- Python host 3.12.8; image `python:3.12.16-slim-bookworm@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337`; uv **0.13.6**. Global uv không cần nâng: dùng wrapper bên dưới.
- [Project pins](<../../services/ingestion-gateway/pyproject.toml>): FastAPI 0.162.0/Uvicorn 0.54.0, HTTPX 0.28.1, protobuf 7.36.2, cramjam 2.14.0, pydantic-settings 2.16.2, prometheus-client 0.26.0, anyio 4.15.1; dev pytest 9.2.0/pytest-asyncio 1.4.1/grpcio-tools 1.85.1/PyYAML 6.0.3. Không sửa tay [lock](<../../services/ingestion-gateway/uv.lock>) hoặc [generated protobuf](<../../services/ingestion-gateway/app/proto/remote_write_pb2.py>).

Chạy tại thư mục project Gateway; sau **mỗi** native command, dừng nếu exit khác 0:

```powershell
uv tool run --from uv==0.13.6 uv sync --frozen --group dev
if ($LASTEXITCODE -ne 0) { throw 'Frozen sync failed' }
uv tool run --from uv==0.13.6 uv lock --check
if ($LASTEXITCODE -ne 0) { throw 'Lock check failed' }
$before = (Get-FileHash -Algorithm SHA256 app/proto/remote_write_pb2.py).Hash
uv tool run --from uv==0.13.6 uv run --frozen python -m grpc_tools.protoc -I app/proto --python_out=app/proto app/proto/remote_write.proto
if ($LASTEXITCODE -ne 0) { throw 'Codegen failed' }
$after = (Get-FileHash -Algorithm SHA256 app/proto/remote_write_pb2.py).Hash
if ($before -ne $after) { throw 'Generated protobuf changed; review before continuing' }
# Use a NEW nonexistent directory, never a shared directory pytest may clear.
$base = Join-Path (Resolve-Path ../..).Path ('.superpowers/sdd/2026-10-31-ingestion-gateway/task8-operator-' + [guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $base) { throw 'Basetemp collision' }
$env:TASK7_RUN_COMPOSE_PATH_CHECK = '1'
uv tool run --from uv==0.13.6 uv run --frozen pytest tests/unit tests/integration -q --basetemp $base
if ($LASTEXITCODE -ne 0) { throw 'Host tests failed' }
Remove-Item Env:TASK7_RUN_COMPOSE_PATH_CHECK
# No INFRAPULSE_RUN_E2E flag: all five cases SKIP, even if Docker is unavailable.
if (Test-Path -LiteralPath ($base + '-skip')) { throw 'Skip basetemp collision' }
uv tool run --from uv==0.13.6 uv run --frozen pytest tests/e2e/test_remote_write.py -q --basetemp ($base + '-skip')
if ($LASTEXITCODE -ne 0) { throw 'Default E2E collection failed' }
```

Host's default Admin pytest temp tree was inaccessible during implementation; no ACL repair is claimed. Keep fresh task-specific basetemp. The [hex fixture](<../../services/ingestion-gateway/tests/fixtures/remote_write_scalar.hex>) was hand-derived: one `__name__=up`, value `1.0`, timestamp `1000` ms; tests assert these independently before updating the fixture's metric/run_id/current timestamp for a real send.

## Canonical Compose commands — approved plan erratum

**Root:** `C:\MF\VSCODE\InfraPulse`. Always retain `--env-file .env -f deploy/compose/compose.yaml`, **omit `--project-directory .`**. The original Task 7/8 plan snippets used that wrong override: it actually resolved context to `C:\MF\services\ingestion-gateway` and binds outside this repository, and the build failed. Default project directory must remain `deploy/compose`, so existing `../../services` and `../../observability` paths resolve correctly. Do not “fix” YAML paths, project `infrapulse`, networks or volume names. This is a CLI correction, not a rewrite of historical acceptance.

Only perform runtime changes when authorized. Existing data/credential must remain intact. Complete the [Bước 1 bind-source preflight](<central-infrastructure.md#3-khởi-động-lần-đầu>) before Docker touches bind sources.

```powershell
$PSNativeCommandArgumentPassing = 'Standard'
$dc = @('--env-file', '.env', '-f', 'deploy/compose/compose.yaml')
function Assert-NativeExit { param([string]$Action)
    if ($LASTEXITCODE -ne 0) { throw "$Action failed (exit $LASTEXITCODE)" }
}
docker compose @dc config --quiet
Assert-NativeExit 'Compose config (no expanded credentials)'
docker compose @dc build ingest
Assert-NativeExit 'Frozen production build'
docker compose @dc up -d --wait ingest
Assert-NativeExit 'Gateway startup'
docker compose @dc exec -T prometheus promtool check config /etc/prometheus/prometheus.yml
Assert-NativeExit 'Prometheus config'
# Only when the reviewed scrape config changed; no whole-stack recreation.
docker compose @dc restart prometheus
Assert-NativeExit 'Prometheus scrape reload via restart'
docker compose @dc ps
Assert-NativeExit 'Four-service health'
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8000/health/live -TimeoutSec 5
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8000/health/ready -TimeoutSec 5
```

Gateway: one worker, UID/GID `10001:10001`, read-only rootfs, `/tmp` tmpfs, cap drop ALL, no-new-privileges, 512 MiB/128 PIDs; no data/root-env/socket mounts. Only monitoring network and loopback host mapping `127.0.0.1:${INGEST_HOST_PORT:-8000}:8000`. Prometheus/PostgreSQL remain unpublished. Runtime inspect is useful but **not proof of native host isolation**; use a proxy-disabled finite native-host IPv4 probe and record any reachability as **GW-14 FAIL**, without silently changing firewall/binding.

## Sender protocol and Telegraf example (NOT VM-tested)

Required single-valued headers (duplicates/mixed-case duplicates are rejected):

| Header | Lab value / constraint |
|---|---|
| Authorization | `Bearer <dummy-lab-token>`; non-empty, max token 4096 bytes; no key validation |
| X-Server-ID / X-Agent-ID | 1–128 ASCII bytes matching `[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}` |
| Content-Type | `application/x-protobuf` |
| Content-Encoding | `snappy` raw/block, not framed or an encoding chain |
| X-Prometheus-Remote-Write-Version | `0.1.0` |
| User-Agent | non-empty, max 256 bytes |

Illustrative Telegraf `outputs.http` only; **not tested on a Windows/Linux VM**, and no installer is supplied. `prometheusremotewrite` serializes protobuf and raw Snappy already; do not add gzip/framed compression. Metric names emitted by Telegraf depend on its inputs/mapping; this is not the fixed pytest metric.

```toml
[[outputs.http]]
  url = "http://127.0.0.1:8000/api/v1/ingest/remote-write"
  method = "POST"
  timeout = "20s"
  data_format = "prometheusremotewrite"
  [outputs.http.headers]
    Authorization = "Bearer dummy-lab-only-not-a-production-key"
    X-Server-ID = "srv-lab"
    X-Agent-ID = "agent-lab"
    Content-Type = "application/x-protobuf"
    Content-Encoding = "snappy"
    X-Prometheus-Remote-Write-Version = "0.1.0"
    User-Agent = "infrapulse-telegraf-lab/0.1.0"
```

Loopback above is the **sender's own host**. A VM cannot reach this host-bound Gateway through its own `127.0.0.1`; LAN/VM routing, TLS/auth and firewall design require separate approval. Do not widen binding to make this example work.

Missing `server_id`/`agent_id` labels are injected; matching labels retained; conflict, duplicate label names or duplicate canonical series reject **the entire request before forward**. No ID overwrite, timestamp correction or finite-float coercion. Empty WriteRequest/series, recursive unknown fields, metadata, exemplars and native histograms are unsupported and rejected, not silently dropped.

Defaults: compressed/decompressed `1048576`/`8388608` bytes, 5000 series, 20000 samples, 64 labels/series **after injection**, two inflight, rate 10/s/burst20, age3600s/future120s/body5s. Metric/label-name/value UTF-8 byte caps 256/128/1024; label values non-empty. Counts/timeouts positive and finite (only future skew can be zero). Connect/read/write/pool/upstream-total/readiness-total seconds: `2/10/10/1/12/1`.

## Status and retry matrix

| Result | Meaning | Sender action |
|---|---|---|
| 204 | Upstream returned 2xx, not merely Gateway parse success | Never retry |
| 400 | Bad headers/body/wire/labels/timestamps, identity conflict, upstream400 | Fix data; do not retry unchanged |
| 401 | Missing/malformed Bearer; not expired/revoked-key validation | Fix syntax; no automatic retry |
| 408 | Body deadline | Fix sender/body behavior; E2E does not retry 4xx except429 |
| 413 | Byte/count limits or upstream413 | Split/reduce payload, not unchanged retry |
| 415 | Unsupported content/encoding/version | Fix protocol |
| 429 | Admission or upstream rate limit | Respect Retry-After; bounded caller-only retry |
| 502 | Upstream redirect/unexpected status, including upstream422 | Diagnose; bounded caller-only 5xx retry |
| 503 | Upstream5xx or network/protocol failure (not timeout) | Bounded caller-only retry |
| 504 | Upstream connect/read/write/pool timeout or total deadline | Outcome uncertain; retry may duplicate/encounter partial write |
| 500 | Internal error, sanitized response | Diagnose, bounded caller-only retry |

Gateway never retries, follows redirects, queues unbounded work, schedules background delivery or rolls back TSDB. **Partial writes/timeouts are uncertain; not transactional/exactly-once.** E2E sender retries only transport errors/5xx/429, max3 attempts/20s total, exponential `0.5s * 2^attempt + uniform(0,0.25)`; valid Retry-After on429 clamped1–60s and cannot consume remaining deadline then start another attempt. Identical bytes/timestamps are reused. This does not configure Telegraf's own delivery policy.

## Linux tests and opt-in E2E (sequential, non-destructive)

From root; fresh build is essential because Task 7's image predates these tests. Use the exact pinned [Dockerfile](<../../services/ingestion-gateway/Dockerfile>) target `test`, narrow Gateway build context, frozen dev dependencies; no permanent test service, root-env bind or extra helper image.

```powershell
$dc = @('--env-file', '.env', '-f', 'deploy/compose/compose.yaml')
$promId = docker compose @dc ps -q prometheus
Assert-NativeExit 'Prometheus ID'
if (-not $promId) { throw 'Prometheus is not running' }
$nets = docker inspect --format '{{json .NetworkSettings.Networks}}' $promId | ConvertFrom-Json
Assert-NativeExit 'Network inspect'
$monitor = @($nets.PSObject.Properties | Where-Object { $_.Value.Aliases -contains 'prometheus' })
if ($monitor.Count -ne 1) { throw 'Resolve exactly one network by Prometheus alias; do not guess' }
$network = $monitor[0].Name
docker build --target test -t infrapulse-ingest-test:task8 services/ingestion-gateway
Assert-NativeExit 'Fresh Task 8 test image'
docker run --rm --network $network infrapulse-ingest-test:task8 pytest tests/unit tests/integration --ignore=tests/integration/test_deployment_config.py -q
Assert-NativeExit 'Linux application tests'
# Only after that command has completed; no concurrent E2E runs.
docker run --rm --network $network -e INFRAPULSE_RUN_E2E=1 infrapulse-ingest-test:task8 pytest tests/e2e/test_remote_write.py -m e2e -q -s
Assert-NativeExit 'Remote Write E2E'
```

Only the repository config module is excluded on Linux: Compose/env repo is not copied into image; all config tests (including explicit opt-in canonical-path check) run on Windows. All other codec/admission/HTTP unit/integration tests run on both OSs. E2E endpoints default to `http://ingest:8000` and `http://prometheus:9090`, overridable via `E2E_GATEWAY_URL`/`E2E_PROMETHEUS_URL`; no token in CLI/env/URL. Module import/collection is network-free and five cases skip unless exactly `INFRAPULSE_RUN_E2E=1`.

Each case gets a fresh UUID run_id/current sample timestamp. Missing/matching IDs produce `42.25`/`43.25`; conflict99.0 must remain absent across the full30s query deadline (not just one empty result). Poll0.5s, presence deadline30s, scrape deadline90s. Successful console records expose only run_id/value/IDs/sample timestamp, never authorization or raw payload. Samples remain under normal retention; no deletion/admin API, Compose start/stop or production retry is performed by tests.

## Grafana, health, observability and recovery

1. Human logs into <http://127.0.0.1:3000> privately; use existing Explore datasource **Prometheus**, UID `infrapulse-prometheus`. Do not create a new datasource or expose9090.
2. Immediately after a successful case, query `infrapulse_e2e_value{run_id="<actual-run-id>"}` in Explore, Run a **new instant query** within default5m lookback. Confirm `42.25` or `43.25` plus `server_id="srv-e2e"`, `agent_id="agent-e2e"`; record exact time/query/sanitized screenshot. Controller owns interactive UI during this task. API success alone cannot make GW-13 PASS. After5m, use a historical evaluation time/range covering the stored sample; do not claim an empty current instant query disproves ingestion.
3. `/health/live` is process liveness; `/health/ready` checks upstream with a separate short-budget client and returns503 when upstream unavailable. Compose uses readiness but does not implement outage-driven restart loops. Health/metrics bypass ingestion rate/slot limits. Do **not** stop Prometheus to repeat an outage test; MockTransport tests cover it.
4. `/metrics`: request totals by finite status, request durations by status_class, inflight gauge, rejections by finite reason, forward totals/upstream duration by finite result. No identity/token/URL/run_id labels. Scrape `up{job="ingestion-gateway"}` independently verifies scrape, not write success.
5. Logs are allowlisted JSON timestamp/level/event/request_id/route/status/duration/counts/upstream_status/error_code, not headers/payload/query/exception bodies. Request IDs are server-generated. Uvicorn access logs disabled, HTTPX/httpcore restricted. Inspect only selected fields; never full env/config/log sharing.

```powershell
docker compose @dc logs --no-color --tail 100 ingest
Assert-NativeExit 'Read bounded Gateway logs (sanitize privately before sharing)'
# Gateway-only rollback when authorized; leaves all Step 1 services/data intact.
docker compose @dc stop ingest
Assert-NativeExit 'Stop Gateway only'
# Restore reviewed source/config/pin (not volumes), then build/start only Gateway.
docker compose @dc build ingest
Assert-NativeExit 'Build reviewed Gateway'
docker compose @dc up -d --no-deps --wait ingest
Assert-NativeExit 'Restore Gateway (requires existing Prometheus ready)'
```

Do not `down -v`, prune/reset Docker, delete samples or rotate credential by editing dotenv. Preserve baseline IDs/volume names and keep TSDB data; Gateway has no volume. Full stack shutdown via [Bước 1 runbook](<central-infrastructure.md>) now also affects Gateway and needs separate operator intent. Auth/TLS/LAN remediation, Telegraf VM, unsupported extensions, HA/load/long-term production readiness remain separate work, not hidden acceptance passes.
