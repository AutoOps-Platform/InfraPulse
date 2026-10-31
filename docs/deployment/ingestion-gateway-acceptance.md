# Ingestion Gateway — acceptance 2026-10-31

**Task 8 results: 15 PASS (GW-01–GW-15), with the limits below.** This is local lab acceptance, not production readiness. All commands below were actually executed; timestamps use **+07:00** unless explicitly UTC. Historical [Bước 1 acceptance](<2026-10-30-central-infrastructure-acceptance.md>) is unchanged (11 PASS, 2 PARTIAL, 1 FAIL); its API-only UI limitations are not retroactively promoted.

## Authority and execution boundaries

Baseline **task-7-final**: four healthy services, production Gateway container `a80cf2ed99fe` already started/security-checked in Task 7. Task 8 changes only E2E/test-client contracts and [runbook](<ingestion-gateway.md>), [README](<../../README.md>), [Bước 1 runbook](<central-infrastructure.md>) and this acceptance. No app implementation, dependency/pin/Compose YAML, infrastructure, credential or Git changes. No browser automation by implementer; controller owns authenticated Grafana UI. No outage/restart/rebuild of production in Task 8, no production retries or destructive cleanup.

**Approved plan CLI erratum:** root commands retain `--env-file .env -f deploy/compose/compose.yaml`, omit `--project-directory .`. Task 7 actually reproduced the bad root override resolving the required `../../...` context/binds outside the repository. Keep YAML paths, project `infrapulse`, networks and named volumes; do not rewrite historical results. Root workdir: `C:\MF\VSCODE\InfraPulse`; uv/pytest/codegen workdir: its `services\ingestion-gateway` directory.

## Actual command / time / exit / result ledger

All pytest host runs used a **fresh verified-nonexistent** absolute basetemp under the ignored plan workspace, never the inaccessible default Admin temp tree or a shared directory. Each log explicitly uses UTF-8. `uv` in every command means the exact wrapper `uv tool run --from uv==0.13.6 uv`, not a global uv upgrade.

| Time (+07:00) | Actual command / context | Exit and observed outcome |
|---|---|---|
| 12:49:08–12:49:10 | `uv … run --frozen pytest tests/unit/test_e2e_contract.py -q --basetemp <fresh-task8-red-20261031-01>` | 1; initial missing E2E module: 1 failed, 21 fixture setup errors. Preserved as bootstrap evidence, **not** the clean behavior RED gate. |
| 12:49:48–12:49:50 | `uv … run --frozen pytest tests/unit/test_e2e_contract.py tests/e2e/test_remote_write.py -q --basetemp <fresh-task8-helper-red-20261031-01>` | 1; **21 failed, 1 passed, 5 skipped**, missing `send_with_retry`/`query_until` behavior. No setup/import/dependency failure. |
| 12:52:48–12:52:50 | Same focused command, fresh `task8-green-20261031-01` | 0; **22 passed, 5 skipped in 1.27s**. Default opt-in proof additionally imports/runs E2E in a subprocess with HTTP/socket fail-if-called guards and no flag: five skipped, no network calls. |
| 12:58:14–12:58:21 | `$env:TASK7_RUN_COMPOSE_PATH_CHECK='1'`; `uv … run --frozen pytest tests/unit tests/integration -q --basetemp <fresh-task8-final-windows-20261031-01>` | 0; **593 passed in 5.62s**, no warnings. Final full Windows unit/integration run exactly once after owned test/source edits, including the real opt-in canonical Compose path regression. |
| 12:58:21 | `uv … lock --check` | 0; 72 packages resolved, frozen lock consistent. |
| 12:58:21 | `uv … run --frozen python -m grpc_tools.protoc -I app/proto --python_out=app/proto app/proto/remote_write.proto`; SHA256 before/after | 0; identical `110911B571D4A70563A3A138FA396CCCE0653FACD9FADBF10BE9ADD54444512A`. Generated file not hand-edited. |
| 12:58:15–12:58:20 | Root `docker build --target test -t infrapulse-ingest-test:task8 services/ingestion-gateway` | 0; **fresh Task 8 test image**, exact Task 7 Dockerfile/pins/frozen dev deps, source/tests copied anew. Image ID `sha256:1b790a10ba984c04b259ff0510f6b3630652e30faec0dbdd3ee0d561f46c26d8`. Task 7's older test image was not reused. |
| 12:58:52–12:58:57 | Root resolve Prometheus ID via canonical Compose; inspect **only NetworkSettings.Networks** and select exactly one network with alias `prometheus`; `docker run --rm --name infrapulse-task8-linux-20261031 --network <resolved> infrapulse-ingest-test:task8 pytest tests/unit tests/integration --ignore=tests/integration/test_deployment_config.py -q` | 0; actual network `infrapulse_monitoring` resolved, not hardcoded; **568 passed in 3.08s**. Only the 25 host repository configuration cases excluded; all other application tests, including codec/admission/HTTP contracts, ran on Linux. |
| 12:59:21–12:59:56 | Re-resolve actual network; `docker run --rm --name infrapulse-task8-e2e-20261031 --network <resolved> -e INFRAPULSE_RUN_E2E=1 infrapulse-ingest-test:task8 pytest tests/e2e/test_remote_write.py -m e2e -q -s` | 0; **5 passed in 30.61s**, sequential after Linux tests. No concurrent E2E, root env bind, permanent test service or extra image. |
| 13:01:20–13:01:24 | Native `Get-NetIPConfiguration` active/default-gateway IPv4; host Python HTTPX `trust_env=False`, timeout3s probes + in-memory sentinel requests; bounded canonical Compose logs | 0; actual native IPv4 `192.168.1.11`, host live/ready200; native-IP connection fails `ConnectError`. Runtime logs: six JSON records, seven sentinel categories absent, observed204/400/404 records sanitized. |
| 13:01:24 | Root allowlisted `docker ps`/`docker volume ls` project filter and task-owned one-off name filter | 0; original three IDs + production Gateway ID retained, all four healthy; exact three volume names preserved; **zero Task 8 one-off containers remain**. |

