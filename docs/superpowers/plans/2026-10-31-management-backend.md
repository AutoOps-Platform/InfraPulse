# Management Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Xây NestJS control plane và Gateway authentication để tạo Server → đăng ký Agent → cấp key một lần → ingest đúng identity → revoke trong giới hạn30giây, có DB constraints/audit/provisioning/status và bằng chứng E2E thật.

**Architecture:** NestJS modular monolith + Prisma trên schema `management` của PostgreSQL hiện có. Gateway giữ metrics body trên đường riêng đến Prometheus; chỉ credential proof và bounded observation đi NestJS. Grafana adapter thật thuộc Bước6; Bước3 verify signed contracts bằng fixture, không local-user database hoặc insecure fallback.

**Tech Stack:** NestJS12.3.2, Node24.20.0, TypeScript6.0.3, pnpm11.24.0, Vitest4.1.12/Vite8.3.5 + SWC, Prisma/client/adapter-pg7.10.1, PostgreSQL18.6; FastAPI/Python3.12/HTTPX cùng dependency pins Bước2, thêm PyJWT/cryptography/RFC8785.

**Spec:** [2026-10-31-management-backend-design.md](<../specs/2026-10-31-management-backend-design.md>) — bản390dòng được người dùng duyệt; authority khi plan và spec xung đột.

**Status/authority:** Plan để review, không là quyền implement/install/migrate/build/start/stage/commit/push. Baseline `869328ead1bdc8354b1454db66e3554cc2539bcf`; scaffold Management untracked là công việc người dùng phải bảo toàn. Quyền publish Bước2 không áp dụng Bước3. Lựa chọn Subagent/Native phải được người dùng xác nhận sau khi review plan.

## Global Constraints

- Dùng **schema mới `management` trong DB `infrapulse`**. Không sửa/reset `public`, không tạo lại volume và không dùng DB Grafana.
- Tách role migration owner và role runtime. Runtime không CREATE/ALTER/DROP/TRUNCATE; audit chỉ SELECT/INSERT. Không runtime DML migration history, không bootstrap superuser cho app.
- Chỉ `prisma migrate deploy` trên deployment DB; không `db push`, reset, auto synchronize, down-v/prune/delete TSDB/firewall/LAN change.
- Một Agent `active`/Server bằng partial UNIQUE; Agent không chuyển Server. `active` không phải Online. Disable/retire/archive và key revoke/audit atomic; enable không phục hồi key cũ.
- Secret32bytes CSPRNG, base64url không padding43ký tự, token `<canonical-lowercase-uuid>.<secret>`; SHA-256 verifier32bytes, constant-time compare, chỉ hiện plaintext một lần. Default expiry30ngày/max365ngày; overlap rotate300giây, không kéo dài cutoff cũ.
- `POST /internal/v1/credentials/verify` body api_key, cap8KiB; active proof không secret/hash. Primary DB, không positive cache NestJS. Gateway positive TTL≤30000ms từ **trước call**, không sliding/stale fallback; fingerprint toàn bộ key, cache1024/max10000.
- Cold/expired cache + dependency failure→503, valid cache chỉ dùng đến deadline; active=false→401. Không hứa hủy request đã authenticate trước revoke hoặc xóa samples cũ.
- IDs header optional để đối chiếu; mismatch403, malformed/duplicate400. Trusted proof IDs inject missing payload labels, conflicting payload400 whole-batch/no forward. Giữ toàn bộ codec/forwarder/cancellation invariants Bước2.
- Admin Ed25519 assertions≤60giây, leeway5giây, signed raw method/target/body, nonce durable và replay fail-closed. `Viewer→Viewer`, `Editor→Operator` readonly Bước3, org `Admin→Admin`. Gateway service không Admin; Agent guard riêng. Không username-as-stable-ID, browser role headers, Nest password/organization module.
- Profile JSON validated64KiB, interval15giây/allow5–300, RFC8785 checksum, immutable published versions, exact OS-compatible assignment. Bước4 mới render/cài Telegraf; GET provisioning không mark applied/Online.
- Last success chỉ sau auth/validate/Prometheus2xx; receipt-of-success clock, không sample clock. Reporter10giây, pool1/deadline2giây, max1024Agents/256records/64KiB/chunk, max4chunks/256KiB,3attempts/snapshot; no raw metrics/key/durable delivery queue.
- Telemetry dùng status_as_of; age≤90 Online,90<age≤300 Stale,>300 Offline chỉ khi coverage đủ; never-seen/gap/stale source>30giây→Unknown. Restart không fake continuity, Offline không là máy tắt.
- Management monitoring+database; Gateway monitoring-only. Container3000/host loopback3001, Grafana3000/Gateway8000 giữ nguyên. Single process, nonroot, read-only/tmpfs/caps ALL/no-new-privileges,512MiB/pids128/log10m×3.
- Root command giữ `docker compose --env-file .env -f deploy/compose/compose.yaml ...`, **không `--project-directory .`**. Không in expanded config/Config.Env/root.env/keys. Signature không thay TLS; HTTP chỉ lab loopback/private, không production/LAN claim.
- Không tạo README/tests dưới infra. Không gọi `nest observe`, scaffold `nest deploy`, external telemetry/publish. Không generate/scaffold lại Management hoặc major-upgrade framework để né một lỗi build.
- Mỗi task ghi actual RED/GREEN/exit/changed files/limits và review checkpoint; **không staging/commit** khi chưa được cho phép riêng. Trước sửa phải đọc file; snapshot untracked scaffold trước execution; preserve unrelated changes và prior acceptance FAIL/PARTIAL.

## Review Focus

1. **Mất response issue/rotate và retry:** cùng issuance_request_id không mint thêm key/reveal lại; actor không lấy secret qua metadata/audit — T5 `credentials.spec.ts`/`credentials-db.spec.ts`.
2. **Nonce replay sau restart/cap race và raw-target/body khác nghĩa:** không refresh trust từ cache hoặc normalize request trước verify; cap không evict live nonce — T3 `assertions.spec.ts`/`replay-db.spec.ts`.
3. **Slow auth RPC/cancel/revoke race:** TTL không bắt đầu ở response arrival; admission không double-acquire/early-release; direct legacy Identity không mở bypass — T8 `test_credentials.py`, T9 `test_authenticated_ingestion.py`.
4. **Late old-epoch/multi-chunk/duplicate report:** stale registration không chiếm epoch; duplicate không trẻ hóa heartbeat; normal pending không giả gap, timeout/drop không giả Offline — T10 `status-db.spec.ts`, T11 `test_status_reporter.py`.
5. **Errors ngoài happy path và fixture lộ secret:** malformed JSON/DTO, ORM/bootstrap/HTTPX exceptions, private-key parse failure và logger mặc định không dump request/verifier/key/URL — T1 `http-boundary.spec.ts`, T13 `security-evidence.spec.ts` và `test_authenticated_observability.py`.

---

## 1. Baseline, pins và evidence đã có (metadata-only)

Đã đọc full INTRODUCT và spec; root/scoped AGENTS; scaffold package/lock/ESM/build/test config, Gateway interfaces và Compose/env/ignore. Code Graph project `C-MF-VSCODE-InfraPulse` ready nhưng candidate metadata_changed/deploy excluded; source fallback đã dùng, graph không được coi exhaustive. Current `IngestionPipeline.handle(stream, identity, received_at_ms)` acquire lease nội bộ; `create_app` chỉ upstream/ready transports; **không CredentialProvider**. Existing E2E helpers `send_with_retry`/`query_until` nằm ngay trong `G/tests/e2e/test_remote_write.py`, không có helpers.py riêng. Build tsconfig rootDir=src nên output chính là dist/main.js.

| Pin sẽ áp dụng ở task sở hữu | Version/evidence |
|---|---|
| Framework/test baseline giữ/pin lock | Nest common/core/platform-express/testing12.3.2; CLI12.0.11, schematics12.0.12; TypeScript6.0.3, Vite8.3.5, Vitest/coverage4.1.12; không resolver upgrade sang major khác |
| Node Linuxamd64 | `node:24.20.0-bookworm-slim@sha256:6642ef280aebc09c4541bee0b15c9f89f0f3f3c247ddee79ae1d37eddfdcbbaa`; registry child/config đã kiểm tra linux/amd64/NODE_VERSION. Không nhầm multiarch index ba849c60… |
| pnpm |11.24.0, engines Node≥22.13; host hiện đã có11.24.0, không cần global upgrade |
| Prisma CLI/client/adapter-pg |**7.10.1 cả ba**, stable exact metadata. Không dùng latest đang trỏ8.0.0-rc.29; Node/TS engine declarations phù hợp, chưa có build proof |
| pg / @types/pg |8.23.1 /8.16.0; explicit pool timeouts, không default connectionTimeout=0 |
| Validation/OpenAPI |class-validator0.15.1,class-transformer0.5.1,jsonc-parser3.3.1,@nestjs/swagger12.0.5 (peers Nest12/TS6) |
| Signature/canonical JSON |jose6.2.14,canonicalize5.1.0(Node≥22) |
| Vitest transform |unplugin-swc2.0.0,@swc/core1.16.21; explicit es6/legacyDecorator/decoratorMetadata, tắt OXC qua plugin |
| Python additions |PyJWT[crypto]2.15.1,cryptography50.0.2,rfc8785 0.1.4. PyPI có pure wheels và cp311-abi3 Winamd64/manylinux x86_64 dùng được với Python3.12; chưa install/run |

