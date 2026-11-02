# Bước 3 — NestJS Management Backend: thiết kế

- Ngày: 2026-10-31, Asia/Ho_Chi_Minh.
- Trạng thái: các phần thiết kế trong hội thoại đã được duyệt; **bản spec viết này chờ người dùng review**. Chưa có quyền implement, install, migrate, build, deploy hoặc commit chỉ vì tài liệu tồn tại.
- Baseline khảo sát: `869328ead1bdc8354b1454db66e3554cc2539bcf` (`main`), Bước 1–2 đã publish. Scaffold NestJS local xuất hiện trong lúc khảo sát; phải giữ nguyên công việc người dùng và mở rộng scaffold, không generate lại.
- Phạm vi tài liệu: kiến trúc, dữ liệu, hợp đồng, giới hạn và nghiệm thu. Implementation plan là tài liệu riêng, chỉ viết sau khi người dùng duyệt spec này; chưa phải bằng chứng phần mềm đã chạy.

## 1. Intent, phạm vi và thành công

InfraPulse cần control plane quản lý Server, Agent, API Key và Monitoring Profiles; thay Bearer/IDs tự khai báo của Gateway bằng credential do NestJS quản lý, nhưng giữ đường metrics **Telegraf → FastAPI Gateway → Prometheus → Grafana**. NestJS/PostgreSQL không nhận raw metrics. Người quản trị dùng tài khoản Grafana, không có bộ tài khoản/mật khẩu NestJS riêng và không có Admin Web riêng.

Kết quả thành công: qua API quản trị có xác thực, tạo Server → đăng ký Agent → cấp key một lần → gửi Remote Write → Gateway xác minh và gắn đúng IDs → Prometheus nhận đúng samples → revoke → request có quyết định xác thực mới sau cửa sổ cache bị từ chối, không forward. Có DB constraints, audit, provisioning contract cho Bước 4 và admin contract cho Bước 6.

Bao gồm: CRUD/archival Server và nhóm; Agent lifecycle/version; issue/verify/rotate/revoke/expire; profiles/versions/assignment; provisioning và config report API; trusted metric presence/status; RBAC; audit; Prisma migrations; Docker integration; unit/integration/real E2E.

Không bao gồm: Telegraf renderer/installer, collector chạy VM thật, Grafana custom plugin/Go adapter thật, AIOps, remediation, Telegram, SSO/OIDC mới, multi-organization/multi-tenant, HA/distributed limiter, Redis/Kafka, durable event queue, load qualification, production TLS/LAN rollout. Không bật NestJS Observe/cloud telemetry như một side effect của scaffold.

## 2. Hiện trạng đã khảo sát

| Khu vực | Bằng chứng và hệ quả |
|---|---|
| Định hướng | Đã đọc toàn bộ [INTRODUCT.md](<../../../INTRODUCT.md>), 1378 dòng; là định hướng, không phải toàn bộ đã hiện thực. |
| Git | Baseline HEAD nêu trên; khi bắt đầu viết spec, chỉ thấy `services/management-backend/` untracked. Không stage/commit/push trong giai đoạn này. |
| NestJS | [package.json](<../../../services/management-backend/package.json>) là scaffold NestJS 12, ESM, pnpm, TypeScript 6, Vitest/Supertest; lock đã resolve NestJS 12.3.2. [main.ts](<../../../services/management-backend/src/main.ts>) listen `PORT ?? 3000`; AppModule/controller/service chỉ Hello World. Chưa có ORM/migrations/nghiệp vụ. Không tuyên bố đã build/test scaffold. |
| PostgreSQL | [Compose](<../../../deploy/compose/compose.yaml>): service `postgres`, network `database` internal, không publish5432. Read-only catalog: PostgreSQL18.6, database `infrapulse`, chỉ schema `public`, không có bảng user; chỉ bootstrap role `postgres` superuser. Không đọc password, không thay schema. |
| Grafana | Service `grafana`, host loopback3000, SQLite và volume riêng; không chuyển Grafana sang DB management. Dùng organization mặc định hiện có, không module organization. |
| Gateway | [identity.py](<../../../services/ingestion-gateway/app/identity.py>) chỉ kiểm tra hình thức Bearer và lấy IDs từ headers; **không có CredentialProvider đang dùng**. [main.py](<../../../services/ingestion-gateway/app/main.py>) log `identity_unverified`/`lab_only`. Auth/cache/reporter là phần mới, không phải thay một provider đã hiện thực. |
| Metrics | [pipeline.py](<../../../services/ingestion-gateway/app/pipeline.py>) có admission, streaming cap, một offload decode/validate/encode và cancellation-safe lease. [validation.py](<../../../services/ingestion-gateway/app/validation.py>) inject/check IDs; [forwarder.py](<../../../services/ingestion-gateway/app/forwarder.py>) one attempt. Giữ các đặc tính này. |
| Runtime | Lần khảo sát status chỉ đọc: `grafana`, `ingest`, `postgres`, `prometheus` healthy. Đây không phải nghiệm thu Bước3. Bước1 có PARTIAL/FAIL lịch sử phải giữ nguyên. |
| Secrets/config | [.env.example](<../../../.env.example>) có password để trống; root `.env` là private input của Compose, không đọc/in tài liệu. Gateway dùng `INGEST_*`, không tự load dotenv. `.gitignore` hiện chưa bỏ qua node_modules của scaffold mới. |

Code Graph project `C-MF-VSCODE-InfraPulse` ready; deploy bị loại khỏi index và các candidate báo metadata_changed. Đã dùng current source/config và catalog read-only để đối chiếu; không dựa graph absence để kết luận không có file. Không khảo sát `node_modules` như source ứng dụng.

## 3. Các lựa chọn đã chốt

- Một NestJS modular monolith + **Prisma**, thay vì TypeORM hoặc thêm microservices. Prisma phù hợp schema/transaction/migration tập trung; partial indexes và grants đặc thù dùng SQL migration rõ ràng.
- Grafana đăng nhập; NestJS kiểm tra signed identity và RBAC. Không tin browser user/role headers. Một organization mặc định, không phân chia inventory theo organization.
- Gateway xác minh qua NestJS và cache positive tối đa30giây, thay vì hỏi mỗi request hoặc push credential snapshots/background sync. Chấp nhận revoke có trễ hữu hạn; không kéo dài TTL khi outage.
- Một Agent `active`/Server, nhiều credential có thể phục vụ rotation. Agent lifecycle khác telemetry status.
- Online90giây, Stale90–300, Offline>300 khi observation đáng tin cậy, Unknown khi thiếu bằng chứng. Metric success là nguồn, không phải Agent tự nói Online.
- API Key ID+secret ngẫu nhiên256bit; chỉ hiện secret một lần, DB lưu verifier. Rotate overlap mặc định300giây.
- Profile JSON validate, immutable published versions, assignment cụ thể; Bước4 mới render/cài Telegraf.
- Reporter best-effort khoảng10giây, bounded, không đồng bộ DB trong metrics request và không thêm durable queue.

Các tham số chi tiết dưới đây là cách cụ thể hóa các quyết định trên để implementer không tự chọn ngầm; cũng thuộc phạm vi review bản spec này.

## 4. Topology và ranh giới module

```text
Grafana React plugin (Bước6)
  → Grafana plugin backend/adapter (Bước6, signed user assertion)
  → management:3000 /api/v1/* → PostgreSQL management schema

Telegraf → ingest:8000 → prometheus:9090 → Grafana
               ↘ /internal/v1/* → management:3000
                 (credential verify + bounded status reports, không raw metrics)
```

