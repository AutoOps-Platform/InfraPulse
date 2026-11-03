# Bước 6 — InfraPulse Grafana App Plugin

## 1. Phạm vi và hợp đồng

Source ở [apps/grafana-app](<../../apps/grafana-app/README.md>), ID `infrapulse-infrapulse-app`. React19/TypeScript/Grafana UI13.3.0; official create-plugin7.17.0 build tooling; backend process dùng official Go SDK0.298.0. Hỗ trợ được thiết kế cho **self-hosted Grafana13.3.x, database-backed users, một org được enrollment**. Không tự tuyên bố tương thích Grafana Cloud/multi-tenant/k8s users/phiên bản khác.

NestJS vẫn sở hữu toàn bộ nghiệp vụ/RBAC/database. [Hợp đồng user API](<../contracts/grafana-management-api.md>) và [provisioning](<../contracts/agent-provisioning.md>) không thay đổi. Không thêm API quản trị trùng lặp, không thay Prometheus/Gateway/dashboards. Plugin tái sử dụng installer hiện có; đợt E2E đã bổ sung regression fix cho startup/TOML gate của Linux installer, được ghi rõ trong biên bản kiểm thử. Chỉ adapter endpoints `settings` (public origins sau xác thực) và `provisioning` (Admin preview) nằm trong resource API của plugin, không phải endpoint mới của NestJS.

## 2. Tại sao backend adapter, không static proxy

NestJS yêu cầu assertion Ed25519 có `iss/aud/sub/kind/ctx/grafana_role/iat/nbf/exp/jti` và binding `m/t/b` với **exact outbound method, target gồm raw query, SHA256 raw UTF-8 body**. Static Grafana proxy không tự tạo binding/nonce theo request. Go adapter chỉ allowlist các route quản trị thực sự dùng; không expose `/internal/*`, không là generic URL proxy, không public HTTP signer.

Browser gửi request cùng-origin resource API, không gửi role/issuer/context để quyết định quyền. Go xác minh Grafana ID token, ký assertion mới 30s + UUID nonce rồi gọi NestJS. Viewer/Editor chỉ đọc theo NestRBAC hiện tại; Editor map Operator, **không tự nâng quyền ghi**. Admin-only gồm cả metadata API Keys. UI ẩn/hiện nút chỉ tiện dụng, không phải authorization.

## 3. Enrollment danh tính — không được bỏ qua

SDK `backend.User` chỉ có Login/Name/Email/Role, không immutable ID. Không dùng username/email, browser `config.bootData`, default org hay lab UUID làm subject. Dùng signed **`X-Grafana-Id` ES256 JWT** do middleware Grafana thay thế/xóa theo authenticated requester; xác minh public JWKS fixed-origin rồi yêu cầu:

- issuer đúng **exact** Grafana `cfg.AppURL` (kể cả trailing slash/subpath), audience chỉ `org:<id>`, user type và canonical `sub=user:<positive database ID>`;
- org/namespace khớp cấu hình đã enrollment và PluginContext; self-hosted org1 có namespace `default`, orgN>1 có `org-N`, nhưng các tên này tự thân không là proof;
- role Viewer/Editor/Admin khớp role server hiện tại; token ES256/P-256 đúng `kid/typ`, thời gian bắt buộc, tối đa600s, skew5s; không nhận service account/anonymous/render;
- request PluginID/AppURL/instance context hợp lệ, không fallback environment AppURL khi request thiếu config;
- auth method allowlist rõ ràng. Source local password là `password`; session có thể kế thừa auth module hoặc omit claim khi không có user_auth. Sentinel `absent` chỉ chấp nhận **signed omitted** `authenticatedBy`, không suy ra đó là password login. Ví dụ reviewed local policy: `password,absent`; OAuth cần review module thực tế trước khi thêm.

