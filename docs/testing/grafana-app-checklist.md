# Bước 6 — Checklist xác minh Grafana App

Source/build/offline adapter checks không phải runtime acceptance. Sau khi người dùng cho phép lab riêng, một phần đã có [biên bản E2E vm-1](<grafana-app-vm1-20261103.md>) và [evidence allowlisted](<evidence/grafana-app-vm1-20261103.json>): identity/RBAC, CRUD/search/pagination, issue/rotate/lost-response recovery, profile race và Linux metrics/dashboard. **Recovery/teardown chưa hoàn tất; Windows service/PDH chưa thử.** Các mục gộp dưới đây vẫn unchecked nếu còn nhánh chưa nghiệm thu; không coi đó là chưa từng thử phần Linux. Không test bằng reboot VM khi chưa trao đổi và xác nhận riêng. Không dùng key/password/private PEM thật trong ảnh, log, ticket hoặc báo cáo.

## Artifact và triển khai
- [ ] Build frontend và Go backend đúng OS/arch; dist có plugin.json/module.js/logo và executable đúng tên/quyền.
- [ ] Grafana13.3.x load đúng ID; unsigned exception chỉ lab hoặc production manifest ký hợp lệ; không mount source/private key vào web assets.
- [ ] Existing provisioning datasource + đúng hai dashboards giữ nguyên, app enabled ở org enrollment, subpath/root URL và navigation hoạt động.
- [ ] Plugin restart/reload, backend crash/unready và mất Management có finite errors; không fallback fake data/privileged service user.
- [ ] Private signing key readable UID472,0400/0600; public Nest admin trust khớp kid/issuer/audience/context; distinct Gateway service trust.

## Identity và RBAC (không bỏ qua upstream maturity gate)
- [ ] Review/accept hoặc giải quyết separately upstream Grafana OSS signing-key maturity; không coi opt-in flag là chứng nhận production.
- [ ] Request server thực có X-Grafana-Id; đúng issuer exact AppURL, signed user DB subject, org/namespace/current role; không env fallback khi request thiếu AppURL.
- [ ] Rename login/email không đổi subject; đổi org, service account/API token/anonymous/render và instance/database replacement bị chặn hoặc enrollment đúng, không nâng quyền.
- [ ] Browser giả Authorization/role/X-Grafana-Id không thay verified principal; Grafana middleware overwrites/deletes proof; plugin RPC không public.
- [ ] Thiếu/corrupt/expired/future/overlong JWT, sai alg/kid/type/issuer/audience/namespace/org/role, duplicate headers hoặc untrusted JWKS đều fail closed.
- [ ] JWKS rotation/revocation/throttle/cache60s; dependency down lúc cache expiry trả503, không stale trust; oversized/malformed/redirect rejected.
- [ ] HTTPS cert/SAN/chain/privateCA verification; no insecure bypass, ambient proxy hoặc credential forwarding. Local HTTP chỉ explicit loopback dev, không private remote origin.
- [ ] Viewer/Editor đọc đúng dữ liệu; direct write calls và credential metadata bị Nest403; Admin thực mới được mutation/preview. UI chỉ là hint.
- [ ] Assertion Ed25519 exact raw body + outbound target/query/order/escape, fresh nonce, issuer/aud/context, expiration; replay/modified bytes bị Nest từ chối.

## UI và inventory
- [ ] Overview có totals đúng cho scan hoàn chỉnh; partial/bounded scan và non-atomic/as-of được hiển thị; Unknown không đổi Offline, không suy diễn power state.
- [ ] Servers prefix search, OS/environment/archive filters, cursor Next/Previous; A→B→A không phục hồi cursor sai; API409/404/401/403 có recovery rõ.
- [ ] Create/edit/detail/archive validation metadata4KiB nonsecret, OS compatibility; sensitive archive xác nhận tác động credentials; list/detail refresh sau mutation.
- [ ] Agents list/filter/detail liên kết Server, null version/lastseen không fake; disable/enable/retire tác động keys đúng, retire terminal.
- [ ] Profiles list/version pagination vượt100 đúng; published config/checksum read-only; exact OS-compatible assignment, expected404 unassigned là empty state.
- [ ] Loading/empty/error/notifications/confirmations accessible bằng keyboard, light/dark themes, màn hình hẹp, browser Back và request cancellation/race.

## Credential và onboarding
- [ ] Issue/rotate operation UUID tạo trước submit, double-click blocked, no automatic mutation retries; all three scopes/default expiry và UTC validation đúng.
- [ ] Secret hiển thị một lần ở modal, Copy explicit, không URL/storage/log/toast/analytics/request-debug; đóng/navigate/refresh bỏ secret; clipboard warning có thật.
- [ ] Simulate response lost after commit: UUID giữ trong memory, metadata inspection bounded/complete-status rõ;409 không có secret lại, không blind retry/new UUID.
- [ ] Recovery key không truy cập được: revoke + xác nhận trạng thái authoritative trước new operation; scan incomplete/notfound không biến thành đã reconcile.
- [ ] Rotation old key cutoff<=300s, revoke cache<=30s/in-flight được giải thích; modal close không làm backend rollback issuance.
- [ ] Add Server→Register Agent→exact published profile acceptance→Issue→actual provisioning: IDs/OS/profileversion/checksum/origin khớp; concurrent assignment change bắt refresh/reaccept.
- [ ] Preview GET records receipt only; không report applied/Online; wrong Agent key hoặc missing scopes/409 chưaready xử lý rõ, key paste tạm thời được clear.
- [ ] Linux/Windows instructions dùng reviewed installer/binary/independent checksum, đúng flags/CA, hidden key prompt, không key commandline/curl-pipe/insecure option.
- [ ] Khi có máy thử riêng: cài Agent thật, kiểm tra applied report/credential binding/TLS/metrics; không coi preview/build là onboarding E2E.

## Monitoring
- [ ] Chọn Server/Agent thực, OS chọn đúng UID linux-host/windows-host; URL encoded server_id + agent_id và Grafana subpath đúng; không host/instance heuristic.
- [ ] Hai Server/Agent không lẫn biến/dữ liệu, disabled/retired/historical Agent có thông báo đúng; no selectedIDs không mở link sai.
- [ ] Live dashboard/NoData/query errors được phân biệt với Management telemetry; không thêm chart React hoặc thay metric contract để che lỗi.