| Module | Public boundary / trách nhiệm | Phụ thuộc |
|---|---|---|
| Config/Database/Health | Validate config, Prisma lifecycle, DB health; không chạy DDL lúc request/start app | Secrets files, PostgreSQL |
| Auth/Authorization | Signed principal, request binding, durable replay guard, roles/scopes, CurrentUser | Config, nonce repository |
| Servers/Groups | Inventory, metadata, archive, membership | Database, Audit |
| Agents | Registration, lifecycle, version/config reports, one-active invariant | Servers, Database, Audit |
| Credentials | One-time issuance, verifier, validity/rotation, internal verification | Agents/Servers, Database, Audit |
| Profiles | OS-specific JSON schema, immutable versions, assignments | Servers, Database, Audit |
| Provisioning | Derive own Agent/Server from key, return desired config without secret | Credentials, Profiles |
| Status | Gateway epochs/reports, last success, observation confidence, derived status | Database, service auth |
| Audit | Allowlisted append-only event, actor/target/result/request ID | Same business transaction |

Không module nào truy cập bảng của module khác bằng controller SQL tùy ý: orchestration qua service/repository boundary; transaction context được truyền rõ cho các thao tác cần atomicity. Không generic repository framework hoặc event bus mới.

## 5. PostgreSQL và Prisma

### 5.1 Namespace, roles và migration

Dùng **schema mới `management` trong DB `infrapulse`**. Không sửa/reset `public`, không tạo lại volume và không dùng DB Grafana. Tách role migration owner và role runtime. Runtime có USAGE + DML cần thiết, không CREATE/ALTER/DROP/TRUNCATE; riêng audit chỉ SELECT/INSERT. Secret của hai role tách biệt, không dùng bootstrap superuser cho NestJS.

Bootstrap roles/schema là operation riêng có kiểm tra trạng thái và cấp secret ngoài Git, không nhúng password vào SQL source/CLI/logs. Migration owner không là PostgreSQL superuser. Grant mặc định cho bảng mới phải được kiểm chứng; runtime không tự nhận quyền owner hoặc DML lên migration-history table (chỉ SELECT tối thiểu nếu readiness cần). Chỉ migration container/command được cấp migration secret. Seed profiles/Gateway source registry là operation idempotent rõ ràng, không duplicate/ghi đè version published ở mỗi startup; gateway_id phải khớp trust map đã cấu hình.

Production/lab deploy dùng migration đã review và `prisma migrate deploy`; dev migration generation chỉ trên DB dev/test tách biệt. Không `db push`, reset, automatic schema synchronization hoặc down-volume. Partial unique/check constraints/grants có SQL migration và integration tests thật; không giả định Prisma schema biểu diễn đầy đủ mọi constraint.

### 5.2 Kiểu dữ liệu chung

UUID do backend tạo cho Server/Agent/credential/profile/version/group; không dựa hostname/IP. Thời gian `timestamptz` UTC; DB clock là authority cho expiry/retirement và thời điểm commit. API trả RFC3339 UTC. Các cột FK/index có tên rõ; text enum/check thay đổi qua migration. `created_at`, `updated_at` trên entity mutable; published versions không update nội dung.

| Bảng | Các cột/quan hệ chủ yếu |
|---|---|
| `servers` | `id`, `name`, `os` linux/windows, `environment`, `metadata` JSONB, created/updated, `archived_at` |
| `server_groups` | `id`, `name`, `slug` unique, created/updated |
| `server_group_members` | PK `(server_id, group_id)`, FK restrict; không duplicate membership |
| `agents` | `id`, immutable `server_id`, `os_at_registration`, agent_type telegraf, version nullable + nguồn/thời điểm báo, lifecycle active/disabled/retired, registered/retired time, `last_metric_seen_at` nullable, reported applied-profile-version/time nullable |
| `api_credentials` | `id` public key ID, `agent_id`, public prefix, `secret_hash`32bytes, allowlisted scopes, non-null `expires_at`, `revoked_at`, `retire_at`, `rotated_from_id` nullable unique, issuance request UUID unique, actor/created time |
| `monitoring_profiles` | `id`, slug unique (`linux-base`, `windows-base`), name/description, immutable OS, `retired_at` nullable |
| `profile_versions` | `id`, `profile_id`, positive version, validated JSON, checksum, draft/published, created_by/time, published_at; unique `(profile_id, version)` |
| `server_profiles` | PK server_id; desired published version FK, assigned_by/time. Một assignment/Server; profile suy ra từ version FK, không lặp field có thể mâu thuẫn |
| `agent_provisioning_receipts` | PK `(agent_id, profile_version_id)`, checksum, first/last provisioned time; ghi version thật đã cấp cho đúng Agent để validate config report lịch sử, không đánh dấu applied |
| `audit_logs` | event UUID/time, actor_kind/issuer/subject/display snapshot, operation, resource type/ID, outcome, request ID, allowlisted delta; không request body/raw secret |
| `request_nonces` | PK `(issuer, jti)`, expires_at + index expiry; bảng kỹ thuật cho nonce chống replay qua restart |
| `gateway_sources` | configured gateway_id PK, current monotonic epoch counter; registry kỹ thuật cho reporter, không API CRUD công khai |
| `gateway_epochs` | gateway_id/epoch PK, unique `(gateway_id, boot_id)`, active/retired time, last committed sequence/hash, heartbeat/coverage state; một pending sequence có chunk-hash map/payload JSONB bounded256KiB và deadline. Epoch cũ không ghi đè epoch mới |

Ba bảng cuối là dữ liệu kỹ thuật phục vụ signed requests và observation đã duyệt, không thêm tổ chức/người dùng/business subsystem. Không tạo bảng users/passwords. Audit subject không FK tới một local account giả.

### 5.3 Constraints, indices và giao dịch

- Partial UNIQUE `agents(server_id) WHERE lifecycle='active'`; registration/enable và archive khóa Server rồi Agent theo cùng thứ tự. Hai registration đồng thời: một thành công, một409, không hai Agent active.
- Agent không được chuyển Server. `active` là quyền hoạt động, không phải Online. active→disabled hoặc active/disabled→retired revoke toàn bộ key trong cùng transaction; retired terminal. disabled→active chỉ nếu Server chưa archive và không Agent active khác, không phục hồi key đã revoke.
- DELETE Server = archive + disable Agent active + revoke mọi credential còn hiệu lực + audit atomic. Không hard-delete/cascade lịch sử; lặp archive không cấp lại quyền. Restore/archive undo không thuộc Bước3.
- FK history dùng RESTRICT/NO ACTION. Membership/desired-assignment có thể xóa qua API riêng nhưng không xóa referenced Server/profile/version. OS change chỉ khi không Agent active và không assignment không tương thích; group/environment không lấy từ metrics labels làm authority.
- `last_metric_seen_at` cập nhật `GREATEST`, không lùi; là lịch sử Agent. Status Server dùng Agent active hiện tại, không lấy metric của Agent retired để làm Agent mới Online.
- Credential có FK Agent; Server luôn derive qua Agent, không lưu hai FK có thể gắn sai cặp. rotated_from phải cùng Agent và chỉ có một successor; khóa Agent/key khi issue/rotate/revoke/disable/archive để ngăn credential phát sinh sau revoke lifecycle.
- Published version bất biến; assignment kiểm tra Server/profile OS và published/nonretired trong transaction. Unique version/index FK là DB constraint; cross-table OS/lifecycle checks ở service transaction với row locks, không giả PostgreSQL CHECK tham chiếu bảng khác.
- Index: agents(server_id,lifecycle), credential(agent_id,created_at), credential expiry/retirement/revocation queries, servers(archived_at,created_at,id), filter environment/os, groups slug, version(profile_id,version), audit(created_at,id), audit(resource_type,resource_id,created_at), audit(actor_issuer,actor_subject,created_at), nonce expiry, epoch(gateway_id,epoch).
- Không tạo GIN cho mọi JSON field khi chưa có query được phép. Metadata object tối đa4KiB, depth4, key≤64/value string≤512; reserved credential fields (password/secret/token/api_key/authorization, không phân biệt hoa thường) bị từ chối. Metadata không là secret store.
- Mutation/audit thành công cùng transaction; audit failure rollback mutation. Invalid/denied attempts chỉ ghi security event allowlist; khi DB unavailable không giả đã ghi durable audit và không cho mutation thành công.