**Upstream maturity gate:** [Grafana13.3.0 signing-key service](https://github.com/grafana/grafana/blob/v13.3.0/pkg/services/signingkeys/signingkeysimpl/service.go) vẫn ghi OSS implementation đang phát triển/chưa production ready. Đây là giải pháp có căn cứ source, không phải production guarantee. Operator phải review và đặt `INFRAPULSE_ACCEPT_EXPERIMENTAL_IDENTITY=true` để chủ động bật; mặc định false làm plugin fail closed. Nếu không chấp nhận rủi ro, **không bật adapter**, cần một identity bridge server-side được review riêng, không thay bằng username/header giả.

JWKS chỉ lấy từ URL operator đặt sẵn (`.../api/signing-keys/keys`), không từ JWT issuer/jku/x5u. Fetch giới hạn64KiB/32keys/5s, cache replace tối đa60s, refresh throttle5s và không dùng cache đã hết hạn khi dependency lỗi. Không redirect/proxy ambient, TLS>=1.2, không insecure skip verify. Revocation Grafana signing key có thể chịu cache tối đa60s; role request vẫn đối chiếu current PluginContext. Đổi/reseed/clone database hoặc thay instance phải enrollment trust/context mới: database ID không có ý nghĩa toàn cầu qua các thao tác đó.

## 4. Key/trust và cấu hình runtime

Tạo **Ed25519 PKCS8 private key riêng cho user assertions** bằng quy trình PKI/secret management của operator. Chỉ mount vào Grafana runtime read-only, file mode0400/0600, readable bởi UID chạy Grafana (image hiện tại UID472); không đặt PEM trong env, bundle, Docker build context, UI settings hoặc Git. Không tái sử dụng Gateway service key. NestJS chỉ mount public admin trust, giữ service trust riêng.

Trong admin trust hiện có, thêm entry có key ID, `issuer`, `audience`, `public_key_pem` đúng key mới theo [deployment Management](<management-backend.md>). Shape entry user (placeholders phải được thay riêng ở runtime, không chứa `subject` cố định vì có nhiều users):

```json
{
  "<INFRAPULSE_ASSERTION_KEY_ID>": {
    "public_key_pem": "<Ed25519 PUBLIC KEY PEM>",
    "issuer": "<INFRAPULSE_ASSERTION_ISSUER>",
    "audience": "<INFRAPULSE_ASSERTION_AUDIENCE>"
  }
}
```
 Giữ các entry cần thiết, không ghi đè trust cũ tùy tiện. `MANAGEMENT_GRAFANA_CONTEXT` phải là enrollment context thật của instance/org và phải đúng `INFRAPULSE_ASSERTION_CONTEXT`. Rotating signing key: thêm public key mới trước, deploy key/kid mới + restart Grafana để nạp process, chờ assertion cũ hết hạn và admission hoàn tất rồi bỏ old public key. Management trust được nạp startup, cần rollout/restart theo quy trình của backend. Không tự xóa/revoke Agent key trong thao tác này.

Template không chứa secret: [plugin .env.example](<../../apps/grafana-app/.env.example>). Các biến chính:

| Biến | Ý nghĩa |
| --- | --- |
| `INFRAPULSE_GRAFANA_ISSUER` | Exact actual Grafana root URL, cũng là `GF_SERVER_ROOT_URL` ở overlay |
| `INFRAPULSE_GRAFANA_JWKS_URL` | Fixed trusted endpoint của chính instance, không URL discovery |
| `INFRAPULSE_GRAFANA_ORG_ID`, `...NAMESPACE` | Org cụ thể đã enrollment; app provisioning dùng cùng org ID |
| `...GRAFANA_AUTH_METHODS` | CSV không khoảng trắng, review theo auth modules thực tế |
| `...ASSERTION_ISSUER/AUDIENCE/KEY_ID` | Khớp Nest admin trust, khác service trust |
| `...ASSERTION_KEY_FILE` | Absolute HOST path trong Compose, container path cố định `/run/infrapulse-grafana-assertion.pem` |
| `...AGENT_CONTROL_URL` | HTTPS Management origin thực sự Agent truy cập, không `/api/v1` suffix |
| `AGENT_GATEWAY_ORIGIN` | HTTPS origin khớp đúng provisioning/installer pin |

Không có default instance identity. Không sửa root URL của Grafana đang dùng mà không migration URL/cookie/reverse-proxy có chủ đích. Private CA: runtime ngoài Compose có `INFRAPULSE_GRAFANA_CA_FILE` / `...MANAGEMENT_CA_FILE`; nếu dùng với overlay, tự thêm read-only mount và env file path tương ứng. Leaf cert/SAN/chain phải phù hợp URL, không giải quyết bằng bỏ TLS verification.

## 5. Build và Compose

```sh
cd apps/grafana-app
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm build
pnpm build:backend
```

Go>=1.26.5 (đã dùng1.27.1), Node24.x, pnpm11.24.0. Khi chuyển artifact từ Windows sang Linux, kiểm tra owner/read permissions và đặt executable mode0755 cho Go binary trước read-only mount; không suy ra NTFS ACL tương đương POSIX permissions. Các artifacts có frontend AMD entry, assets/plugin metadata, executable `gpx_infrapulse_linux_amd64`. Optional [Dockerfile artifact target](<../../apps/grafana-app/Dockerfile>) build Linux không khởi chạy app. Chạy `pnpm dev` để watch frontend; không tự chạy Grafana thứ hai thay stack hiện có.

Merge **giá trị đã review** từ template plugin vào root private `.env`; không đưa credential vào shell history. Base stack DB/bootstrap/migrate/seed vẫn theo quy trình cũ. Overlay dùng provisioning root riêng `/etc/infrapulse-provisioning` với bốn directory mounts read-only (app và ba families hiện có), tránh nested missing mountpoint dưới bind read-only của base. Sau khi build, overlay opt-in [compose.grafana-app.yaml](<../../deploy/compose/compose.grafana-app.yaml>) mount dist và provisioning app vào Grafana hiện có. Khi Agent TLS đã cấu hình:

```sh
docker compose --env-file .env \
  -f deploy/compose/compose.yaml \
  -f deploy/compose/compose.agent-tls.yaml \
  -f deploy/compose/compose.grafana-app.yaml \
  up -d grafana
```

Đây là **lệnh cho operator chạy sau**, không phải lệnh đã deploy trong implementation. File paths/CA/secrets, enrollment, runtime permission, app-enabled status và private networking phải sẵn sàng. Overlay chỉ allow unsigned **đúng plugin ID** cho development/lab, không wildcard. Grafana13 mặc định lọc custom environment khỏi backend subprocess; `GF_PLUGINS_FORWARD_HOST_ENV_VARS=infrapulse-infrapulse-app` là allowlist **plugin ID**, cần thiết để backend nhận cấu hình runtime. Cơ chế upstream này chuyển **toàn bộ container environment** cho backend được tin cậy đó, không chỉ các biến `INFRAPULSE_*`; không thêm plugin khác hoặc wildcard, không đặt credential không liên quan trong container Grafana. Cấu hình/key vẫn chỉ server-side, không đi vào frontend bundle. Production: ký artifact bằng Grafana official `sign-plugin` và access policy token giữ ở secure CI secret; không commit token/signed secret config. Bỏ env unsigned exception bằng production override, review signed manifest/root URL theo [official signing guide](https://grafana.com/developers/plugin-tools/publish-a-plugin/sign-a-plugin). Không dùng unsigned exception như production assurance.

Development same-container channel: nếu Grafana root thật là `http://localhost:3000/`, JWKS có thể `http://127.0.0.1:3000/api/signing-keys/keys` và explicit `INFRAPULSE_ALLOW_LOOPBACK_GRAFANA_HTTP=true`; verifier chỉ cho HTTP localhost/literal127.0.0.1/::1, cùng port khi cả hai HTTP. Không cho private DNS/IP từ xa dưới flag này. Management HTTP `http://management:3000` chỉ là private Docker-network transport hiện có, explicit allow-private flag ở overlay; signatures không mã hóa dữ liệu. Remote deployment phải dùng HTTPS/private channel được kiểm soát, không expose Management HTTP ra Internet. Browser Grafana nên HTTPS hoặc SSH tunnel để bảo vệ one-time key.

## 6. Sử dụng và an toàn credential

Mở `/a/infrapulse-infrapulse-app/overview` dưới Grafana subpath nếu có. Overview scan có giới hạn, có thể partial; không là aggregate transactional endpoint. Telemetry Unknown giữ nguyên reason/as-of/source health, không đổi thành Offline. `/me` trả lời chỉ chứng minh Management user API, không mọi dependency healthy.

Onboarding: **Add Server → chọn OS thật của Server → Register Agent → chọn/pin published profile version đúng OS → Issue API Key → provisioning preview → đọc/install instructions → View Monitoring**. GET provisioning tạo receipt ở Nest, không chứng minh applied/installed/Online. Installer có sẵn tự provision/render/report sau; không copy nghiệp vụ đó vào plugin. Không có artifact distribution API: operator chuyển bundle installer đã review và official Telegraf binary + independent checksum. Commands hướng dẫn có placeholder local path/hash/CA rõ ràng; key nhập qua hidden prompt, không command line. Không cung cấp `curl|bash`, ExecutionPolicy bypass hoặc TLS insecure option.

Key chỉ xuất hiện một lần trong modal đang mở; Copy cần user action và clipboard có thể còn secret sau khi modal đóng. Đóng/đổi trang/refresh không lấy lại được. Không ghi localStorage/sessionStorage, URL, log, notifications hoặc metrics analytics. Nếu request issue/rotate timeout/lost response: giữ operation UUID ở bộ nhớ để đối chiếu metadata, không auto-retry/new UUID. `secret_already_issued` chỉ trả safe metadata; inspect/revoke key không còn truy cập được rồi **chủ động** tạo operation mới. Reload làm mất UUID tạm thời: dùng metadata Agent để tìm issuance cần xử lý. Rotation successor trả secret một lần, old key cắt tối đa300s; cần cập nhật installer kịp thời. Revoke/disable/retire/archive có xác nhận; Gateway positive cache<=30s/in-flight requests không bị hủy tức thời.

Profiles không có “latest mutable config”: xem version/checksum và pin exact published ID, backend kiểm tra OS/retired/lifecycle. Monitoring mở `infrapulse-linux-host` hoặc `infrapulse-windows-host`, truyền cả IDs, không host/instance heuristic. Empty dashboard không chứng minh máy tắt; cần phân biệt chưa có sample, disabled metric group, stale/Unknown và query/connection errors.

## 7. Phạm vi đã xác minh và gate còn thiếu

Giai đoạn implementation ban đầu chỉ thực hiện source/build/offline checks. Sau đó người dùng cho phép lab vm-1: plugin đã load trong Grafana13.3.0, identity/RBAC và UI/API onboarding thực đã được thử, Linux Agent đã gửi metrics qua Gateway/Prometheus và mở đúng dashboard. Xem [biên bản E2E partial](<../testing/grafana-app-vm1-20261103.md>) và [checklist](<../testing/grafana-app-checklist.md>).

**Chưa hoàn tất E2E:** recovery/teardown đang chờ operator; Windows Service/PDH/metrics, subpath/multi-org/JWKS runtime matrix và production acceptance chưa đạt. Lần reboot lab gây gián đoạn SSH, người dùng phải reset password thủ công; không coi là test pass và không tiếp tục thử bằng reboot nếu chưa trao đổi/xác nhận riêng. Không suy rộng build pass hoặc Linux lab thành production/Windows qualification. Maturity gate của identity upstream vẫn giữ nguyên.

Nguồn upstream: [official plugin tools](https://grafana.com/developers/plugin-tools), [SDK0.298.0 User model](https://github.com/grafana/grafana-plugin-sdk-go/blob/v0.298.0/backend/common.go), [Grafana ID forwarding](https://github.com/grafana/grafana/blob/v13.3.0/pkg/services/pluginsintegration/clientmiddleware/forward_id_middleware.go), [ID token signer](https://github.com/grafana/grafana/blob/v13.3.0/pkg/services/auth/idimpl/service.go). Đây là tài liệu source contract, không thay verification trên deployment thật.