PowerShell 5.1 rendered Docker/uv informational stderr as `NativeCommandError` wrappers in retained logs even when exit0; these are not pytest warnings or ignored build failures. No test-source changes followed the final Windows run. Documentation/evidence summaries were finalized afterward.

## Real sample/query evidence

Each case used a new UUID and current timestamp, constant bytes across sender retries. Identity labels in all successful vectors: `server_id="srv-e2e"`, `agent_id="agent-e2e"`, metric `infrapulse_e2e_value`. Stored timestamps were separately checked via `timestamp(...)`; instant-vector evaluation timestamp was not mistaken for the sample timestamp.

| Case | Actual run_id | Value | Sample timestamp (ms) | Observed outcome |
|---|---|---:|---:|---|
| Independent hand-derived scalar wire | `04bbf6da-c365-45ac-82c9-00469d80a975` | 1.0 | 1793426364284 | Fixture asserted independently as `__name__=up`,1.0,1000ms before rebasing; 204 then exact normalized vector/timestamp, observed `2026-10-31T05:59:24.319402Z`. |
| Missing identity labels | `18f3f8fe-cb99-4555-8d0f-704be0c01e1a` | 42.25 | 1793426364355 | 204, exact value + both injected IDs; observed `2026-10-31T05:59:24.366941Z`. Controller notified immediately. |
| Matching identity labels | `39c2b8ff-adc0-435c-b81d-c8e261b87f08` | 43.25 | 1793426364405 | 204, exact value + both retained IDs; observed `2026-10-31T05:59:24.418976Z`. Controller notified immediately. |
| Conflict | `03e678f0-513b-4b56-87d9-8f3eacfa88fa` | 99.0 rejected | 1793426364452 | 400; exact run_id selector remained empty for **full30s**, polling0.5s; not a pass from one empty query. |

Scrape check: `up{job="ingestion-gateway"} == 1`, `instance="ingest:8000"`, value1 within90s allowed budget. Sender helpers bound attempts≤3/total20s and preserve bytes/timestamps; only caller retries transient network/5xx/429, never204/other4xx. Query helper rejects API errors and requires full deadline for absence. These are test-client behaviors, not production retry features.

### GW-13 — controller-owned Grafana evidence

**PASS — controller-supplied interactive rendered UI evidence**, read by implementer from the [controller evidence record](<../../.superpowers/sdd/2026-10-31-ingestion-gateway/controller-grafana-ui-evidence.md>), not an API-only substitution. After receiving the positive-case notification, controller used the existing human-authenticated Explore **Prometheus**, UID `infrapulse-prometheus`, query `infrapulse_e2e_value{run_id="18f3f8fe-cb99-4555-8d0f-704be0c01e1a"}`, range **Last1hour**, Type **Both**. Rendered result: **one series, value42.25**, `server_id="srv-e2e"`, `agent_id="agent-e2e"` and the exact run_id. Controller read page text and visually inspected graph/raw result; no credential was read/exported/logged.

[Sanitized Grafana screenshot](<../../.superpowers/sdd/2026-10-31-ingestion-gateway/grafana-e2e-ui.png>), SHA256 `578B6364D5ABAC86AADBFA7C76D60207B9C6F3C41EA4A0328DB83FD3E55C6196`, was captured/preserved at **2026-10-31T13:05:41.5325714+07:00**. This is evidence capture/preservation time, **not an invented exact fresh-instant-query execution time**. The UI result loaded after notification; historical range covers the sample when a current instant query would outlive5m lookback. Only missing-ID42.25 is asserted as UI-observed; matching43.25 remains API/E2E evidence. Preliminary UI scrapeup1 is supplementary, not the basis of GW-13. Artifacts are intentionally local/ignored and are not shipped as tracked deployment inputs.

## Runtime logs and native-host isolation

Native host actual default-route active IPv4 `192.168.1.11`: HTTP to port8000 failed `ConnectError`, proxy disabled, timeout3s. Loopback live/ready both200. **GW-14 PASS for this observed interface/time only**, not a firewall audit or guarantee for future interfaces/configurations. No firewall/LAN remediation attempted. Container HostIp inspect was not used as substitute.