## 6. Credential lifecycle và one-time secret

Token chính xác `<canonical-lowercase-uuid>.<base64url-secret>`: secret32bytes từ CSPRNG, base64url không padding43ký tự, parser không chuẩn hóa/cắt secret. DB chỉ lưu SHA-256 trên32secret bytes; fixed-length constant-time comparison. Public prefix lấy từ key_id, không từ secret. Đây là high-entropy token verifier, không phải áp dụng SHA-256 cho mật khẩu người dùng ít entropy.

Issue trả201 gồm credential metadata + `api_key` **một lần**, header `Cache-Control: no-store`; client quản trị không persist secret trong browser storage/URL/telemetry. GET/list/rotate-history/audit/provisioning không trả plaintext/hash. Cờ secret đã hiện không cho phép retrieve lại. Secrets chỉ tồn tại tạm khi xử lý request; không hứa GC/zeroization vượt khả năng runtime.

Mặc định cấp các scopes `metrics:write`, `provisioning:read`, `config:report`; Admin có thể chọn subset không rỗng trong đúng allowlist này, không thêm admin/service scopes. Mỗi guard kiểm tra scope của chính endpoint. Mặc định expires30ngày, cho phép chọn deadline tương lai đến365ngày (giới hạn cấu hình server, không do Agent tự kéo dài). Test dùng clock điều khiển/deadline ngắn, không ngủ30ngày. Validity: scope đúng, Agent active, Server chưa archive, chưa revoke và DB now **nhỏ hơn** min(expires_at, retire_at nếu có). Equal deadline là hết hạn. Không dùng cron để quyết định active/expired.

Rotate tạo successor và trả secret mới một lần, đồng thời old.retire_at = min(deadline cũ nếu có, DB now+300giây). Old expiry sớm hơn vẫn được giữ, không kéo dài. Old status hiển thị rotating trong overlap; đến effective deadline tự mất hiệu lực. Revoked/expired/đã có successor không rotate lần nữa (409). Admin có thể revoke ngay cả trong overlap; revoked không un-revoke. Không vô hiệu toàn bộ Agent chỉ vì revoke một credential.

Issue/rotate yêu cầu client-generated `issuance_request_id` UUID. Lặp cùng operation ID sau commit trả409 với metadata an toàn, **không replay secret** và không cấp thêm key. Mất response sau commit: kiểm tra metadata, revoke credential không còn secret rồi issue mới bằng request ID mới. Không retry mù endpoint one-time issuance. Unique request ID + transaction kiểm chứng race; audit không lưu secret để phục hồi response.

## 7. Signed admin/service requests và RBAC

### 7.1 Admin trust boundary

Grafana đăng nhập, Bước6 plugin backend lấy identity từ server-side Grafana context/nguồn được Grafana xác nhận, **không từ React headers/body**. Adapter tạo một signed assertion cho mỗi HTTP request. NestJS AuthGuard xác minh rồi gắn principal immutable; RolesGuard enforce; `@CurrentUser()` chỉ đọc principal đã verify. Không login/password endpoint NestJS.

Ed25519/EdDSA algorithm allowlist duy nhất; không none/HS fallback, không tự tải `jku`/`x5u` từ token. `kid` chọn public key trong trust map cấu hình local; private key chỉ phía signer. Claims bắt buộc: issuer, audience, stable subject, iat/nbf/exp (exp-iat≤60giây), jti UUID, principal kind và role/context cần thiết. Leeway tối đa5giây cho assertion, **không cộng leeway vào API Key/cache expiry**.

Wire claims dùng tên JWT chuẩn `iss`, `aud`, `sub`, `iat`, `nbf`, `exp`, `jti`; header `alg=EdDSA`, `kid` allowlisted. Claims ứng dụng: `kind=user|service`; user có `grafana_role` (Viewer/Editor/Admin), `ctx` từ default source context và optional display snapshot. Request binding dùng `m` (method uppercase), `t` (exact raw path+query target), `b` (base64url không padding của SHA-256 raw body bytes; empty body cũng có digest). Receiver không reserialize JSON trước khi so digest; sender ký đúng bytes/target thực gửi. `@CurrentUser()` expose stable issuer/subject, context, mapped role và optional display; không raw assertion. Service scope lấy từ server trust map, claim tự khai báo không mở thêm quyền. Không tin forwarded user/URL/role headers, không cache admin identity30giây theo credential cache. Token/signature không echo hoặc log.

Admin issuer/audience riêng (`infrapulse-grafana-adapter` / `infrapulse-management-admin` là logical config defaults); source instance, public keys và một default organization/namespace context được allowlist cấu hình. Đây là metadata trust, **không thêm organization CRUD, tenant FK hoặc phân chia Server theo org**. Role snapshot trong assertion ngắn hạn; đổi role/logout không được hứa thu hồi tức thì một assertion đang còn hạn. Adapter mint per request, không đưa assertion cho React để tái sử dụng.

### 7.2 Stable subject và giới hạn Bước6

