# Bước 6 — Source/build verification 2026-11-03

## Phạm vi

Chỉ repository/local compiler và offline transport/crypto checks. **Không deploy plugin, không gọi Grafana/vm-1/Central Stack thật, không cài/restart Agent, không Agent E2E hoặc gửi metrics.** Không thay đổi backend API, Prometheus/Gateway/dashboards. Các kiểm tra Linux Agent/Grafana từ Bước4/5 không được dùng làm bằng chứng plugin mới đã chạy.

## Đã kiểm tra

- Đọc toàn bộ introduction và exact DTO/controller/auth/provisioning/dashboard/Compose contracts. Graph exploration + coverage được bổ sung bằng exact source vì metadata thay đổi/deploy subtree không indexed.
- Frontend `pnpm typecheck` và `pnpm lint` (`--max-warnings 0`) hoàn tất, không lỗi TypeScript hoặc ESLint nguồn ứng dụng.
- `pnpm build` hoàn tất bằng webpack5.112.2, metadata đúng ID/version, public-path loader của Grafana có trong AMD artifact. Root extension sửa entry regex hỗ trợ cả Windows/POSIX mà không sửa scaffold base.
- Official scaffold7.17.0 được tạo bằng Linux container cục bộ; bỏ UI ví dụ/mock/E2E harness. Node24 native TypeScript loader (`--disable-interpret`) tránh lỗi hook ts-node cũ; replace-in-file plugin1.0.6 tương thích webpack5.
- `go test ./... -count=1` hoàn tất; 14 top-level test functions với nhiều negative/parameterized cases: real generated ES256 signature verification, strict identity/context/time/auth policy, JWKS rotation/cache/revocation/throttle/concurrency, HTTP loopback opt-in, request-bound Ed25519/raw target/query/body/fresh nonce, route allowlist và safe error projection. Đây không phải full-stack integration tests.
- `go vet ./...` hoàn tất; Go cross-compile tạo Linux/amd64 ELF executable `gpx_infrapulse_linux_amd64`. Toolchain local Go1.27.1, CGO disabled; SDK0.298.0, JWT5.3.1 theo dependency graph thực tế.
- Compose base + Agent TLS + App overlays parse/merge offline bằng public `.env.example`, `--no-interpolate --no-env-resolution`; exact unsigned-ID exception, dist readonly và bốn provisioning-family readonly mounts được kiểm tra. Không đọc private `.env`, không chạy services.
- Independent source review các trang/client/Go/auth/Compose/build/docs đã đóng hai Important (profile pin/preview race và lost-secret recovery gate), list invalidation và provisioning nested-mount concern. Review không chứng minh runtime, dependency security toàn diện hoặc upstream production readiness.

## Không che giấu lỗi đã gặp

Initial native scaffold CLI không hỗ trợ Windows; reference được tạo đúng official tool bằng Linux container. Pnpm11 không đọc build approvals trong package.json nên chuyển sang explicit workspace allowBuilds; SWC native build chạy sau approval. Initial webpack build phát hiện old helper/plugin loader và Windows public-path issue; đã chỉnh pins/extension rồi build lại. Static verification script từng giả định Compose environment là map (thực tế list khi no-env-resolution) và plugin version ở top level (thực tế info.version); sửa checker, không sửa product data để làm check pass.

Build vẫn có Node `MODULE_TYPELESS_PACKAGE_JSON` warning từ official scaffold TypeScript modules; không phải build error. Dependency graph có upstream peer/deprecation warnings (Grafana React19 với một số legacy vendors, OpenTelemetry peer range, ESLint9 line); application lint sạch không có nghĩa dependency audit đã sạch. Không tự hạ React xuống18 trái peer requirement của Grafana13.3.0. Dockerfile artifact target và arm64 target đã chuẩn bị nhưng chưa chạy build/khởi động riêng trong lần này.

## Các gate còn lại

[Checklist runtime](<grafana-app-checklist.md>) là tiêu chí kiểm thử sau: signed header availability/org enrollment/JWKS, key permissions/trust/rotation, real Grafana app startup/browser routes/subpaths/themes/accessibility, role integration và request replay, lost-response UI, Windows/Linux onboarding, cross-Agent dashboard isolation. Đặc biệt upstream Grafana13.3.0 OSS signing-key service vẫn được ghi đang phát triển/chưa production-ready: explicit opt-in không giải quyết gate đó.

Source chính: [plugin](<../../apps/grafana-app/README.md>), [deployment guide](<../deployment/grafana-app.md>), [Compose overlay](<../../deploy/compose/compose.grafana-app.yaml>). Không stage/commit/push hoặc rollout trong Bước6 này.