Primary references: [Prisma7 upgrade](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7), [NestJS guide7](https://www.prisma.io/docs/guides/v7/frameworks/nestjs), [Prisma config7](https://www.prisma.io/docs/orm/v7/reference/prisma-config-reference), [adapter7.10.1 types](https://unpkg.com/@prisma/adapter-pg@7.10.1/dist/index.d.ts), [Nest SWC recipe](https://docs.nestjs.com/recipes/swc), [unplugin2.0.0 source](https://github.com/unplugin/unplugin-swc/blob/v2.0.0/src/index.ts), [pnpm metadata](https://registry.npmjs.org/pnpm/11.24.0), [Node manifest](https://registry-1.docker.io/v2/library/node/manifests/24.20.0-bookworm-slim), [Prisma metadata](https://registry.npmjs.org/prisma/7.10.1), [crypto wheels](https://pypi.org/pypi/cryptography/50.0.2/json). Đây là read-only preflight, không successful install/build/test/runtime assertion. Compatibility gates T1/T2/T8/T12 phải pass thật; nếu fail báo đúng nguyên nhân, không hạ bảo mật/đổi major ngầm.

## 2. File map và ownership trước tasks

Path notation xác định: `M=services/management-backend`, `G=services/ingestion-gateway`, mọi path từ repository root; `{a,b}.ts` nghĩa đúng hai file a.ts/b.ts, không wildcard cho phép thêm kiến trúc khác. N=new, E=existing-read-before-modify. Shared files chỉ sửa ở task ghi rõ; không concurrent implementers.

| Owner | Files và một trách nhiệm |
|---|---|
| T1 foundation | E `M/package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `vitest.config.e2e.ts`, `src/{main,app.module}.ts`, root `.gitignore`; N `M/src/bootstrap.ts`, `src/config/{config,secret-files}.ts`, `src/common/{clock,errors,safe-logger,http-boundary,pagination}.ts`, `src/health/{health.module,health.controller,health.service}.ts`, `test/setup.ts`, `test/support/{clock,config}.ts`, `test/unit/{metadata,config,http-boundary,pagination}.spec.ts` |
| T2 database/audit | N `M/prisma.config.ts`, `prisma/schema.prisma`, `prisma/migrations/migration_lock.toml`, `prisma/migrations/202611010001_management/migration.sql`, `scripts/{bootstrap-db,migrate-db,seed-db}.ts`, `src/database/{database.module,database.service,locks}.ts`, `src/audit/{audit.module,audit.service,audit.dto}.ts`, `test/compose.yaml`, `test/support/{pg-harness,db}.ts`, `vitest.config.integration.ts`, `test/integration/{database,audit-db}.spec.ts`; generated ignored `src/generated/prisma/`; E package/lock/AppModule/ignore/`test/app.e2e-spec.ts` |
| T3 auth/API policy | N `M/src/auth/{auth.module,principal,assertions,nonce.service,auth.guard,roles.guard,policies,current-user}.ts`, `src/common/openapi.ts`, `test/support/{keys,signed-client}.ts`, `test/unit/{assertions,roles}.spec.ts`, `test/integration/{replay-db,auth-http}.spec.ts`; E `src/{bootstrap,app.module,app.controller,app.service}.ts`, existing controller spec, `test/app.e2e-spec.ts`, package/lock |
| T4 inventory | N `M/src/servers/{servers.module,servers.controller,servers.service,servers.dto}.ts`, `src/groups/{groups.module,groups.controller,groups.service,groups.dto}.ts`, `src/agents/{agents.module,agents.controller,agents.service,agents.dto}.ts`, `test/integration/{inventory-db,agents-db}.spec.ts`, `M/src/audit/audit.controller.ts`; E AppModule/OpenAPI/audit.module/service/dto for Admin audit list; status fields deferred T10, no fake Online |
| T5 credential | N `M/src/credentials/{credentials.module,credentials.controller,credentials.service,credentials.dto,credential-verifier,agent-key.guard}.ts`, `test/unit/credentials.spec.ts`, `test/integration/credentials-db.spec.ts`; E AppModule/OpenAPI |
| T6 profile | N `M/src/profiles/{profiles.module,profiles.controller,profiles.service,profiles.dto,profile-config}.ts`, `test/unit/profile-config.spec.ts`, `test/integration/profiles-db.spec.ts`; E package/lock/seed/AppModule/OpenAPI |
| T7 provisioning | N `M/src/provisioning/{provisioning.module,provisioning.controller,provisioning.service,provisioning.dto}.ts`, `test/integration/provisioning-db.spec.ts`; E Agent DTO/selector for reported fields, AppModule/OpenAPI |
| T8 Gateway proof | N `G/app/{service_auth,management_client,credentials}.py`, `G/tests/unit/{test_service_auth,test_credentials}.py`; E `G/pyproject.toml`, `G/uv.lock`, `G/app/errors.py`; no production Settings/lifespan change until T9 |
| T9 auth integration | E `G/app/{identity,config,errors,main,pipeline,observability}.py`, routes/{ingest,health}.py, `tests/conftest.py`, existing identity/config/ingestion/health/observability tests; N `G/tests/integration/test_authenticated_ingestion.py`, `test_authenticated_observability.py` |
| T10 status backend | N `M/src/status/{status.module,status.controller,status.service,status.dto,status-evaluator}.ts`, `test/unit/status.spec.ts`, `test/integration/status-db.spec.ts`; E Server/Agent response selectors/DTOs, AppModule/OpenAPI |
| T11 status sender | N `G/app/status_reporter.py`, `G/tests/unit/test_status_reporter.py`, `G/tests/integration/test_status_reporting.py`; E management_client/config/main/pipeline/observability/conftest from T8/T9 |
| T12 deployment | N `M/Dockerfile`, `.dockerignore`, `test/unit/deployment.spec.ts`, `docs/deployment/management-backend.md`; E root `deploy/compose/compose.yaml`, `.env.example`, `.gitignore`, `G/tests/integration/test_deployment_config.py`, both package test scripts; `M/test/compose.yaml` isolated full-stack extension |
| T13 acceptance/handoff | N `M/test/support/{stack-harness,evidence}.ts`, `M/test/e2e/{management-flow,security-evidence}.spec.ts`, `docs/deployment/management-backend-acceptance.md`, `docs/contracts/{agent-provisioning,grafana-management-api}.md`; E `M/README.md`, root README, Gateway runbook, `G/tests/e2e/test_remote_write.py`, its existing `tests/unit/test_e2e_contract.py`, test/support/scripts for scoped fixtures |

`src/common` không trở thành generic framework; DB ops scripts chỉ CLI, không provider/controller. Seed native-TS script không decorators và import generated/built JS sau build, không thêm tsx hoặc generator mới chỉ để chạy seed. Test keys/private URL files chỉ trong unique ignored temporary directory, không thêm PEM/JWT/private material vào source fixtures. Không README/tests dưới infra.

## 3. Shared interfaces và command conventions

Các Interfaces bên dưới là hợp đồng chốt; task sở hữu định nghĩa chúng, task sau không tự rename hay thêm overload unauthenticated. DTO fields còn lại theo bảng18section spec. Timestamp wire RFC3339 UTC; DB now cho credential validity; injected Clock chỉ trong pure/test dependencies, không test clock environment runtime.

| Owner | Hợp đồng cho consumer |
|---|---|
| T1 | `ManagementConfig` typed readonly chứa đúng config names spec§13; `loadConfig(env:NodeJS.ProcessEnv):ManagementConfig`; `readSecretFile(path:string):string` sanitized errors; `Clock {nowMs():number;monotonicMs():number}`; `createManagementApp(config:ManagementConfig):Promise<INestApplication>` không listen; main mới listen. `ApiError(code:ApiCode)` finite status/message map; `SafeLogger.event(event,allowlistedFields):void`; `parsePage(query:PageQuery):PageSpec` limit20/max100. Test helper `countLeaks(text:string,values:readonly string[]):number` returns counts only, never echoes values |
| T2 | `Tx=Prisma.TransactionClient`; `DatabaseService.transaction<T>(work:(tx:Tx)=>Promise<T>):Promise<T>`, `.now(tx:Tx):Promise<Date>`, `.ready():Promise<boolean>`; `lockServer(tx,id)`, `lockAgent(tx,serverId,id)` consistent Server→Agent→Credential order; `AuditService.append(tx:Tx,event:AuditEvent):Promise<void>`. AuditEvent actor snapshot,operation,target,outcome,request_id,allowlisted delta, never raw body |
| T3 | `UserPrincipal={kind:'user',issuer,subject,context,role:'Viewer'|'Operator'|'Admin',display?}`; `ServicePrincipal={kind:'service',issuer,subject,scopes:readonly string[]}`; freeze snapshots/no raw token. `VerifiedAssertion={principal:UserPrincipal|ServicePrincipal,issuer:string,jti:string,expiresAt:Date}`; `RequestBinding={method:string,target:string,rawBody:Uint8Array}`; `AssertionVerifier.verify(token:string,binding:RequestBinding):Promise<VerifiedAssertion>` crypto/binding only. `NonceService.reserve(issuer:string,jti:string,expiresAt:Date):Promise<void>`; guard checks policy, reserves from verified envelope, then attaches principal only. `CredentialScope='metrics:write'|'provisioning:read'|'config:report'`, `AgentPrincipal={kind:'agent',credential_id,server_id,agent_id,scopes:readonly CredentialScope[]}`; `AgentAuthenticatorPort.authenticate(apiKey:string,scope:CredentialScope):Promise<AgentPrincipal>` via token AGENT_AUTHENTICATOR, unregistered→503/default deny. `@UserRoles(...)`, `@ServiceScope(...)`, `@AgentScope(...)`, `@PublicHealth()` mutually exclusive; `@CurrentUser():UserPrincipal` |
| T4 | `ServersService.create(input,actor,requestId):Promise<ServerDto>`, `.archive(id,actor,requestId):Promise<void>`; `AgentsService.register(serverId,input,actor,requestId):Promise<AgentDto>`, `.transition(id,action:'disable'|'enable'|'retire',actor,requestId):Promise<AgentDto>`; Groups typed CRUD/membership services. Controllers never raw Prisma entities |
| T5 | Consumes T3 CredentialScope/AgentPrincipal/AgentAuthenticatorPort. `Verification={active:false}|{active:true,credential_id,server_id,agent_id,scopes,expires_at,cache_ttl_ms}` (IDs UUID strings, expiry RFC3339, scopes readonly CredentialScope[], ttl integer ms). `CredentialsService.verify(apiKey:string,scope:CredentialScope):Promise<Verification>`, `.issue(agentId,input:IssueDto,actor,requestId):Promise<IssuedCredentialDto>`, `.rotate(id,input:RotateDto,actor,requestId):Promise<IssuedCredentialDto>`, `.revoke(id,actor,requestId):Promise<void>`; AgentKeyGuard implements/authenticates AGENT_AUTHENTICATOR, no raw key in principal |
| T6 | `ProfileConfigV1={schema_version:1,os:'linux'|'windows',interval_seconds:number,metric_groups:{cpu:boolean,memory:boolean,disk:boolean,network:boolean},options:ProfileOptions}`. `validateProfileConfig(value:unknown,os):ProfileConfigV1`, `canonicalProfile(config):string`, `profileChecksum(config):string`. ProfilesService `.publishVersion(versionId,actor,requestId):Promise<ProfileVersionDto>`, `.assign(serverId,versionId,actor,requestId):Promise<AssignmentDto>` |
| T7 | `ProvisioningService.get(principal:AgentPrincipal):Promise<ProvisioningDto>`, `.report(principal,input:ConfigReportDto,requestId):Promise<void>`; ProvisioningDto ids/os + profile{id,version_id,version,checksum,config} + ingestion{base_url,path,content_type,content_encoding,remote_write_version,authorization_scheme:'Bearer',identity_headers}. Never api_key |
| T8 | Python frozen `VerifiedCredential(credential_id:str, identity:Identity, scopes:frozenset[str], expires_at:datetime)` token-free; `CredentialConfig(base_url,timeout_seconds=2,ttl_seconds=30,max_entries=1024)` separate until T9. `ServiceSigner.sign(method:str,target:str,body:bytes)->str` EdDSA JWS. `SignedManagementClient.request(method,path,body:bytes=b'')->ManagementResponse(status_code:int,body:bytes)` response cap8192; owns no per-request new client. `CredentialProvider.verify(api_key:str)->VerifiedCredential` async, positive cache deadline separate/internal |
| T9 | Frozen `IngestHeaders(api_key:str=field(repr=False),server_id:str|None,agent_id:str|None)`; `parse_ingest_headers(raw_headers)->IngestHeaders`, Identity retains two trusted fields for existing validator. `IngestionPipeline(...,credential_provider:CredentialProvider)` and `.handle(stream:AsyncIterator[bytes],headers:IngestHeaders,*,received_at_ms:int)->PipelineResult`; owns one admission lease including auth. `create_app(settings=None,*,upstream_transport=None,ready_transport=None,management_transport=None,management_ready_transport=None)->FastAPI`; T11 adds reporter_transport keyword. Transports are test DI only, no env bypass |
| T10 | `EpochOpenDto={boot_id,boot_started_at,expected_epoch}`→`EpochDto={gateway_id,boot_id,epoch,activated_at}`; `StatusService.openEpoch(source:ServicePrincipal,input):Promise<EpochDto>`, `.acceptReport(source,input:ReportChunkDto):Promise<ReportAckDto>`, `.forAgent(agentId):Promise<StatusDto>`; `evaluateStatus(input:StatusInput):StatusDto` pure. Wire chunk fields defined spec§10 plus `chunk_index`, `chunk_count`, `snapshot_hash`, `chunk_hash`, records list; ack `{epoch:number,sequence:number,state:'staged'|'committed',accepted_chunk_indexes:readonly number[]}`, never raw payload; GET/POST epoch and report return200 explicitly |
| T11 | Python `StatusReporter.record_success(proof:VerifiedCredential,succeeded_at_ms:int)->None` synchronous/nonthrowing; `async start()->None`, `async close()->None`, async internal tick with injected clock. Pipeline constructor adds `status_reporter:StatusReporter` at this task; runtime always wired. Test-only Null sink not a deploy feature |

Epoch/snapshot protocol clarification: server-assigned epoch uses CAS expected_epoch and unique gateway/boot; capture boot_started_at at lifespan start, validate clock±5s. Coverage cannot start before server epoch activation; positive success between boot and handshake is still historical positive evidence. Logical digest = RFC8785 of `{epoch,sequence,snapshot_start,snapshot_end,gap,records sorted agent_id}`, excluding digest/chunk transport fields; chunk hash = SHA256 canonical record subset. Last committed duplicate never refreshes received_at. Sequence loss/expired staging resets coverage; normal pending chunks leave last committed coverage alone.

ProfileOptions concrete v1: `disk` optional `{exclude_filesystems?:string[],mount_points?:string[]}` on Linux, `{include_volumes?:string[]}` on Windows; `network?:{interfaces?:string[]}` on both. Arrays≤64, strings1–128/no controls, Linux mount_points absolute; unknown/other-OS fields reject. Seed options `{}`, metric groups all true, interval15; no Telegraf options guessed. Config report input `{profile_version_id,checksum,result:'applied'|'failed',agent_version?:string}`; persist last reported result/time and last applied version only on applied, no desired mutation. Receipt PK agent/version gates historical report.

**Commands** below are future execution, not commands run during planning. `[M]` means workdir M; `[G]` means G; `[R]` root. Create unit runner `pnpm test`; real isolated-DB runner `pnpm test:integration` (`vitest.config.integration.ts`, global setup PG harness), opted cross-service `pnpm test:e2e` (`INFRAPULSE_RUN_MANAGEMENT_E2E=1`, isolated stack). Existing `test/app.e2e-spec.ts` becomes in-process HTTP/DB integration, not a fake Grafana test. Unit collection never connects. `pnpm typecheck` = tsc noEmit; `pnpm build` = nest build, `start:prod` = node dist/main.js. `[G]` use `uv tool run --from uv==0.13.6 uv ...`, do not upgrade global uv0.12.13. Every pytest uses a new nonexistent basetemp under ignored plan workspace, never reuses/clears ledger/root or denied global Temp. T2 package scripts: db:generate=prisma generate, db:validate=prisma validate, db:bootstrap=node scripts/bootstrap-db.ts, db:migrate=node scripts/migrate-db.ts, db:seed=node scripts/seed-db.ts (after build). Bootstrap/seed/migration URL files never argv values.

Test harness modes are test-only: host mode owns unique test PG/stack lifecycle; Linux test runner uses `INFRAPULSE_TEST_DB_EXTERNAL=1`, `TEST_DB_RUN_ID` and private URL-file mounts for the **same parent-owned isolated DB**, validates exact test database/run_id, never starts Docker or mounts its socket. Integration test config no file parallelism for shared fixtures and timeout30s; E2E testTimeout150s/hookTimeout180s, harness startup180s/teardown60s, each flow total120s. Docker/DB unavailable is explicit prerequisite failure, not skip-to-PASS. Default unit tests never consult external DB mode. Child process tooling uses stdio inherit/ignore or guarded file descriptors, not secret-bearing pipe dumps; no sandbox escalation/global ACL repair.

**Test notation:** assertions trong mỗi code block thuộc các cases độc lập; fixture helpers named by behavior được định nghĩa tại test file/support của đúng task, không là APIs còn thiếu của task khác. Caller data/response/time setup phải hiện trong test để assertion có ý nghĩa; không fake boolean output thay actual operation. `Page<T>={items:readonly T[],next_cursor:string|null}` thuộc T1 pagination. Stubbed pure tests không thay DB/HTTP evidence.

**Checkpoint C:** targeted GREEN + all current unit/integration suites once per task; only opt-in suites with their prerequisites. Record counts/exits/current scope/not-run, full uncommitted snapshot diff and test logs with secrets excluded. Subagent-driven: independent spec+quality task reviewer gate before proceeding; Native: controller self-review per task, one independent whole-change review at end. Follow chosen execution skill, not duplicate both review loops. Expected bootstrap/package/network/config errors are NOT behavioral RED. No git add/commit/push. At final, whole-change reviewer sees all diffs/ledger and actual evidence, not just self-report. Planning self-review is inline, no reviewer dispatch required.

## Task 1: ESM metadata và bounded HTTP/config foundation

**Files:** T1 map; current AppController/Service behavior untouched until T3.
**Interfaces:** Produces T1 contracts for all tasks; consumes current ESM/NodeNext scaffold, no DB or real auth yet.

- [ ] **1. Bootstrap pinned tooling only:** snapshot scaffold/config and baseline versions; pin baseline framework/test versions above, add exact class-validator0.15.1/class-transformer0.5.1/jsonc-parser3.3.1 and dev SWC2.0.0/core1.16.21; packageManager pnpm11.24.0, frozen lock. No generate/scaffold/Observe/deploy. Do not make business implementation to conceal baseline runner failure.
- [ ] **2. Write metadata/config/IO assertions:** `test/unit/metadata.spec.ts` uses separate injectable Dependency/Consumer modules, runtime imports/no @Inject escape; config/pagination/error tests include private-key/URL sentinel and malformed JSON. Preserve existing tests.
```ts
expect(Reflect.getMetadata('design:paramtypes', Consumer)).toEqual([Dependency]);
expect(module.get(Consumer).dependency).toBe(module.get(Dependency));
expect(() => parsePage({limit:'101'})).toThrow(ApiError);
expect(() => loadConfig(badSecretFileEnv)).toThrow('Invalid management configuration.');
expect(countLeaks(capturedOutput,[secretSentinel])).toBe(0);
```
- [ ] **3. RED:** `[M] pnpm exec vitest run test/unit/metadata.spec.ts test/unit/config.spec.ts test/unit/http-boundary.spec.ts test/unit/pagination.spec.ts`. Expected assertion metadata undefined or missing planned module/behavior. Transform/package setup error must first be isolated as bootstrap, not counted as proof.
- [ ] **4. Implement named T1 APIs:** Vitest setup imports reflect-metadata before app modules; `swc.vite({module:{type:'es6'},jsc:{parser:{syntax:'typescript',decorators:true},transform:{legacyDecorator:true,decoratorMetadata:true}}})`. Preserve .js relative imports/type=module/NodeNext, not CJS. Config exact spec§13 names/bounds, no dotenv/global env dump. Global middleware rate20/burst40/handlers16 before parser, body5s/128KiB, release on finish/close; strict DTO with transform/whitelist/forbidNonWhitelisted and explicit primitive validators, no silent implicit conversion. `parseStrictJson(raw:Buffer):unknown` in http-boundary uses jsonc-parser visitor to reject duplicate decoded property names per object, disallow comments/trailing commas/errors, fatal UTF-8 decode; raw bytes retained unchanged for signature. Reject __proto__/constructor/prototype keys and reserved secret metadata fields; no raw error object. ApiCode map: invalid_request400/unauthorized401/forbidden403/not_found404/conflict409/payload_too_large413/rate_limited429/dependency_unavailable503/audit_unavailable503/internal_error500/provisioning_not_ready409/profile_not_provisioned409/secret_already_issued409. page20/max100, opaque validated created_at+UUID cursor and fixed created_at,id stable order, filter allowlist only. factory uses bodyParser:false and installs its own bounded raw-body/strict JSON middleware before DTO handling; rawBody bytes are never overwritten by JSON reserialization. main calls factory then listen, import does not start server. Health live minimal/noIO; ready will be503 until T2 dependency valid.
- [ ] **5. GREEN:** rerun Step3, `[M] pnpm test`, `pnpm typecheck`, `pnpm build`; require metadata/injection assertions and sanitized startup/HTTP errors, not merely compilation. Add ignore node_modules/dist/generated/coverage/test artifacts/private `/deploy/secrets/`, keep lockfiles.
- [ ] **6. Checkpoint C:** Foundation can be rejected independently of future DB/auth; report metadata/build output evidence and no runtime exposure.

## Task 2: Schema, least-privilege migrations, DB harness và atomic audit

**Files:** T2 map; package adds exact prisma/client/adapter7.10.1, pg8.23.1,@types/pg8.16.0. Bootstrap/seed scripts own explicit operator commands, not AppModule startup.
**Interfaces:** Consumes config/errors/logger; produces Tx/DatabaseService/locks/AuditService and all13 tables in spec§5 including provisioning receipts, nonce/source/epoch staging.

- [ ] **1. Bootstrap isolated test harness:** new unique Compose project with PostgreSQL18.6 and DB `infrapulse_test_<run_id>` (prod remains infrapulse), loopback dynamic test5432 or container-only driver, generated private secret files. Guard exact generated run_id/database/project labels before DDL/teardown; test PG tmpfs/no shared volumes. Fixed test-only name/label guard; never root.env/shared volume. Set up test runner before claiming RED; Windows host tests discover own dynamic port via allowlisted inspect, not assume5432.
- [ ] **2. Write DB/audit assertions before migrations/services:** catalog empty test DB, direct least-role checks, race transactions and rollback injection.
```ts
expect(await catalog.hasPartialActiveAgentIndex()).toBe(true);
expect(await runtime.canCreateTable()).toBe(false);
expect(await runtime.canUpdateOrDeleteAudit()).toBe(false);
expect(await runtime.canMutateMigrationHistory()).toBe(false);
await expect(mutationWithFailingAudit()).rejects.toMatchObject({code:'audit_unavailable'});
expect(await catalog.businessRowsAfterRollback()).toHaveLength(0);
```
- [ ] **3. RED:** `[M] pnpm exec vitest run --config vitest.config.integration.ts test/integration/database.spec.ts test/integration/audit-db.spec.ts`; empty catalog/constraints/helper behavior must fail, not Docker unavailable. Raw pg catalog tests can precede generated Prisma types.
- [ ] **4. Implement schema/migration/bootstrap/DB APIs:** provider `prisma-client`, output `../src/generated/prisma`, moduleFormat esm; datasource postgres/schemas management, each model @@schema. prisma.config.ts paths relative config, no dotenv; generate may omit datasource, migration wrapper requires MANAGEMENT_MIGRATION_DATABASE_URL_FILE before CLI. Owner URL must select `schema=management` for Prisma migration history as well as model schemas; runtime adapter schema management explicitly, never create _prisma_migrations in public. Generate initial SQL from empty schema in isolated dev context, add partial unique/checks/FK RESTRICT/indexes and explicit per-table grants (no blanket default DML granting audit/history). Runtime role NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOBYPASSRLS, no owner membership. Bootstrap uses fixed role names and parameterized secret values over PG wire, no CLI/SQL-source literals or PG parameter/error logs; check existing state, no password rotation implied. Owner only management schema, leave public/Grafana unchanged.
- [ ] **5. Implement bounded connection/transactions/audit:** `new PrismaPg(pool,{schema:'management',disposeExternalPool:true})`; `new Pool({connectionString,max:10,connectionTimeoutMillis:1000,statement_timeout:1000})`, sanitized error callbacks, Prisma transaction maxWait1000/timeout2000. One owner of pool closes once via Prisma disposal; no implicit migration/seed. Lock Server→Agent→Credential, primary DB now. Audit append in same business transaction, DTO select projections no raw entities. Scripts native TS without decorators; seed explicit/idempotent. `scripts/migrate-db.ts` requires migration secret path, invokes pinned local Prisma migrate deploy with stdio ignored (no native error/body dumping), returns fixed receipt/error/exit, never passwords in argv; test unexpected CLI stderr sentinel cannot reach wrapper logs. Bootstrap secret SQL parameters/logging disabled and sanitized as above. Do not claim PUBLIC default CONNECT restrictions beyond grants actually established.
- [ ] **6. GREEN:** `pnpm exec prisma generate`, `pnpm exec prisma validate`, `pnpm build`, targeted DB suite and `pnpm test:integration`/`pnpm test`. Apply same migration twice to test DB, prove no extra rows/loss, DB-level active unique/FKs and runtime privileges; app readiness DB+schema/config only. No shared migration execution.
- [ ] **7. Checkpoint C:** keep migration/grants receipts and source DB before/after; SQL constraint/grant errors cannot be dismissed as Prisma schema coverage.

## Task 3: Signed identity, durable replay, RBAC và OpenAPI boundary

**Files:** T3 map; add jose6.2.14,@nestjs/swagger12.0.5 exact. Repurpose existing AppController/Service to `/api/v1/me` principal presenter; update old Hello World assertions to explicit protected API behavior, do not delete tests wholesale.
**Interfaces:** Consumes T1 raw body/errors, T2 nonce Tx; produces T3 principal/guards/decorators and signed-client/key fixtures. CurrentUser only UserPrincipal; no local password flow.

- [ ] **1. Write assertions and guards tests:** valid EdDSA fixtures generated in memory, raw query/body tampering, wrong alg/kid/issuer/audience/context, role mapping, cross-principal misuse, nonce uniqueness/restart/cap race. Define local TestAdminController at `/__test__/admin-only` inside auth-http.spec.ts TestingModule only (Server routes arrive T4); never register it in runtime AppModule. Fresh app/clock per case prevents rate-bucket carryover masking auth assertions, no runtime rate-limit disable flag.
```ts
expect((await api.as('Viewer').get('/api/v1/me')).status).toBe(200);
expect((await api.as('Viewer').post('/__test__/admin-only',{})).status).toBe(403);
expect((await replaySameAssertionAfterAppRestart()).status).toBe(401);
expect((await verifyBodyOrTargetMutated()).status).toBe(401);
expect(await reserveConcurrentlyAtCap(20000)).toEqual({live:20000,rejected:1});
```
- [ ] **2. RED:** `[M] pnpm exec vitest run test/unit/assertions.spec.ts test/unit/roles.spec.ts`; then integration replay/auth-http tests. Require failing route/policy/signature/replay assertions, no fixed private keys in fixtures.
- [ ] **3. Implement verifier/guards/policies:** standard claims iss/aud/sub/iat/nbf/exp/jti + kind/grafana_role/ctx/m/t/b as spec§7; subject stable opaque1–128, displays optional bounded. EdDSA-only trust maps, no token jku/HS fallback, TTL≤60/leeway5, exact raw target/body, data source single default context. Role/scope checked server-side before reserve. Nonce transaction unique+cap20000, expiry exp+5, bounded cleanup60s, restart safe/no live eviction; 401 replay,503 DB/cap. Own-role metadata defaults deny; User and Service cannot substitute Agent proof.
- [ ] **4. Wire protected API and schema:** no anonymous root Hello World, minimal health only public (annotate T1 HealthController); signed internal health will be T5. Use explicit controller prefixes api/v1, internal/v1 and health, not a global prefix that rewrites internal/probe paths. An @AgentScope route without AGENT_AUTHENTICATOR must503, never return true/defer unchecked. OpenAPI distinct schemes/DTO/errors, no persisted auth/real examples; docs opt-in loopback/authorized. DB failure no Admin bypass; Viewer cannot read drafts/credentials/audit. Bootstrap test factory overrides providers through Nest TestingModule only, no production bypass route/env.
- [ ] **5. GREEN:** targeted assertions/roles/replay/auth-http plus `pnpm test`, `pnpm test:integration`, typecheck/build. RF2 must actually restart test app while retaining test DB nonce rows, not recreate DB to hide replay.
- [ ] **6. Checkpoint C:** signed fixture is NOT a Grafana real-user integration; gate stable subject source for Bước6 remains explicit.

## Task 4: Server/group inventory và one-active Agent lifecycle

**Files:** T4 map.
**Interfaces:** Consumes DatabaseService/locks/AuditService/UserPrincipal/guards; produces Server/Agent/group services and read DTOs. Telemetry enrichment waits T10; lifecycle fields complete now.

- [ ] **1. Write inventory/race assertions:** DTO field/size/query limits, archive histories, one-active register/enable, no move Agent, OS/profile consistency, rollback audit.
```ts
const results=await Promise.all([registerSameServer(),registerSameServer()]);
expect(results.map(x=>x.status).sort()).toEqual([201,409]);
expect(await activeAgents(serverId)).toHaveLength(1);
await archive(serverId); expect(await activeAgents(serverId)).toHaveLength(0);
expect(await historicalAgentExists()).toBe(true);
expect((await changeAgentServer()).status).toBe(400);
```
- [ ] **2. RED:** `[M] pnpm exec vitest run --config vitest.config.integration.ts test/integration/inventory-db.spec.ts test/integration/agents-db.spec.ts` → missing/invariant failure.
- [ ] **3. Implement typed CRUD/services/controllers:** all spec§11 inventory routes and Admin-only GET `/api/v1/audit-logs`; add `AuditService.list(query:AuditQuery):Promise<Page<AuditDto>>`, cursor/time/actor/resource/action allowlist, select safe fields/no raw bodies; Viewer/Operator403. name1–128/environment1–64, metadata4KiB/depth4/reserved secret keys reject, cursor20/max100/filter allowlist, group membership unique/idempotent. Registration active server lock + partial index; disable/retire revoke all keys/audit, enable conditional never restores keys; retired terminal. Archive204 keeps references, OS change blocked while active/incompatible assignment. Inject failure demonstrates atomicity; handle unique races as409 not500. Secret selectors never exposed.
- [ ] **4. GREEN:** Step2 plus full current M unit/integration, typecheck/build; prove unchanged history and race loser409. Empty telemetry field not claimed Online.
- [ ] **5. Checkpoint C:** inventory/DB gate before credential issuance builds on lifecycle.

## Task 5: One-time credential lifecycle, own-Agent guard và internal verify

**Files:** T5 map; T3 internal/service guard already exists.
**Interfaces:** Consumes T3 AgentPrincipal/AgentAuthenticatorPort; produces T5 Verification and issue/rotate/revoke APIs. Uses DB primary now/transactions/locks and AuditService, not Gateway callback.

- [ ] **1. Write credential assertions:** compare fixed32byte verifier, malformed token, same-ID wrong-secret, TTL cutoff, lifecycle, one-time retry/lost response, rotate race, metadata projection.
```ts
expect(await sameIdWrongSecret()).toEqual({active:false});
expect((await verifyAtEffectiveDeadline()).active).toBe(false);
expect((await lostResponseRetrySameIssuanceId()).status).toBe(409);
expect(await keyCountForOneIssuanceId()).toBe(1);
expect(await oldKeyRetireDeltaSeconds()).toBe(300);
expect(countLeaks(await listsAuditAndDatabaseText(),[issuedKey])).toBe(0);
expect((await api.serviceHealth()).status).toBe(204);
```
- [ ] **2. RED:** `[M] pnpm exec vitest run test/unit/credentials.spec.ts`; real-DB credentials-db spec separately. Behaviour RED, not cryptographic package/bootstrap error.
- [ ] **3. Implement credential verifier/lifecycle:** randomUUID+randomBytes32/base64url43, hash decoded32bytes, timingSafeEqual fixed lengths; generic inactive proof for wrong/revoked/expired/lifecycle/scope. Scopes default metrics:write/provisioning:read/config:report, Admin subset only. New expiry nonnull30d/max365d DB time, effective cutoff min expiry/retire; floor ttl≤30000 from verification snapshot. Issue/rotate request UUID unique, child unique rotated_from same Agent; lock transaction prevents disable/archive issuing race, no extension/retrieval/replay secret. One-time response no-store; safe metadata selectors, atomic audit. Revoke idempotent and irreversible, enable cannot restore.
- [ ] **4. Wire routes:** Admin metadata/create/rotate/revoke; POST internal verify8KiB/strict union200 and GET internal credentials/health signed scope verify/no real key. AgentKeyGuard implements T3 AgentAuthenticatorPort and exports AGENT_AUTHENTICATOR; the global policy guard resolves only that trusted DI provider (ModuleRef strict:false), never returns true merely because @AgentScope exists. Missing provider→503, wrong proof→401/scope403. Direct primary DB proof derives IDs; service/user tokens do not pass. Pool/deadline errors503, no negative-existence reason leaks.
- [ ] **5. GREEN:** targeted unit+DB, M full current suites/typecheck/build; RF1 simulate commit then discarded response and retry, assert one DB credential/no secret reveal. No key/verifier/DB URL in errors/audit/PG/application logging.
- [ ] **6. Checkpoint C:** one-time semantics/fail-closed verified before Gateway learns cache.

## Task 6: Validated profile versions, exact assignment và idempotent seeds

**Files:** T6 map; add canonicalize5.1.0 exact.
**Interfaces:** Produces ProfileConfigV1/profileChecksum and ProfilesService; consumes Server locks/OS and audit. Seed extends T2 explicit script, no startup mutation.

- [ ] **1. Write canonical/OS/version tests:** independently hand-sorted literal + crypto hash, duplicate JSON keys/unsafe numbers, forbidden shell/URL/options, concurrent version/assignment and immutable published data.
```ts
expect(() => validateProfileConfig({...base,interval_seconds:4},'linux')).toThrow(ApiError);
expect(canonicalProfile(base)).toBe(manualCanonicalJson);
expect(profileChecksum(base)).toBe(sha256(manualCanonicalJson));
expect((await editPublishedVersion()).status).toBe(409);
expect((await assignWindowsToLinux()).status).toBe(409);
expect(await seedTwice()).toEqual({linuxVersions:1,windowsVersions:1});
```
- [ ] **2. RED:** `[M] pnpm exec vitest run test/unit/profile-config.spec.ts`; profiles-db integration must fail unsupported/missing behavior, not fixture setup.
- [ ] **3. Implement profile config/version APIs:** exact schema/options above, cap64KiB, interval5–300/default15/all metric groups true seeds/options{}, RFC8785/duplicate key/nonfinite/unsafe number rejection. Draft edit→publish immutable; SQL unique per-profile version, no stale race; retirement blocks new assignment but current pinned config still works. Own route list/detail filters prevent Viewer draft disclosure. Assignment lock/OS validation, rollback to exact old published version, no latest follow; FK/no deletion history.
- [ ] **4. GREEN:** canonical vectors + profile DB unit/full suites/typecheck/build; seed twice must not overwrite published checksum, drift fails fixed error. No Telegraf renderer/script or extra plugin guessing.
- [ ] **5. Checkpoint C:** configuration data gate independent of provisioning transport.

## Task 7: Own-Agent provisioning và reported-config receipts

**Files:** T7 map.
**Interfaces:** Consumes AgentPrincipal/CredentialsService scope guard/ProfileConfigV1; produces ProvisioningDto/ConfigReportDto and own get/report methods from §3.

- [ ] **1. Write scoped/config-state assertions:** key for A cannot fetch B, GET alone no applied/status, historical receipt acceptance not arbitrary published version, no secret response, correct trusted URL.
```ts
expect((await provisioningWithServerOverride()).status).toBe(400);
expect((await provisioningWithoutAssignment()).status).toBe(409);
expect((await getOwnProvisioning()).body).not.toHaveProperty('api_key');
expect(await appliedVersionAfterGet()).toBeNull();
expect((await reportNeverProvisionedVersion()).status).toBe(409);
expect(await lastMetricAfterConfigReport()).toBeNull();
```
- [ ] **2. RED:** `[M] pnpm exec vitest run --config vitest.config.integration.ts test/integration/provisioning-db.spec.ts` → expected missing guard/receipt/response assertions.
- [ ] **3. Implement own GET/report:** derive IDs/OS only key proof, no query pick-resource; GET upserts receipt for immutable version/checksum then returns no-store config/requirements, not secret; configured ingest base origin only (no userinfo/query/fragment/Host derivation), default lab127.0.0.1:8000 is host-sender only. Report needs config:report, receipt+OS/checksum, records agent-reported result/version/time; applied only advances on applied result, failure retains previous applied and desired never changed. No last_metric_seen_at update, renderer or installer.
- [ ] **4. GREEN:** Step2 + full current M suites/typecheck/build; verify revoked/disabled/archive deny config even if Gateway warm cache could still ingest under30s contract. Assignment rollback/drift stays visible.
- [ ] **5. Checkpoint C:** emit OpenAPI DTO examples with nonsecret placeholders; installer handoff requirement ready, not actual VM installation.

## Task 8: Gateway service signer, bounded RPC và positive credential cache

**Files:** T8 map; isolated classes, do not make global Settings required yet.
**Interfaces:** Produces exact T8 contracts; consumes unchanged Identity and GatewayError (add new finite503 verification error here); no route/lifespan integration until T9. Low-level client reusable with separate pools later.

- [ ] **1. Bootstrap deps then write signer/cache tests:** `uv add 'PyJWT[crypto]==2.15.1' cryptography==50.0.2 rfc8785==0.1.4` using pinned uv wrapper; freeze lock, no global tool upgrade. Test signature/method/raw-target/raw-body, explicit Request isolation, stream cap/non200/cancel and fake monotonic TTL.
```python
assert await provider.verify(key) == proof
clock.advance_ms(29999); assert await provider.verify(key) == proof
assert calls == 1
clock.advance_ms(1)
with pytest.raises(GatewayError) as caught: await provider.verify(key)
assert (caught.value.status_code, caught.value.code) == (503, 'credential_verification_unavailable')
with pytest.raises(GatewayError) as wrong:
    await provider.verify(other_secret_same_public_id)
assert wrong.value.status_code == 401
assert cache_contains_plaintext(key) is False
```
- [ ] **2. RED:** `[G] uv tool run --from uv==0.13.6 uv run --frozen python -m pytest tests/unit/test_service_auth.py tests/unit/test_credentials.py -q --basetemp <NEW_TASK8_DIR>` → missing planned module/assertion failure. No test accepts a merely decodable unsigned token.
- [ ] **3. Implement signer/RPC:** Ed25519 private file strict type/no repr, iss/aud/sub/kid/jti/iat/nbf/exp/m/t/b per T3 contract; request byte serialization before signing. Explicit httpx.Request/send(stream=True,auth=None,follow_redirects=False), own pools externally, no merging client defaults/cookies/no proxy/no retries; total2s includes capped response≤8192 and close. Low-level client returns bounded status/body for protocol decisions (including reporter409); CredentialProvider maps every non200 to safe503 unavailable, never invalid-key401. Transport/oversize/malformed redirect exceptions safe503. Health probe expects204 via its separate signed client, no API key in probe.
- [ ] **4. Implement cache:** HMAC-SHA256 whole token with per-process random cache key; token-free VerifiedCredential, LRU1024/max10000; deadline t0 before network + min(serverTTL,30000), short key/rotate cutoff honored. No sliding/negative/error/stale cache. Validate strict JSON/duplicates/schema/UUIDs/scopes/UTC dates; ttl exact int1–30000 (not bool/string/NaN), inactive response only active:false. Untrusted response bytes/private fields repr=False, never exception details. Response arriving past deadline503, revoked proof401. Concurrent cold misses are bounded by caller admission, not an unbounded singleflight table. Caller cancellation propagates/no leaked response.
- [ ] **5. GREEN:** targeted + full current G unit/integration with **unchanged** app fixture until T9; frozen lock/check, Python import/Ed25519 test. Add slow-call test advancing1900ms during RPC: default proof has at most28100ms left, never30000ms from arrival; a proof with ttl1000ms arriving1900ms later is discarded503 even though call stayed inside2s deadline; one expiry entry eviction does not evict valid proof into stale fallback.
- [ ] **6. Checkpoint C:** local crypto/cache tests not proof of Node/Python HTTP interoperability; T13 is that gate. Actual signed public vectors may be generated at test runtime, no private fixtures committed.

## Task 9: Authenticate under the existing admission lease, integrate readiness/logging

**Files:** T9 map plus G/errors from T8; no codec/proto/validation/forwarder rewrite.
**Interfaces:** Consumes CredentialProvider/VerifiedCredential/T8 RPC; produces IngestHeaders/new handle/factory signatures §3. No `handle_unverified` or overload accepting trusted Identity from a request.

- [ ] **1. Write auth+lease assertions and legitimate fixture changes:** make ephemeral signer file/config and strict active proof UUID fixtures for app tests; retain old pure Identity cases. Missing ID headers now valid, duplicate/malformed still fail; replace hardcoded srv-lab app expectations with proof IDs, not remove assertions. Direct pipeline tests pass parsed headers and go through provider.
```python
assert (await post_missing_claims(valid_key)).status_code == 204
assert forwarded_labels() == trusted_ids
assert (await post_conflicting_claim(valid_key)).status_code == 403
assert forward_calls_after_bad_key() == 0
await block_auth_lookup(); assert inflight_slots() == 1
assert (await third_request_when_two_slots_busy()).status_code == 429
await cancel_auth_request(); assert inflight_slots() == 0
assert (await post_arbitrary_old_lab_bearer()).status_code == 401
```
- [ ] **2. RED:** targeted authenticated-ingestion + existing health/ingestion/identity tests, unique basetemp; expect old self-declared behavior/assertion or missing auth wiring. Package/fixture missing secrets is prerequisite error, not RED.
- [ ] **3. Implement header→lease→proof flow:** parser returns token repr=False + optional claims, preserves raw duplicates/protocol/ContentLength guards; required runtime Settings management URL/gateway ID/kid/signing file and TTL caps, no dotenv. Pipeline owns one acquire before auth, checks claims then passes proof.identity only to unchanged single codec worker. Cancellation during auth/read/worker/forward follows existing hold-until-join invariant; provider never in worker and no body read until auth. Failure no forward, finally release once. GatewayError identity_mismatch403/error enums/log statuses updated, no token/exception in logs.
- [ ] **4. Wire lifespan pools and readiness:** separate forward/PromReady/credential/credentialReady clients, signer once, no per-request clients. Existing initialized/cleanup intact; signed credentials/health + Prom readiness both bounded by ready total deadline1s, live200 noIO. Runtime never chooses anonymous fallback; cold bad config fixed startup error, `identity_unverified` removed only after actual provider wiring, lab_only kept. Existing logging lifecycle tests updated to new truth.
- [ ] **5. GREEN:** new and existing full G suites (unit+integration), metadata tests plus direct/repeated Task.cancel during real codec worker retained; assert blocked auth cannot starve separate readiness pool. Deployment-contract static files unchanged here; T12 will extend expectations when YAML actually changes. No real old-stack E2E with fake lab tokens claimed pass.
- [ ] **6. Checkpoint C:** auth boundary independently reviewable before reporter, no new bypass to make old tests green.

## Task 10: NestJS observation protocol và conservative telemetry projection

**Files:** T10 map; schema/DB grants already T2, add migration only if explicit reviewed schema correction, not db push. StatusService exported to Server/Agent read projections here.
**Interfaces:** Consumes ServicePrincipal scope status:write/DB clock/epoch fields; produces T10 contracts and status-enriched inventory without changing lifecycle.

- [ ] **1. Write pure boundaries and real DB protocol tests:**90/300 exact, never-seen/inactive, missing lookback, gap/restart, old CAS, multi-chunk atomicity, duplicate idempotency/tamper and stale source.
```ts
expect(evaluateStatus(inputAtAge(90000))).toMatchObject({status:'Online'});
expect(evaluateStatus(inputAtAge(300000))).toMatchObject({status:'Stale'});
expect(evaluateStatus(inputAtAge(300001))).toMatchObject({status:'Offline'});
expect(evaluateStatus(inputWithGap())).toMatchObject({status:'Unknown'});
expect((await staleEpochRegistration()).status).toBe(409);
expect(await heartbeatAfterCommittedDuplicate()).toEqual(originalHeartbeat);
expect(await pendingHealthyFirstChunk()).toEqual(previousCompletedCoverage);
```
- [ ] **2. RED:** `[M] pnpm exec vitest run test/unit/status.spec.ts`; status-db integration exercises PostgreSQL CAS/staging/transactions, not mock-only.
- [ ] **3. Implement epoch/report contracts:** server-configured gateway source, expected_epoch CAS/unique boot, retired boot cannot reactivate, last sequence strictly advances or exact replay ack. Validate fixed source ownership, timestamp≤future5s, snapshot end≤30s old, record age≤10min/not before boot, matching DB Agent/Server/credential. Bound one pending sequence4chunks/1024Agents/256KiB/30s JSONB; per-chunk+manifest hash, duplicate-same idempotent/different409, normal pending not gap; missed/expired sequence resets coverage. Final transaction GREATEST timestamps + committed coverage/sequence; duplicate committed never refresh heartbeat. Historical disabled Agent proof can reflect auth cache lag but never restores permission or active replacement status.
- [ ] **4. Implement evaluator and reads:** status_as_of completed source snapshot, heartbeat freshness≤30s, continuous90/300lookback, never seen Unknown; positive recent evidence may Online after boot but negative conclusion needs coverage. Inactive/noactive/historical Agent distinctions, finite confidence reasons/source health; do not compute from sample time/client config report or offline=poweroff. Attach typed projections to Server/Agent DTOs and filters, profile/group queries unchanged.
- [ ] **5. GREEN:** pure+DB targeted, full M tests/typecheck/build; RF4 simulate late old report, wrong digest, partial expiry and app restart with staged DB row. Max payload/cap tests must not grow extra pending sequences.
- [ ] **6. Checkpoint C:** API exposes observation as_of/lag/Unknown honestly; no fixed 'Online' fixture placeholder remains.

## Task 11: Bounded Gateway reporter, post-success hook và shutdown

**Files:** T11 map.
**Interfaces:** Consumes VerifiedCredential/SignedManagementClient/Node T10 wire contract, adds required StatusReporter to pipeline; no Prom forwarder change. Config exact INGEST_STATUS_* names/defaults from spec.

- [ ] **1. Write reporter and pipeline-hook tests:** memory cap/overflow/drop, attempt/byte/chunk caps, races between snapshot ack and newer success, no incoming slot wait, timeout/start/stop/old-epoch recovery, clock gap.
```python
for i in range(1025): reporter.record_success(proof_for(i), now_ms)
assert reporter.pending_count <= 1024
assert reporter.coverage_gap is True
await fail_three_attempts(); assert reporter.next_snapshot_sequence > old_sequence
await ack_old_snapshot_after_new_success(); assert reporter.pending_latest == newer_success
assert (await ingest_with_reporter_unavailable()).status_code == 204
assert reporter.record_calls_after_prom_rejection == 0
```
- [ ] **2. RED:** `[G] ... python -m pytest tests/unit/test_status_reporter.py tests/integration/test_status_reporting.py -q --basetemp <NEW_TASK11_DIR>` using same pinned uv prefix as T8; expected missing reporter/hook assertions.
- [ ] **3. Implement nonblocking sink/task:** sync record_success only dict/latest update and finite event; after ForwardResult success2xx capture UTC success, record proof IDs before return. Reporter exceptions cannot rewrite successful204, no await/pool slot in ingest hook. One lifespan async task/client pool1,total2s/request, tick10s, max4chunks/256records64KiB, at most3attempts per snapshot with fresh assertion/copy bytes, age10min drops flagged. Ack only removes no-newer pending values. CAS epoch registration bounded/refetch3max per tick, boot UUID/start and gap on restart; keep source identity stable, no threads/unbounded queues.
- [ ] **4. Wire final lifecycle:** factory creates independent reporter client/start task even when control plane reporting unavailable; reporter errors affect confidence not cached ingestion or liveness. Shutdown drain≤2s then cancel/join task and close clients exactly once; pending lost on restart causes new epoch/Unknown. Separate finite telemetry event/result enums, no IDs/keys labels. No raw metric batch in report.
- [ ] **5. GREEN:** targeted+all current G unit/integration; barrier tests prove no lost newer update, no overlapping snapshot workers, repeated cancellation no leaked tasks/leases. Clock regression/skew resets coverage, does not replace timestamp with fake now. Node status DB tests still pass against finalized sender shape at T13.
- [ ] **6. Checkpoint C:** best-effort accepted explicitly; don't add Redis/durable spool to make recovery tests easier.

## Task 12: Reproducible images, secrets/roles runbook và Compose integration

**Files:** T12 map; amend existing G deployment contract expected safe mounts/management dependency/explicit env/new service list, not broad relaxations. Retain original receiver/storage/network/hardening/path assertions.
**Interfaces:** Consumes all runtime configs/health/migration/seed commands; produces build targets build/test/migrate/runtime and operator-run protected deployment contract, not automatic shared bootstrap authority.

- [ ] **1. Write repository/image assertions:** default runtime not tests/dev CLI, secret directory excluded, explicit env/mount allowlist and ports/network/grants operation boundaries.
```ts
expect(management.networks).toEqual(['monitoring','database']);
expect(ingest.networks).toEqual(['monitoring']);
expect(management.ports).toEqual(['127.0.0.1:${MANAGEMENT_HOST_PORT:-3001}:3000']);
expect(runtimeImageHasDevCliOrPrivateFixture()).toBe(false);
expect(runtimeReceivesMigrationOrPostgresBootstrapSecret()).toBe(false);
expect(existingVolumesAndReceiver()).toEqual(before);
```
- [ ] **2. RED:** `[M] pnpm exec vitest run test/unit/deployment.spec.ts`; G deployment-config targeted with new contract failing old YAML. Static parse requires no real.env/expanded secrets.
- [ ] **3. Implement packaging/config:** verified Node24.20 amd64 digest, build image pinned pnpm11.24 install/frozen, generate custom client then build (no live DB secret). Separate prod deps/runtime contains generated runtime assets but no test/compiler/Prisma CLI/private files; migration target has CLI+operations, only it mounts owner secret. nonroot UID10002; Gateway UID10001 retained; read-only/tmpfs/caps/security512m/pids128/log10m×3. Runtime starts node dist/main.js; smoke proves generated Prisma runtime assets present, not assume tsc copies every asset.
- [ ] **4. Implement Compose/template/runbook:** management monitoring+database/host3001, health Node built-in bounded fetch, migrate/seed one-off profile with owner secret; Gateway management_healthy startup dependency plus Prom, own signing secret only. Runtime app only runtime URL+public trust; no root.env injection or bootstrap secret. Compose secrets bind read-only create_host_path:false where bind used; verify actual UID-readable and Windows host ACL limitations, no auto fixing unrelated ACLs. Required real secrets kept operator-managed; template empty/paths not live values. Preserve original three service definitions/volumes. Document schema/roles/grant/bootstrap/backup/migrate/seed order and no insecure rollback fallback.
- [ ] **5. GREEN static/images/isolated runtime:** full M/G suites, pnpm/uv frozen checks, build four targets and run M/Linux tests plus G test image. `docker compose ... config --quiet` with isolated nonsecret test env; private expanded stdout never logged. Isolated runtime DB query/health and least-grant actual tests, canary secret file not in image. Extend Compose path regression for both build contexts and old binds; reject bad --project-directory anchor.
- [ ] **6. Optional shared stack gate:** before privileged roles/secret provisioning/migrate/new management+Gateway restart on current DB, require explicit operator approval/secret files/backup and record healthy baseline IDs/volumes. If not granted, don't touch shared stack; isolated full E2E still required T13 and shared rollout recorded NOTRUN. Never silently use current postgres superuser as runtime or read root.env to manufacture a password.
- [ ] **7. Checkpoint C:** static config is not native bind isolation; live Windows IPv4/IPv6 probes and mounts/UID/read-only evidence belong T13. No production/TLS/HA/load claim.

## Task 13: Real cross-service E2E, security evidence và handoff

**Files:** T13 map; update existing G real-E2E fixtures/helpers/contract tests to issue valid credentials, not retain lab-only arbitrary Bearer or remove tests.
**Interfaces:** Consumes full APIs/wire schemas; produces acceptance artifact and handoffs for Step4/6, actual MB-01–MB-17 verdicts. No new public test-signer service.

- [ ] **1. Write opt-in/real-flow/security assertions:** collection offline, guarded unique isolated project; test private pairs/role files generated into private ignored directory, runtime test issuer only explicit test stack. No root Docker socket mount or production issuer bypass. Node fixture signs Admin requests; real Python Gateway signs internal requests verified by NestJS, proving cross-language byte binding.
```ts
expect(await collectionWithoutOptIn()).toMatchObject({networkCalls:0,composeChanges:0});
expect(await flow.createRegisterIssueProvisionIngest()).toMatchObject({status:204,labels:trustedIds,value:42.25});
await flow.revoke(); await flow.waitPastCommitPlus30Seconds();
expect((await flow.newAuthDecisionWithRevokedKey()).status).toBe(401);
expect(await flow.observeRejectedRunAbsentForWhole30Seconds()).toBe(true);
expect(await scanEvidence(sentinels)).toMatchObject({complete:true,leak_count:0});
```
- [ ] **2. RED:** offline helper/opt-in tests first; `[M] INFRAPULSE_RUN_MANAGEMENT_E2E=1 pnpm test:e2e` only after isolated harness ready, use PowerShell `$env:...` syntax on Windows. Failing actual business/security assertion needed, not absent Docker/image/test secret. Sender helpers have unit tests retry/deadline/identical bytes; fixture signer no live private constants.
- [ ] **3. Implement guarded harness/flow:** unique labeled Compose test project, private generated env/keys/DB URL files; test DB migrations/roles/seeds then management/Gateway/Prometheus healthy. Do not reuse shared containers to induce outage. APIs create Server, register Agent, exact profile assignment, issue key, own provisioning; real RemoteWrite uses independent scalar hex fixture, unique run_id/value42.25/timestamp. Query real Prom with exact IDs/value and timestamp() (not instant evaluation time). Missing claims/labels derive, conflicting header403/payload400 have no forward and absence full30s. Status successful report updates correct Agent, no sample-clock spoof.
- [ ] **4. Verify revoke/outage/rotation:** record DB commit time, warm cache allowable initial window, new decisions aftercommit+30s401/no-forward; finite total120s flow deadline and bounded query polling, no sleeps used as only assertion. Fresh run_id each refusal, full30s absence. Invalid-key401 vs unavailable503; control-plane outage with valid/expired/cold caches, separate readiness/liveness, recovery coverage Unknown→reliable; stop only owned isolated services, not shared. Expiry/rotate long windows mostly deterministic clock tests, plus one finite real short-deadline path; no fake load qualification.
- [ ] **5. Collect actual security/platform evidence:** capture allowlisted Node/Python/PG/stdout/stderr/audit/error/HTTPX paths with runtime sentinels, including malformed JSON/profile/secret file and SQL/timeout faults. `scanEvidence(sentinels:readonly string[]):Promise<{complete:boolean,leak_count:number,locations:readonly string[]}>` scans bounded captured chunks with overlap for split sentinels; truncation→complete:false, no plaintext raw logs emitted. No exposing sentinel secret in assertion failure/log report; only location/count/redacted verdict. Check trust/signing/DB files scope and image contents, nonroot/read-only/caps/pids/memory/logs/ports/mounts; native host loopback success plus nonloopback IPv4 and IPv6 behavior actually probed without firewall edits. Preserve historical Step1/2 FAIL/PARTIAL; do not close them by new gateway-specific test.
- [ ] **6. GREEN — final verification:** rerun the T13 opt-in command `pnpm test:e2e` with runtime opt-in and require all actual flow/security assertions PASS; then native Windows M unit/typecheck/build/integration and G all default tests, Linux M test stage/G test stage and actual isolated E2E. Default runner paths do not trigger E2E unless opt-in. Use fresh pytest basetemps; record exact commands/versions/counts/exits, reason for any excluded host-only tests, all service/volume before/after and clean task-owned teardown by exact project labels. No unknown-path deletion/shared down-v. Cross-service E2E test code does not log key-bearing failed response bodies.
- [ ] **7. Write runbooks/contracts/acceptance:** OpenAPI/checksum/schema examples, desired vs Agent-reported config, issue-once/retry recovery, rotate300s/cache30s, actual auth failure mapping, status_as_of/confidence/lag/Unknown; signed method/target/body contract and runtime vector generator without checked-in private keys. Step4 owns installer/render/VM, Step6 owns real Grafana stable subject/adapter/React; do not call fixture E2E Grafana login. README navigation updated; document operation Gate T12 and rollback retaining DB/migrations/keys carefully.
- [ ] **8. Final review/Checkpoint C:** fresh whole-change review of all snapshots/spec/MB evidence/deferred issues; owner fixes + focused rereview per chosen execution skill. Final report actual pass/fail/not-run, limitations/security-sensitive rollout actions still pending; user reviews before any later staging/commit/push. Retain ignored evidence if no Git recovery record, no cleanup of only audit history.

## 4. Coverage, execution order và completion gate

Sequence `T1→T2→T3→T4→T5→T6→T7→T8→T9→T10→T11→T12→T13`. Crypto/cache T8 can be reviewed independently of app wiring T9; backend protocol T10 independently of async sender T11; profile T6 independently of scoped provisioning T7. No parallel implementers on shared package/AppModule/config. No task-by-task user check-in except actual destructive/security-sensitive/out-of-worktree action or unusable plan; no silent action beyond approved scope.

| Acceptance | Owner/evidence |
|---|---|
| MB-01 |T1 metadata/config/build, T2 generated ESM client, T12 actual Linux image |
| MB-02 |T2 real constraints/migrate-twice/least roles/audit grants; T12 operator gate |
| MB-03 |T4 CRUD/DTO/pagination/archive/OS/group invariant |
| MB-04 |T4 race/lifecycle +T5 revoke atomicity |
| MB-05 |T5 secret/expiry/rotation/retry, T13 real flow/sentinels |
| MB-06 |T3 signatures/binding/roles/restart/cap/replay, T13 interoperability |
| MB-07 |T8/T9 proof/cache/claims/injection/no-forward; T13 actual Nest+DB |
| MB-08 |T8 fake-clock TTL/slow call, T9 cancel/startup/readiness, T13 outage |
| MB-09 |T9 preserved G regression including real-worker cancellation |
| MB-10 |T6 canonical/schema/version/assignment/seeds |
| MB-11 |T7 own provisioning/receipt/reports/no-applied/Online |
| MB-12 |T10 protocol DB, T11 bounded/racy/shutdown sender, T13 real reporter |
| MB-13 |T10 pure boundaries/as_of/source gaps, T13 actual last-success |
| MB-14 |T12 config/images/roles/network, T13 live native isolation and preservation |
| MB-15 |T13 real API→Gateway→Prometheus/revoke+full absence window |
| MB-16 |T1 logging/error foundation,T3/T5 guards/secret projections,T13 actual sentinel captures |
| MB-17 |T7 DTO/T13 contracts+OpenAPI+runbooks, explicitly not real plugin/VM |

**Completion:** chỉ claim fully accepted khi mandatory MB gates PASS với actual evidence. Gate FAIL/PARTIAL/NOTRUN phải hiện rõ và không được gọi full acceptance/completion; optional shared rollout có thể NOTRUN đúng scope đã chốt. Không biến limitation thành PASS. Isolated runtime qualifies real cross-service integration nhưng không đồng nghĩa shared-stack rollout đã được cấp quyền/hoàn tất. Không production readiness claim; HTTP lab/TLS absence, real Grafana subject/adapter deferred, best-effort gaps và historical acceptance limits đều hiện trong handoff.

**Parent inline self-review before handoff:** đối chiếu spec18sections→tasks/MB table; kiểm tra Types/DTO/route/ownership cross-task (không undefined provider/method), raw-bytes/clock semantics,13 task RED/GREEN/checkpoint,5 Review Focus owning assertions; pin compatibility vs actual proof distinction, node16handler/DB10pool/caps, seed no mutation startup, no accidental CLI/Git/secret authorization. Plan không chép toàn bộ implementation; sửa mọi ambiguity ở đây trước khi xin người dùng review.