Không giả định username/email là ID bất biến. [Grafana plugin SDK User hiện được tham khảo](https://github.com/grafana/grafana-plugin-sdk-go/blob/main/backend/common.go) chỉ thể hiện Login/Name/Email/Role; không giả định `User.UID`/`User.ID` tồn tại. Bước6 phải xác minh cách lấy stable subject từ Grafana instance/API/identity source được xác thực, pin SDK tương thích và chứng minh rename không đổi audit identity; không tự suy ra từ browser hoặc mint ID theo username. Nếu không lấy được stable subject đáng tin cậy, adapter từ chối admin request, không fallback login-as-ID.

Bước3 định nghĩa/verify contract bằng signed adapter fixture và known opaque subject trong môi trường test. Test signing private key sinh trong memory hoặc file test private được ignore; không production bypass, không test issuer bật mặc định, không endpoint cấp Admin token công khai. **Chưa phải Grafana-login/real-plugin E2E**; adapter/React thật ngoài phạm vi cho đến Bước6.

### 7.3 Service trust và chống replay

Gateway có Ed25519 key riêng, issuer/audience internal riêng (`infrapulse-gateway` / `infrapulse-management-internal`), stable gateway_id và server-owned scope map `credentials:verify`, `status:write`. Không có user role/Admin; user assertion không được gọi internal API và service assertion không được gọi admin API. Same request binding/TTL/jti policy. Provisioning dùng Agent API Key guard riêng, không nhận user/service token thay Agent.

Sau cryptographic/binding/role/scope validation, reserve `(issuer,jti)` trong `request_nonces`; UNIQUE chống replay, kể cả NestJS restart. Replay trả401 generic. Nonce giữ đến exp+leeway, cleanup bounded; cap20000 live entries và admitted request rate có giới hạn. Cap/DB error trả503, không evict nonce chưa hết hạn hoặc bypass kiểm tra. Reservation/cap check có transaction serialization để race không vượt cap; không giữ lock trong remote IO. Mỗi lần retry vận chuyển phải ký assertion/jti mới; business idempotency vẫn tách riêng. Body/target mutation, wrong audience, service privilege escalation, stale/unknown kid đều có tests.

### 7.4 RBAC

| Principal | Quyền |
|---|---|
| Grafana Viewer → Viewer | Đọc inventory/status/groups và published profiles/assignments |
| Grafana Editor → Operator | Cùng quyền đọc trong Bước3; không thêm incident/action mutations ngoài phạm vi |
| Grafana org Admin → Admin | CRUD/archive inventory, Agent lifecycle, key/profile/assignment mutations; đọc credential metadata/audit |
| Gateway service | Chỉ internal credential verify và observation endpoints được cấp scope |
| Agent credential | Chỉ provisioning/config report của chính Agent, hoặc ingest ở Gateway theo scope |

Default-deny route không khai báo policy; public chỉ minimal health, không self-upgrade unknown role. Viewer/Operator không đọc draft version kể cả đoán đúng ID; service trả404 cho tài nguyên không được expose theo policy. Không lấy Grafana server-admin flag tùy ý thay org role đã xác minh. Một default org hiện có, không RBAC theo group/tenant ở Bước3.

## 8. Hợp đồng credential verify và thay đổi Gateway

### 8.1 Internal verification

`POST /internal/v1/credentials/verify`, service scope credentials:verify. JSON body duy nhất `api_key`, cap8KiB; không key trong URL/query/header forwarded sang Prometheus. NestJS đọc primary DB hiện tại, **không thêm positive validity cache riêng ở NestJS**.

| Kết quả | Response |
|---|---|
| Key đúng và tất cả checks hiệu lực | 200 `{active:true, credential_id, server_id, agent_id, scopes, expires_at, cache_ttl_ms}` |
| Unknown ID/sai secret/revoked/expired/Agent disabled-retired/Server archived/scope thiếu | 200 `{active:false}` chung; không ID/reason phân biệt tồn tại |
| Service assertion sai/không scope | 401/403 generic, không giả Agent key sai |
| DB/pool/deadline/overload | 503 generic |

`cache_ttl_ms` là floor của min(30000, effective_until - DB verification time), chỉ positive khi≥1ms; hết deadline active=false. `expires_at` là effective cutoff (expiry/rotation sớm nhất), luôn có giá trị. Không thêm đường xử lý credential legacy/no-expiry vì baseline chưa có credential DB. Response no-store, schema strict, max8KiB. Không trả verifier, secret, email hoặc actor.

### 8.2 Gateway cache và failure semantics

- Lifespan-owned CredentialProvider với HTTPX pool/deadline riêng: max_connections=max_inflight, total deadline2giây, no redirect/no HTTP retry/trust_env=False. Ready/reporter/forward clients tách biệt. Không print request/exception bodies.
- Positive LRU tối đa1024 fingerprints, configurable bounded; không giữ plaintext token/hash DB trong cache. Fingerprint HMAC-SHA256 **toàn bộ token** bằng random per-process key, restart mất cache. Cùng public ID nhưng secret khác không hit cache.
- Lấy monotonic t0 **trước** verification call; deadline=t0+min(server ttl,30000ms), không tính từ response arrival. Response đến sau deadline bị loại; không gia hạn khi cache hit. Như vậy slow network không kéo dài revoke window. Existing key expiry được trả thành ttl ngắn hơn; không phụ thuộc Gateway wall clock để kéo dài key.
- Không negative-cache credential ở giai đoạn này; admission giới hạn lookup abuse. Không cache lỗi/partial/malformed responses, không dùng stale-while-revalidate và không tự kéo dài TTL.
- Invalid proof active=false →401 invalid_authorization. Missing/expired cache + verification unavailable/malformed/timeout hoặc mọi HTTP non-200 (kể cả internal service401/403/429/3xx/5xx) →503 credential_verification_unavailable. Không giả 401 cho cấu hình service bị lỗi và không forward redirect.
- Valid cache dùng đến đúng deadline khi NestJS/DB lỗi; sau đó503. Restart rỗng phải verify. Không lab bypass/fallback, kể cả qua environment flag mặc định.
- Revoke/disable/archive có hiệu lực chậm nhất30giây với **quyết định xác thực request mới**, tính từ DB commit, nếu chỉ dùng nguồn primary và deadline trên. Không hứa hủy request đã được authenticate/inflight; không rollback samples cũ. Runtime acceptance phân biệt ranh giới này.

### 8.3 Integration boundary trong existing flow

Tách header syntax khỏi credential proof: parse duplicate/raw headers, protocol và declared length/caps trước; acquire existing admission **trước outbound credential lookup** để unknown-key flood không tạo queue/pool không giới hạn. Auth diễn ra trước đọc body/offload. Lease giữ xuyên suốt lookup→stream→codec→forward, release an toàn mọi nhánh/cancellation; không acquire hai lần khi gọi pipeline.

`X-Server-ID`/`X-Agent-ID` mỗi header là optional; nếu có phải một giá trị hợp lệ theo existing ID syntax. Không có thì derive từ proof. Nếu có và khác trusted mapping:403 identity_mismatch; malformed/duplicate claimed-ID header:400. Payload IDs thiếu được inject trusted values; conflict reject400 identity_conflict toàn batch như Bước2, không overwrite. Các non-ID labels vẫn là telemetry data, không tự trở thành nguồn quyền hoặc inventory metadata.

Giữ Snappy/protobuf subset, unknown-field rejection, integer timestamp checks/receive clock, float/stale-NaN bit preservation, count/output caps, no-queue admission, single limited worker/cancellation join, fixed status map, explicit Request/send và scoped persistent response hook. Chỉ token/identity proof đổi; không rewrite codec/forwarder hoặc đưa NestJS vào body processing.

Chỉ bỏ `identity_unverified` warning khi authenticated mode thật được wired; `lab_only` vẫn đúng. Mở rộng finite error/log/metric enums có tests, không label bằng API Key/raw IDs/exception. Existing tests đổi fixtures sang valid provider proof; không bỏ test cũ để che regression. Unit provider stubs không là runtime bypass.

## 9. Monitoring Profiles và provisioning

Seed idempotent `linux-base`/`windows-base` v1 published: CPU, memory, filesystem/disk và network phù hợp OS. JSON contract có schema_version, collection interval mặc định15giây (allow5–300), enabled metric groups và OS-specific allowlisted options. Không arbitrary shell/inputs.exec, template expressions, external destinations, script/download URL hoặc secrets. Cap mỗi version64KiB; unknown fields bị từ chối. Bước4 quyết định Telegraf plugin/options rendering tương thích version sau khi có kiểm thử VM, không giả Bước3 đã sinh TOML chạy thật.

Checksum SHA-256 trên RFC8785 canonical JSON UTF-8; reject duplicate keys, invalid Unicode, nonfinite/unsafe numbers; config schema chỉ dùng integer cho số lượng/interval. Dùng standard-compatible canonicalizer có test vectors, không tự tạo kiểu number formatting khác giữa Node/Python; cùng config tạo cùng checksum. Draft có thể sửa khi chưa published; publish đóng băng nội dung/checksum. Version number positive, unique per profile; concurrency cấp version bằng transaction. Assignment chỉ published/nonretired và OS khớp, pin exact version, không follow latest. Retire profile chặn assignment mới, không phá config đã gán; không delete version có references. Rollback là gán published version cũ tương thích, có audit.

`GET /api/v1/agent/provisioning`, API Key scope provisioning:read. NestJS verify trực tiếp bằng Credentials service/primary DB, không gọi vòng Gateway. Suy ra Agent/Server, bỏ qua mọi ý đồ chọn resource khác bằng query/header; query fields không được khai báo bị reject. Trả ids/os, desired profile/version/checksum/config, remote-write path/content requirements và **agent-facing ingest base URL từ trusted config**. Không API Key/hash, DB URL/password, internal service assertions hoặc Docker hostname mặc định cho VM.

Lab agent-facing URL mặc định `http://127.0.0.1:8000` chỉ cho sender trên host hiện tại. Đây không là URL VM dùng được; không suy URL từ Host/X-Forwarded headers, không nới binding LAN cho tiện. Agent lấy secret từ lần cấp ban đầu và bảo vệ riêng. Response no-store. Thiếu assignment trả409 provisioning_not_ready, không tự tạo profile/key. Disabled/archived/revoked không nhận config. Trước trả success, transaction upsert agent_provisioning_receipts cho đúng immutable version đã cấp; receipt chỉ chứng minh đã cấp config, không mark applied. Không cấp credential trong GET này.

`POST /api/v1/agent/config-reports`, Agent guard với scope config:report, body profile_version_id/checksum/reported version và kết quả enum applied/failed; IDs derive, version phải published/OS-compatible và đã được cấp/gán cho Agent đó. Không nhận raw config/stdout/secret. Lưu là **Agent-reported**, không chứng minh binary/config thực sự chạy và không cập nhật last_metric_seen_at/Online. Khác desired version vẫn được hiển thị drift nếu là version đã từng được provision hợp lệ; không tự đổi desired assignment. Cần lưu allowlisted provisioning receipt/version reference để phân biệt historical version hợp lệ, không dùng GET alone đánh dấu applied.

## 10. Trusted observation/status

### 10.1 Source và reporter

Ghi nhận chỉ sau batch đã auth+validate+encode và Prometheus trả success2xx theo ForwardResult. Dùng Gateway UTC receipt-of-success time, không sample timestamp hoặc Agent clock. Credential/Agent IDs từ trusted proof; không headers tự khai báo. Đây là positive acceptance evidence, không hứa Prometheus transaction/exactly-once hoặc miễn trừ timeout uncertainty.

Một bounded coalescer trong Gateway, max1024 pending distinct Agents; mỗi Agent giữ last success và proof metadata công khai cần thiết, không raw metrics/key. Flush mỗi10giây, một request single-flight, batch≤256records/64KiB, tối đa4chunks/logical snapshot≤256KiB; nếu nhiều chunk phải đánh dấu hoàn tất logical snapshot trước khi backend coi coverage complete. Client riêng pool1, timeout total2giây/request, không dùng forward/codec slots. Mỗi snapshot có tối đa3 lượt gửi ở các tick, cùng sequence/digest/chunk bytes nhưng assertion/jti mới. Sau3 lần thất bại hoặc staging deadline hết, tạo sequence mới từ pending mới nhất và đánh dấu gap; không replay vô hạn một snapshot cũ. Pending record quá10phút bị drop kèm gap. Reporter là async lifespan task, không thread/executor hoặc queue vô hạn. Chỉ xóa record acknowledged nếu chưa có update mới hơn; overflow/drop/clock discontinuity tạo coverage-gap flag, không âm thầm bỏ rồi claim complete.

Gửi heartbeat cả snapshot rỗng. Pending không durable; shutdown drain tối đa2giây rồi dừng/đánh dấu gap, restart không phục hồi từ cache hay fake old observations. Lỗi reporter không đổi204 ingest đã thành công thành500; auth/cache vẫn fail-closed theo mục8.

### 10.2 Epoch, thứ tự và completeness

Gateway instance có configured gateway_id, mỗi lifespan mới boot_id UUID. Trước báo cáo, service đăng ký epoch do NestJS cấp tăng dần: GET `/internal/v1/status/epoch` đọc current epoch; POST cùng path với boot_id/expected_epoch tạo hoặc lấy epoch của boot hiện tại. DB compare-and-swap counter, UNIQUE gateway/boot và row locks: stale registration không ghi đè epoch mới; boot đã retired không activate lại. Conflict refetch có giới hạn, không spin vô hạn. Một Gateway/worker là supported deployment; không chạy hai process dùng cùng source identity.

POST `/internal/v1/status/reports` body epoch, sequence, snapshot start/end, gap flag và records `{agent_id,server_id,credential_id,last_success_at}`. Scope status:write; old epoch bị từ chối409. Sequence positive tăng dần; chunk_index/count, logical snapshot SHA-256 và per-chunk hash là bắt buộc. Tối đa4chunks/1024Agents/256KiB; không duplicate Agent trong snapshot. Stage một pending sequence trong bounded JSONB fields của gateway_epochs, deadline30giây từ first chunk. Duplicate `(epoch,sequence,chunk_index)` cùng hash idempotent; khác hash hoặc đổi manifest409. Out-of-order chunks trong cùng snapshot được stage; pending bình thường chưa đổi last completed coverage/heartbeat. Chỉ incomplete khi hết deadline, detected loss/invalid data hoặc missing-sequence mới tạo gap; không coi chunk đầu của một snapshot khỏe là mất quan sát. Logical hash dùng RFC8785 trên envelope snapshot và danh sách records sort theo agent_id, loại các trường digest/chunk transport để tránh tự tham chiếu. Không ack complete trước finalization. Khi đủ manifest, validate toàn bộ rồi transaction cập nhật agent timestamps, committed sequence/hash và coverage, clear staging. Committed-sequence replay cùng digest chỉ ack, không ghi heartbeat mới hay làm coverage trẻ lại; khác digest409. Không expose partial snapshot là complete. Sequence mới có thể bỏ qua sequence thất bại nhưng phải reset coverage; pending cũ bị hủy có giới hạn, không tích lũy nhiều sequence. Đây là staging ngắn hạn của HTTP batch, không durable delivery queue.

Receiver giới hạn timestamp future skew5giây theo DB clock; snapshot end không quá30giây trước DB now, snapshot start/end và epoch consistent; observations không sau snapshot end hoặc trước epoch boot, không quá10phút tuổi. Agent/credential tồn tại và gắn đúng Server; record count/caps được validate. Skew lớn hơn5giây hoặc clock chạy lùi ở nguồn làm mất confidence, không tự gắn now thay observation. Old Agent vừa disabled/retired có thể được ghi nhận historical success do auth cache≤30giây, nhưng không khôi phục lifecycle/key hoặc làm Agent active mới Online. Clock skew/gap không được 'sửa' bằng fake current time. Store last report received_at và source coverage; không metrics samples/history mỗi request trong DB.

### 10.3 Classification và độ trễ

API trả lifecycle và telemetry status riêng, `last_metric_seen_at`, `status_as_of`, `source_health`, `confidence_reason`. Source heartbeat fresh khi≤30giây; cần coverage liên tục đủ lookback90/300giây cho Stale/Offline. Status dùng thời điểm observation snapshot đã hoàn tất (`status_as_of`), không giả snapshot là thời gian wall-clock hiện tại; delivery bình thường có độ trễ khoảng10giây cộng request time. Nếu snapshot stale>30giây hoặc gap làm thiếu lookback, Unknown thay vì kết luận Offline.

Với Agent active và nguồn đủ tin cậy: age tại status_as_of≤90giây Online; 90<age≤300 Stale; age>300 Offline. Chưa từng có success luôn Unknown. Positive success mới đủ chứng minh Online ngay sau boot; Stale/Offline chỉ trở lại khi coverage đủ sau restart/gap. Lifecycle disabled/retired không được biểu diễn thành Online; API trả telemetry Unknown với reason lifecycle_inactive, vẫn giữ historical last success. Server không Agent active →Unknown/no_active_agent. Status là quan sát metrics, **không phải khẳng định máy đang bật/tắt**.

Continuous coverage chỉ có ý nghĩa khi không reporter drop/incomplete/epoch gap. Không thể suy 'không có metrics' từ 'NestJS không nhận báo cáo'. Không hứa phục hồi báo cáo đã mất qua restart; không thêm durable queue để làm dashboard đẹp giả.

## 11. HTTP API và conventions

Admin API prefix `/api/v1`, internal prefix `/internal/v1`; không đổi Gateway ingest path. Endpoints mới dưới đây là contract dự kiến, không phải routes đã chạy. Admin-only mutation trừ Agent-owned config report; đọc theo RBAC mục7.

| Method/path | Chức năng / policy |
|---|---|
| GET `/api/v1/me` | Principal đã verify và effective role, không token |
| GET/POST `/api/v1/servers` | List/filter / create |
| GET/PATCH/DELETE `/api/v1/servers/:id` | Detail / patch allowlist / archive |
| GET/POST `/api/v1/server-groups` | Read / create group |
| GET/PATCH/DELETE `/api/v1/server-groups/:id` | Detail / patch / remove group không xóa Server |
| PUT/DELETE `/api/v1/servers/:id/groups/:groupId` | Idempotent membership mutation |
| POST `/api/v1/servers/:id/agents` | Register active Agent;409 nếu invariant vi phạm |
| GET `/api/v1/agents`, GET `/api/v1/agents/:id` | Read Agent/lifecycle/derived status |
| POST `/api/v1/agents/:id/disable`, `/enable`, `/retire` | Explicit lifecycle transitions |
| POST `/api/v1/agents/:id/credentials` | One-time issue; Admin |
| GET `/api/v1/credentials`, GET `/api/v1/credentials/:id` | Metadata only; Admin |
| POST `/api/v1/credentials/:id/rotate`, `/revoke` | Rotation/revoke; Admin |
| GET/POST `/api/v1/monitoring-profiles` | Read/create profile |
| GET/PATCH/DELETE `/api/v1/monitoring-profiles/:id` | Read / descriptive patch / retire |
| GET/POST `/api/v1/monitoring-profiles/:id/versions` | List/create draft |
| GET/PATCH `/api/v1/profile-versions/:id`, POST `/api/v1/profile-versions/:id/publish` | Read/edit draft/publish; no published-content update |
| GET/PUT/DELETE `/api/v1/servers/:id/profile` | Read/set/remove desired assignment |
| GET `/api/v1/audit-logs` | Admin-only cursor list |
| GET `/api/v1/agent/provisioning` | Own Agent credential guard |
| POST `/api/v1/agent/config-reports` | Own Agent credential guard |
| POST `/internal/v1/credentials/verify` | Gateway service proof |
| GET `/internal/v1/credentials/health` | Service scope credentials:verify, DB/auth-path probe, không real Agent key;204 khi sẵn sàng |
| GET/POST `/internal/v1/status/epoch`, POST `/internal/v1/status/reports` | Gateway status protocol |
| GET `/health/live`, `/health/ready` | Minimal operational responses, không DB/version/secret dump |

Global rate/concurrency middleware chạy trước body parser; tối đa16 handlers, request vượt giới hạn trả429 thay vì xếp queue. HTTP body read deadline5giây, header limits và response/error sanitization cấu hình rõ; cancellation/close giải phóng admission. Global DTO validation: unknown fields reject, transform primitive kiểu rõ ràng, không mass assignment; UUID/enum/text/ranges bounded. JSON raw body cap mặc định128KiB, profile64KiB/metadata4KiB, internal verify8KiB/status64KiB. Query arrays/operators không khai báo bị reject. Server name1–128, environment1–64, group slug1–64 lowercase allowlist; no arbitrary SQL/orderBy/JSONPath từ client.

List dùng cursor opaque có validate, stable sort created_at/id, default limit20/max100; filter allowlist Server os/environment/group/archive/name prefix, Agent server/lifecycle, credential Agent/derived state, profile OS/retired, audit actor/resource/action/time range. Viewer/Operator không đọc credential/audit route. Không trả dump toàn DB hoặc query không giới hạn.

Error JSON `{code,message,request_id}`, message finite/sanitized. 400 syntax/validation,401 missing/invalid proof,403 valid principal lacks permission/identity claim mismatch,404 missing resource,409 invariant/state conflict,413 caps,429 admission/rate limit,503 operational dependency/deadline. Map ORM unique/FK/serialization errors sang finite codes; không stack/SQL/hash/body/password trong error. App internal/health/log fields có allowlist; request IDs nội bộ tạo hoặc validate format, không echo raw arbitrary header. HTTP timeouts/pool sizes có config bounds.

OpenAPI bearer schemes tách AdminAssertion/AgentApiKey/InternalServiceAssertion, role/scope/one-time response/no-store được mô tả. Không persist authorization trong Swagger; docs endpoint chỉ bật rõ cho loopback lab/authorized use, không anonymous management data. Không CORS wildcard hoặc cookie trust cho API trực tiếp; browser tương lai dùng same-origin Grafana resources adapter.

## 12. Audit và secrets

Audit actions: create/update/archive/group membership, Agent register/lifecycle, issue/rotate/revoke, draft/publish/retire/assignment, relevant config report outcome; actor source user/service/Agent rõ, đối tượng IDs và outcome. Mutation success audit cùng transaction; internal verification success không tạo một business-audit row cho mọi metric. Failed/denied auth có bounded security logging/rate limits để không tự DoS DB.

Delta allowlist chỉ trường nghiệp vụ cần thiết; không raw headers/body/query, credential value/verifier, signed assertion, DB URL, config secrets, exception object. Không rely regex redaction sau khi đã log object. Request/response logging excludes issue/rotate secret response; no-store/never screenshot secret. Truncate/control metadata để chống log injection. Audit append-only bằng runtime grants, retention/export là operator action ngoài request API; không UPDATE/DELETE audit endpoint.

Key pairs, DB files và test private artifacts không Git/Docker build context. Chỉ public verification keys được mount vào NestJS, signing keys vào đúng service cần ký; không dùng cùng cặp cho Grafana/Gateway. Secret-file path env không chứa giá trị secret; không inject root.env toàn bộ vào backend/Gateway. Local HTTP/Docker network không mã hóa secret trên wire; signed requests **không thay TLS**. Dữ liệu thật/LAN/production cần TLS và network qualification riêng trước khi triển khai ngoài lab.

## 13. Docker/config/dependency constraints

New service `management` dùng `monitoring`+`database`; `ingest` chỉ monitoring; PostgreSQL chỉ database; Grafana/Prometheus/volumes/receiver vẫn nguyên. NestJS container port3000 theo scaffold; host đề xuất `127.0.0.1:${MANAGEMENT_HOST_PORT:-3001}:3000`, kiểm tra port trống trước start, không đụng Grafana3000/Gateway8000. Health liveness no IO; readiness DB ping+schema migration state+required auth config loaded, không gọi Grafana login hoặc Prometheus cho readiness NestJS.

Gateway readiness kiểm tra Prometheus và signed GET `/internal/v1/credentials/health` bằng bounded probes/pool riêng, không chỉ ping anonymous NestJS health rồi giả service auth hợp lệ. Cached ingest có thể còn hoạt động dù readiness503. Liveness vẫn200 khi process sống; Docker unhealthy không là yêu cầu tự restart chỉ vì NestJS/DB outage. Không dùng real API Key trong healthcheck. Startup migration healthy/completed trước backend; backend healthy trước Gateway cold-cache startup. Không migration trong every-replica app startup.

Docker runtime single process, nonroot, read-only rootfs/tmpfs, cap_drop ALL/no-new-privileges, log rotation kế thừa10m/3. Management memory512MiB/pids128 là default ban đầu, phải verify actual image không giả load-qualified. Test/migration stages riêng; không copy host node_modules, dev credentials, whole repo vào runtime. node_modules/build/test outputs là ignored local artifacts; không xóa scaffold người dùng.

Config contract mới (template chỉ ghi defaults/path mô tả, không secret values):

| Biến | Ý nghĩa/default |
|---|---|
| `MANAGEMENT_HOST_PORT` / `PORT` | Host3001 / internal3000; PORT của NestJS container, không inject host port làm listen port |
| `MANAGEMENT_DATABASE_URL_FILE` | Required runtime role connection string từ secret file, không CLI/raw env dump |
| `MANAGEMENT_MIGRATION_DATABASE_URL_FILE` | Required chỉ migration container; không mount vào runtime |
| `MANAGEMENT_ADMIN_TRUST_FILE` / `MANAGEMENT_SERVICE_TRUST_FILE` | Required local public-key maps, kid→issuer/audience/subject constraints/scopes; không private keys hoặc token-supplied URL |
| `MANAGEMENT_GRAFANA_CONTEXT` | Expected default Grafana source context phải xác định từ instance thật trước real adapter rollout; không tự đoán ID hay tạo tenant module |
| `MANAGEMENT_AGENT_INGEST_BASE_URL` | Lab host sender `http://127.0.0.1:8000`, không Docker DNS cho VM |
| `MANAGEMENT_LOG_LEVEL` | INFO, formatter allowlist; không verbose request/ORM parameter logging |
| `MANAGEMENT_REQUEST_RATE_PER_SECOND` / `MANAGEMENT_REQUEST_BURST` |20/40 global single-process token bucket, health bypass; max active handlers16, full→429, no unbounded wait queue |
| `MANAGEMENT_DB_POOL_MAX` / `MANAGEMENT_DB_POOL_TIMEOUT_MS` |10/1000; bounded statement/transaction deadlines, operational expiry→503 |
| `MANAGEMENT_NONCE_MAX_ENTRIES` |20000 active nonce rows; expiry cleanup bounded mỗi60giây và trong admission khi cần; DB uniqueness vẫn authority |
| `INGEST_MANAGEMENT_BASE_URL` |`http://management:3000`; trusted config, no userinfo/query/fragment hoặc per-request override |
| `INGEST_CREDENTIAL_TIMEOUT_SECONDS` |2 total; positive finite |
| `INGEST_CREDENTIAL_CACHE_TTL_SECONDS` / `INGEST_CREDENTIAL_CACHE_MAX_ENTRIES` |30 hard maximum /1024 (allow1–10000); reject settingTTL>30, không silentextend |
| `INGEST_GATEWAY_ID` / `INGEST_SERVICE_KEY_ID` / `INGEST_SERVICE_SIGNING_KEY_FILE` | Required stable source UUID / trusted kid / private key file riêng của Gateway |
| `INGEST_STATUS_INTERVAL_SECONDS` / `INGEST_STATUS_TIMEOUT_SECONDS` / `INGEST_STATUS_MAX_PENDING_AGENTS` |10/2/1024; same bounds với protocol, không tăng buffer vượt server-side limit |

Phải giữ security caps/role separation khi validate config. Public key files và signing/DB secrets mount read-only có quyền đọc đúng UID; bổ sung ignore secret directories như `/deploy/secrets/`, node_modules/dist/cache/test artifacts trong implementation. Không commit secret file chỉ vì extension không là .env/.key. URL từ request không tự override trusted destinations; HTTPS requirement ngoài explicit HTTP lab, không coi request signature là mã hóa.

Reuse current scaffold versions/ESM/pnpm/Vitest; chọn/pin Prisma cùng PostgreSQL driver/adapter, validation/OpenAPI/signature packages và Python Ed25519/JWT dependency theo compatibility thực với NestJS12/TS6/Node LTS trước implementation. Spec không tuyên bố một Prisma version cụ thể đã được install/prove; planning phải xác minh registry/official compatibility, pin lock/build images và nêu blocker nếu không tương thích, không tự major-upgrade framework/fallback latest. Kiểm chứng decorator metadata, raw-body support, pnpm frozen install, TypeScript build, unit/e2e và Linux runtime; không mặc định scaffold tests đã green.

Root-run canonical command giữ `docker compose --env-file .env -f deploy/compose/compose.yaml ...`; **không thêm `--project-directory .`** vì sẽ làm existing ../../paths resolve sai. Chỉ config --quiet/allowlisted inspect khi được quyền thực thi ở giai đoạn sau, không in expanded env/Config.Env. Không down-v/prune/reset/delete TSDB/firewall/LAN change.

## 14. File inventory dự kiến

Các path mới dưới đây là planned, chưa tạo trong giai đoạn spec. Các file hiện có phải đọc trước sửa; ownership và exact test files/tasks chốt ở implementation plan.

| Khu vực | Files/directories |
|---|---|
| Nest scaffold giữ/mở rộng | `services/management-backend/src/main.ts`, app.module/controller/service và scaffold tests; package.json, pnpm-lock.yaml, tsconfig/build/Vitest/nest configs, README, scoped AGENTS (đọc, không bật Observe) |
| Nest modules mới | `src/config/`, `src/database/`, `src/auth/`, `src/common/` (errors/DTO/pagination), `src/servers/`, `src/groups/`, `src/agents/`, `src/credentials/`, `src/profiles/`, `src/provisioning/`, `src/status/`, `src/audit/`, `src/health/` |
| Prisma/DB mới | `prisma/schema.prisma`, migrations SQL, seed definitions, Prisma config phù hợp version đã verify; bootstrap/grants operation dưới `deploy/`, không test/README dưới infra |
| Nest tests mới | Unit specs trong module hoặc test/unit; test/integration DB thật; test/e2e admin signed fixture và management–Gateway orchestration; fixture keys sinh tại test, không secrets commit |
| Nest packaging mới | Dockerfile, .dockerignore; no replacement scaffolding/generated node_modules in Git |
| Gateway mới | `app/credentials.py`, service assertion helper, `app/status_reporter.py`; bounded independent unit/integration tests |
| Gateway sửa có giới hạn | [identity.py](<../../../services/ingestion-gateway/app/identity.py>), [routes/ingest.py](<../../../services/ingestion-gateway/app/routes/ingest.py>), [pipeline.py](<../../../services/ingestion-gateway/app/pipeline.py>), [main.py](<../../../services/ingestion-gateway/app/main.py>), [config.py](<../../../services/ingestion-gateway/app/config.py>), [errors.py](<../../../services/ingestion-gateway/app/errors.py>), [observability.py](<../../../services/ingestion-gateway/app/observability.py>), [routes/health.py](<../../../services/ingestion-gateway/app/routes/health.py>), dependency lock và existing fixtures/E2E |
| Root integration | [Compose](<../../../deploy/compose/compose.yaml>), [.env.example](<../../../.env.example>), [.gitignore](<../../../.gitignore>), [README](<../../../README.md>); root .env/real keys không tự sửa |
| Docs | New management runbook/acceptance/API handoffs; link từ existing Gateway runbook, giữ historical Step1/2 acceptance không rewrite PASS/FAIL |

Không refactor codec/protobuf/normalization/forwarder chỉ để tiện auth; touch nếu có một required hook rất nhỏ thì phải chứng minh preservation. Không sửa collectors/installer/plugin/AIOps/Telegram/infra templates ngoài phạm vi.

## 15. Verification và acceptance matrix

Mọi lệnh/tests dưới đây là tiêu chí cho triển khai sau, **chưa chạy trong giai đoạn thiết kế**. Không coi 'file tồn tại' hoặc MockTransport pass là production integration pass. Migration/constraint test trên DB test/schema tách biệt; không truncate/reset DB/volumes thật. Gateway regression suite giữ đầy đủ, chỉ update legitimate auth fixtures. Các tests clock/TTL/status/replay dùng fake clocks; real E2E finite deadline có evidence thực.

| ID | Tiêu chí nghiệm thu |
|---|---|
| MB-01 | Existing scaffold preserved; pinned compatible dependencies/Node image, frozen pnpm/uv install, type/lint/build/unit baseline rõ, decorator/raw-body metadata verified. |
| MB-02 | DB roles/grants và versioned migrations từ empty test DB rồi upgrade lần hai không phá dữ liệu; runtime không DDL/audit UPDATE/DELETE; schema/constraints/index thực. |
| MB-03 | Server/group CRUD/archive/filter/pagination/DTO bounds, stable UUIDs, no hard-delete history; lifecycle/OS/profile races có tests. |
| MB-04 | Concurrent register/enable chỉ một Agent active; immutable server link, terminal retired, disable/enable không revive keys; rollback nếu audit fail. |
| MB-05 | Issue/verify/expiry/rotate/revoke/issuance retry; secret chỉ one-time, verifier constant-time, DB/rawlogs/list/audit/provisioning không plaintext; rotation300s không extend old cutoff. |
| MB-06 | Admin signature, iss/aud/kid/TTL/role/subject, raw target/body binding, replay duplicate và NestJS restart, nonce capacity/cleanup/DB failure; Viewer/Operator cannot mutate, service cannot Admin. |
| MB-07 | Real Gateway→NestJS→DB verification, key fingerprint isolates wrong-secret/same-ID, optional claim match, inject trusted IDs, spoofed header/payload refused/no forward. |
| MB-08 | Positive cache hard30s from call start, slow responses, expiry shorter TTL, no sliding/negative/error caching; cold/restart/outage→503, live cache only đến deadline, no fallback. |
| MB-09 | Existing Snappy/protobuf/unknown-field/float/timestamp/whole-batch/output-cap/oneattempt/cancellation/admission tests không bị bỏ; auth flood cũng bounded/no double lease. |
| MB-10 | Profile JSON allowlist/OS/version/checksum immutability, exact assignment/rollback, no raw script/secret/destination; race version/assignment checked. |
| MB-11 | Provision own resource only, no secret echo, trusted configured ingest URL, no assignment409; config report không tự Online/applied proof và giữ desired/reported distinction. |
| MB-12 | Real status reporter2xx-only, latest coalescing, report duplicates/order/epoch/CAS/chunks/overflow/gap/clock; DB GREATEST, no pending slot leak, typed source failure cannot fake complete/Offline. |
| MB-13 | Deterministic90/300 boundaries, no metrics Unknown, disable/retire/noactive/history handling; heartbeat loss, restart and recovery coverage đúng, response shows as_of/confidence/lag. |
| MB-14 | Real Docker management/Gateway readiness/liveness, ports/networks/least secrets/nonroot/read-only/memory/pids; native-host isolation kiểm tra thật, inspect alone không chứng minh. Baseline IDs/volumes/data preserved. |
| MB-15 | Cross-service E2E ở mục16; correct IDs/sample timestamp/value, warm-cache revoke bound and noforward after expiry; actual failures/limits/time/exit logged an toàn. |
| MB-16 | Logs/errors/audit/Swagger/HTTPX/Node/ORM/proxy paths được kiểm tra sentinel thực, không privatekey/key/hash/DB URL/body leak; private artifacts không staged. |
| MB-17 | Handoff contracts Step4/6/OpenAPI/runbooks cùng schema; distinguish signed test fixture vs Grafana real, no install/renderer/VM claims; rollback and uncertainty documented. |

E2E secret scan không chỉ grep source; capture process/container stdout/stderr, issue+rotate response instrumentation, invalid DTO/signature/DB error, URL/path/query sentinels, audit query, and outgoing commit candidates khi có quyền publish. No secrets in CI report/CLI args/screenshots. Dependency/secret checks không là CVE/penetration-test guarantee.

## 16. Kịch bản E2E và không phá dữ liệu

1. Test tạo signing material và Admin fixture ở isolated test environment; config receiver chỉ trust test public key trong môi trường đó. Reject Viewer/service-to-admin trước khi làm mutations.
2. Gọi NestJS tạo Server UUID, register Agent active, seed/gán OS profile cụ thể; query PostgreSQL xác nhận FK/constraints/audit/actor đúng, không dùng SQL để bypass API.
3. Issue key bằng unique issuance_request_id, giữ secret trong memory; list/get/DB/audit không trả plaintext; GET provisioning bằng key chỉ trả own config, không mark Online.
4. Gửi independent Remote Write fixture qua Gateway thật; không gọi NestJS với raw metrics. Run_id UUID mỗi case, values/timestamps được giữ khi test sender retry có giới hạn; request sender không được tự chọn server identity khác.
5. Query Prometheus từ network thật để xác nhận sample/value/timestamp và trusted Server/Agent labels. Kiểm tra missing headers/labels được derive; conflicting claim/payload refused và Prom không có series cho riêng failed run_id trong toàn observation deadline.
6. Chờ reporter cập nhật last_metric_seen_at và source epoch/coverage; xác minh status/as_of/actor. Receipt/success time không lấy từ backdated sample timestamp. Lifecycle disable/replacement không dùng old Agent activity cho Server mới.
7. Warm credential cache, revoke qua Admin API, xác minh DB commit+audit. Trong cache window có thể còn accepted theo hợp đồng; sau t_revoke_commit+30giây mọi request có auth decision mới bằng key đó phải401 khi control plane khỏe, không forward. Dùng run_id mới và finite polling để chứng minh absence; không xóa data cũ hoặc đòi hủy in-flight đã authenticate.
8. Riêng outage test trong isolated stack: cache còn hạn accepted; expired/cold cache503; recover verify fresh; rotate overlap/expiry và reporter gap/Unknown bằng clock tests + targeted runtime evidence. Không dừng PostgreSQL/Prometheus shared thật để giả outage.
9. Record service IDs/volumes before/after, only remove task-owned one-off containers/DB test sau khi xác minh targets; no down-v/firewall/TSDB delete. Samples lab retained theo retention hiện có, không promise restore/content integrity chỉ từ IDs.

Real NestJS+PostgreSQL+Gateway+Prometheus là yêu cầu; Grafana datasource hiện có có thể dùng để kiểm tra metrics nhưng **không thay thế real Grafana login/adapter integration của Bước6**. Không claim installer/Telegraf VM ở Bước3. Test-signer utilities không là production authentication service.

## 17. Handoff và vận hành sau triển khai

Bước4 nhận: Admin registration/key one-time workflow; stable IDs/OS; Agent-facing ingest URL và protocol; provisioning JSON schema/checksum/exact profile version; own config-report API; rotate/revoke behavior và cách bảo vệ secret. Installer chịu trách nhiệm render/write Telegraf config, service lifecycle, permissions, áp dụng và báo kết quả; không tự viết vào DB hay gắn IDs theo ý muốn.

Bước6 nhận: OpenAPI admin endpoints/DTO/errors/cursors; signed-assertion wire contract + test vectors/key rotation procedure; stable subject source verification gate; CurrentUser/effective RBAC; inventory/lifecycle/observability confidence models; key reveal-once/no-store UI; profile desired vs reported version, audit. Browser không giữ signing/private/service keys. Không đánh đồng default org metadata với một module quản lý organizations.

Runbook phải có: least-privilege bootstrap, secrets issuance/mount/rotation, migration backup/upgrade và fail behavior; startup/health/CLI path erratum; stop/rollback app image nhưng giữ DB/volumes. Không tự rollback destructive migrations hoặc fallback Gateway insecure; khi schema không tương thích thì fail readiness và operator xử lý từ backup có kiểm chứng. Không đổi password `.env` rồi giả đã rotate credential trong existing volume.

## 18. Self-review và gate tiếp theo

Các invariants bắt buộc: no implementation trước approvals; không local password DB mới; không raw metrics qua NestJS; stable UUID/one-active DB unique; source-of-truth identity không browser; raw secret one-time; revoke bound30s không sliding; bounded reporter không fake Offline; same-transaction audit; immutable profile/version; least-privilege DB và không reset Step1/2.

Written-spec approval mới cho phép viết implementation plan. Plan phải cụ thể hóa exact package/image pins đã xác minh, đường dẫn/test commands, task ownership theo dependency, constraints/migration operations và evidence cho MB-01–MB-17; có execution choice riêng. Không tự stage/commit/push tài liệu hoặc scaffold: quyền publish Bước2 trước đây không tự mở rộng sang Bước3.