Bounded log command: `docker compose --env-file .env -f deploy/compose/compose.yaml logs --no-color --no-log-prefix --since <probe-start-UTC> --tail 100 ingest` (exit0). Probe-start UTC `2026-10-31T06:01:21.569410Z`. Seven unique dummy categories existed only in memory: Bearer token, payload label, invalid raw body, query, unknown path, custom header, incoming request ID. None appears in six captured JSON records; no authorization/Bearer/header/raw URL leaked. Selected server-generated completion records:

- 204, route `/api/v1/ingest/remote-write`, one series/one sample, upstream204, request ID `7eae6435a6924d88aa047e82b1696db7`.
- 400, same fixed route, `invalid_snappy`, request ID `e84887f5a41f4df988e630671e231577`.
- 404, route `unmatched`, request ID `17b18a47604d49e689e57db4eb0704d6`.

No token values, raw bodies, raw paths/query URLs or expanded env retained in this document. Host and container wall clocks differ slightly; timing/timeout assertions use monotonic clocks, not cross-clock subtraction.

## Data preservation

| Service | Before / after Task 8 ID | Final health |
|---|---|---|
| Grafana | `70ff554ec154` | healthy |
| PostgreSQL | `4452c134fd5d` | healthy |
| Prometheus | `a7827550e5d3` | healthy |
| Gateway | `a80cf2ed99fe` | healthy |

Exact preserved named volumes: `infrapulse_grafana_data`, `infrapulse_postgres_data`, `infrapulse_prometheus_data`. No TSDB deletion/admin-delete/down/volume reset; samples (including a dummy logging-probe series) remain under normal retention. Both task-owned `--rm` test containers exited and were automatically removed. This verifies ID/name preservation, not a fresh stored-data/backup restore audit. Task 7's production nonroot/security verification remains inherited evidence, not falsely rerun here.

## Actual GW-01–GW-15 outcomes

| ID | Result | Executed evidence / limitation |
|---|---|---|
| GW-01 | PASS | Existing layout retained; Windows lock check and identical protoc SHA256; frozen pinned Linux test build. |
| GW-02 | PASS | Windows configuration cases (including real canonical-path check), actual alias-resolved network; existing IDs/volumes retained, no new host9090/5432. |
| GW-03 | PASS | Header/identity cases in full Windows/Linux suites; arbitrary well-formed dummy Bearer accepted in runtime. **Key validation deferred.** |
| GW-04 | PASS | Independent wire E2E plus codec/body/output/unsupported-extension tests on both OSs. |
| GW-05 | PASS | Real missing/matching IDs correct; conflict400/full30s no series; integration asserts invalid requests do not forward. **No anti-spoof claim.** |
| GW-06 | PASS | Label/sample/timestamp/count boundary tests in both full application suites, real timestamp preservation query. |
| GW-07 | PASS | Single-attempt/lifecycle/status/timeout tests on both OSs; real204 then exact Prometheus sample. No production retry. |
| GW-08 | PASS | Rate/concurrency/cancellation/saturated health+metrics tests on both OSs. No load/HA/distributed limiter claim. |
| GW-09 | PASS | MockTransport good/bad upstream readiness/liveness tests on both OSs; actual live/ready200. No disruptive production outage test rerun. |
| GW-10 | PASS | Metric/log safety suites plus actual204/400/404 JSON runtime logs, seven in-memory sentinel categories absent. |
| GW-11 | PASS | Windows593/Linux568 passed; only25 host repository-config cases excluded from Linux. Default E2E5skip and opt-in guard proof. |
| GW-12 | PASS | Real E2E5pass: independent fixture, missing42.25, matching43.25, conflict99 absent30s, Gateway scrapeup1. |
| GW-13 | PASS | Controller Explore rendered exact missing-ID run_id/value42.25/both IDs, graph/raw result and sanitized screenshot; existing datasource. Matching43.25 not claimed separately UI-tested. |
| GW-14 | PASS | Native-host active IPv4 probe actually failed with proxy off/finite timeout; loopback200; original IDs/volumes retained. |
| GW-15 | PASS | README/Bước1/new Gateway runbooks and this actual-outcome record; CLI erratum and explicit limits, no historical-result rewrite. |

## Outstanding constraints / next checkpoint

- GW-13 initially remained pending and was promoted only after controller's exact rendered UI evidence arrived. Its capture timestamp is not the exact query-execution time; matching43.25 was not separately UI-observed.
- Authentication/authorization/key revoke/expiry and trusted ownership are **not implemented**; IDs self-declared. HTTP local lab only, no production tokens or LAN exposure.
- No actual Telegraf Windows/Linux VM test, TLS/firewall/LAN design, installer, HA/multi-worker, throughput/memory load acceptance or unsupported Remote Write extensions. Telegraf configuration is illustrative, not a tested VM claim.
- Receiver partial writes, response loss and timeout uncertainty remain; no transaction/exactly-once/durable queue/TSDB rollback.
- Default Windows temp limitation remains; fresh basetemp workaround does not repair permissions.
- Author task self-review precedes controller's independent Task 8 review; final whole-branch review belongs to controller afterward and is **not claimed complete**. No staging/commit/push.
