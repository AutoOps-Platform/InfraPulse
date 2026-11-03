# InfraPulse Grafana App

React/TypeScript App Plugin + Go resource adapter, đặt duy nhất tại `apps/grafana-app`. Không phải Admin Web riêng, datasource mới hoặc bộ biểu đồ mới.

## Chức năng

- Overview từ inventory thật: số Server theo trạng thái telemetry, Agent/lifecycle, độ đầy đủ và thời điểm quan sát. Scan phân trang có giới hạn và không phải snapshot transaction.
- Servers: tìm theo **prefix tên** đúng API, lọc/phân trang cursor, tạo/sửa/chi tiết/archive có xác nhận.
- Agents: Server liên kết, lifecycle, version do Agent báo cáo, last seen và chất lượng telemetry.
- Install Agent: chọn Server/OS, đăng ký Agent, pin published profile, cấp key một lần, đọc provisioning thật và tạo hướng dẫn installer Windows/Linux hiện có.
- API Keys: metadata Admin-only, cấp/rotate/revoke, operation UUID và xử lý kết quả không chắc chắn; secret chỉ trong modal tạm thời.
- Monitoring Profiles: profile/version/config/checksum read-only, gán **đúng version** cho Server.
- Monitoring: mở dashboard Bước 5 theo OS, truyền cả `server_id` và `agent_id`; không dựng chart React.

## Bắt đầu

Đọc [hướng dẫn triển khai](<../../docs/deployment/grafana-app.md>) trước khi bật plugin. Backend yêu cầu enrollment thật của Grafana instance/org, public admin trust trong NestJS và private key riêng ở runtime Grafana. Không đưa secret vào frontend hoặc build arguments.

```sh
cd apps/grafana-app
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm build
pnpm build:backend         # Linux amd64, Go >=1.26.5; đã dùng Go1.27.1
# pnpm build:backend arm64 # target khác, cần kiểm thử trên runtime tương ứng
```

Node24.x và pnpm11.24.0. Frontend dùng React19 theo peer requirement của Grafana13.3.0. Build config dựa trên **official `@grafana/create-plugin`7.17.0**, không dùng scaffold UI mẫu/mock trong production. Generator chính thức không hỗ trợ Windows native; đã tạo reference bằng Linux container cục bộ, còn compiler Node/Go có thể chạy tại host.

Tùy chọn artifact build Linux (không khởi chạy Grafana):

```sh
cd apps/grafana-app
docker build --platform linux/amd64 --target artifacts --output type=local,dest=dist .
```

Artifacts gồm `dist/module.js`, metadata/assets và `dist/gpx_infrapulse_linux_amd64`. Không commit artifacts, dependencies hoặc private key. Khi `pnpm dev` rebuild frontend, Go thay đổi phải build lại riêng. Go binary mới cần restart Grafana để nạp process mới; không tự hot-reload backend.

## Auth không phải browser role

Browser chỉ gọi cùng-origin `/api/plugins/infrapulse-infrapulse-app/resources/...`. Adapter xác minh **server-set `X-Grafana-Id` ES256 JWT** bằng JWKS của instance được enrollment; đối chiếu issuer/org/namespace/type/role và PluginContext. Subject là `user:<database ID>` đã xác minh, không username/email. Sau đó ký assertion **Ed25519 mới**, ràng buộc method, outbound target/query và raw body; NestJS vẫn quyết định authentication, RBAC, DTO, lifecycle và nghiệp vụ.

**Giới hạn bắt buộc:** nguồn Grafana OSS13.3.0 vẫn đánh dấu signing-key service đang phát triển/chưa production-ready. Chế độ này phải opt-in rõ bằng `INFRAPULSE_ACCEPT_EXPERIMENTAL_IDENTITY=true`; đây không phải bằng chứng đã đạt production acceptance. Thiếu/không hợp lệ identity hoặc JWKS làm request thất bại đóng, không fallback. Database/instance replacement cần enrollment/context mới. Chi tiết, key rotation và HTTP development boundaries ở hướng dẫn triển khai.

## Phạm vi xác minh

Build/lint/typecheck và kiểm tra offline của adapter không chứng minh onboarding hoặc Grafana runtime. Sau khi người dùng cho phép lab riêng, đã có [bằng chứng E2E Linux/UI/API](<../../docs/testing/grafana-app-vm1-20261103.md>), nhưng **recovery/teardown còn chờ operator, Windows PDH/service và production acceptance chưa hoàn tất**. Xem [checklist](<../../docs/testing/grafana-app-checklist.md>). Không dùng dữ liệu mock thay API trong ứng dụng. Tests crypto/HTTP transport của Go là kiểm tra offline; không gọi đó là Agent E2E.
