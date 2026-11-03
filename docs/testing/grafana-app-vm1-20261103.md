# Bước 6 — Biên bản E2E vm-1, ngày 2026-11-03

## 1. Kết luận và trạng thái bàn giao

**Kết quả: PARTIAL — chưa hoàn tất recovery/teardown, chưa production acceptance.** Báo cáo tổng hợp các quan sát đã có, không phải kiểm tra trạng thái VM mới tại thời điểm đọc. Người dùng đã cho phép E2E trên lab riêng sau giai đoạn source-only, nhưng sau sự cố reboot đã yêu cầu **không tiếp tục thử nghiệm bằng reboot VM**; mọi thao tác reboot tương lai cần trao đổi và xác nhận riêng.

Đã có luồng thực: **Grafana user → App Plugin → NestJS → cấp credential/provisioning → Linux Telegraf → HTTPS Gateway → Prometheus → dashboard theo đúng Server/Agent**. Windows mới kiểm tra inventory/UI/API/hướng dẫn, **không có máy Windows được chỉ định để chạy service/PDH/metrics thật**.

Bằng chứng: [JSON allowlisted](<evidence/grafana-app-vm1-20261103.json>), [ảnh Monitoring](<evidence/grafana-app-monitoring-vm1-20261103.png>). JSON là bản chép có chọn lọc từ kết quả browser/SSH đã quan sát, không phải export toàn bộ raw logs. Log, key và backup nhạy cảm giữ root-private trên VM; không đưa password, API Key, private PEM, session cookie, assertion hoặc output TOML vào báo cáo.

**Điểm còn mở quan trọng:** Agent đang cài ở lần kiểm tra cuối vẫn là định danh thử nghiệm; chưa khôi phục Agent ban đầu. Records/key/tài khoản thử nghiệm và cleanup helper/routing chưa được xác nhận hoàn tất. Không đánh dấu E2E hoàn thành chỉ vì build pass hoặc service active.

## 2. Môi trường và ranh giới

- Ubuntu24.04 x86_64, 2vCPU/~4GiB; Grafana13.3.0 và Telegraf1.38.2. Năm container hiện có: Grafana, Management, Gateway, PostgreSQL, Prometheus.
- Plugin `infrapulse-infrapulse-app`, org1; real Grafana ID token/JWKS và assertion Ed25519 mới theo request. Không dùng username/header browser làm principal, không dùng mock API production.
- Identity mode upstream experimental được opt-in **chỉ cho lab**. Không bỏ maturity gate hoặc coi đó là production guarantee.
- Không thêm public application port, tài nguyên cloud, collector khác hay notification ra ngoài. Private notification sink chỉ ở Docker bridge của lab; login/key-transfer helper chỉ loopback và SSH tunnel.
- Baseline source commit `b6f7fc475fb3eab359d6622195a4e1ab37520f1f`; source Bước6 và regression fixes chưa stage/commit/push.

| Vai trò thực | Subject đã xác minh | Nest role | Kết quả |
| --- | --- | --- | --- |
| Grafana Admin | `user:1` | Admin | `/me`200, các mutation onboarding thực |
| Grafana Viewer | `user:2` | Viewer | Đọc inventory200; mutation, credential metadata và preview403 |
| Grafana Editor | `user:3` | Operator | Đọc inventory200; mutation và credential metadata403 |
| Anonymous | Không có | Không có |401 |

Browser giả `X-Grafana-Id`/role/user không đổi principal Viewer thành Admin. Đây là quan sát trong org1 lab, không phải full multi-org/instance-replacement qualification.

## 3. UI/API đã quan sát

| Nhóm | Bằng chứng thực | Giới hạn |
| --- | --- | --- |
| Overview/navigation | Bảy trang render; scan ban đầu1 Server Online/1 Agent, có non-atomic/as-of và Unknown | Chưa thử scan lớn/partial cap |
| Servers | Tạo/sửa/detail thật; reserved metadata field bị chặn;19 pagination fixtures, Page1=20/Page2=1, không overlap, Previous giữ thứ tự | Archive/retire acceptance chưa hoàn tất |
| Search/filter | Literal prefix khác substring; Windows filter đúng1 fixture; A→B→A reset cursor | Chưa full filter/accessibility/race matrix |
| Agent lifecycle | Disable Windows inventory Agent qua xác nhận làm key revoked; enable lại không hồi sinh key; Unknown/never_seen vẫn đúng | Không phải Windows Service test |
| Profiles | Pin published version đúng OS; preview lấy version/checksum thật | Chưa thử lịch sử >100 phiên bản |
| Profile race | Thay pin thật sau explicit acceptance; modal báo conflict, không hiện lệnh cài và khóa retry; trả pin cũ, revoke key tạm | Không giả lập response backend |
| Dependency outage | Dừng Management có recovery timer độc lập30s; adapter503 `management_unavailable`, UI finite error/Retry read; `/me`200 trở lại sau phục hồi | Không full fault/soak matrix |
| Adapter boundaries | Internal/authoring route không allowlist, duplicate query, UUID sai đều bị chặn | Không thay audit bảo mật toàn diện |

## 4. Credential và onboarding

- Add Linux Server → Register Agent → pin `linux-base` publishedv1 → explicit acceptance → issue đủ ba scopes → actual provisioning preview. Không ghi key vào lệnh cài, URL hay browser storage.
- Secret xuất hiện một lần trong password modal, chuyển riêng vào root-private file để cài Agent; sau đóng modal không còn trong DOM/URL/localStorage/sessionStorage ở các bước được kiểm tra. Không snapshot khi modal chứa key. Clipboard không dùng trong lab nên chưa có clipboard acceptance.
- Replay cùng issuance UUID trả409 `secret_already_issued`, chỉ safe metadata, `Cache-Control: no-store`; không trả lại plaintext.
- Expiry quá khứ bị chặn; cancel confirmation không tạo credential.
- Rotation cấp successor, cập nhật native Agent bằng key file private thành công. Trước cutoff, hai key provisioning200; sau cutoff quan sát19:05:46Z: old key control/Gateway401, successor control200. Probe Gateway successor trả400 do **body rỗng không hợp lệ**, không gọi đó là metrics-write success; metrics thật được chứng minh riêng.
- Lost-response case chuyển **đúng một request thật**, thấy201 rồi bỏ body mà không đọc secret. UI giữ operation UUID, báo uncertainty và khóa operation mới. Inspect metadata → revoke inaccessible credential → GET metadata mới xác nhận revoked → explicit acknowledgement mới cho chủ động reset operation; không tự cấp replacement.
- Windows inventory onboarding dùng published `windows-base`, actual preview và flags PowerShell đúng; Monitoring chọn `infrapulse-windows-host` với hai IDs. Không dùng kết quả này để tuyên bố đã cài Windows Agent.

## 5. Linux Agent và Monitoring thật

Agent baseline được gỡ có kiểm soát để nhường một service cho định danh test; credential/backup baseline được giữ riêng. Installer mới dùng official Telegraf executable đã kiểm SHA256 độc lập và HTTPS/private CA verification, không bỏ TLS.

| Định danh | Server | Agent |
| --- | --- | --- |
| Baseline cần khôi phục | `76c61c9a-e845-474e-932b-c90b6ee86920` | `4e7ea3d4-da72-49ee-a35a-539d3e6865e2` |
| Linux test | `7e38e852-1840-4b0c-a4d1-e36a4fe31e68` | `88638863-76ff-40e2-95c4-8cdb4737ef18` |

Observed Linux: applied report thành công, `report_pending=false`, unprivileged service active, Management Online/healthy/recent_success. Prometheus có309 series khớp IDs và7 query checks có sample cho CPU/RAM/disk/network/uptime. Link từ plugin mở đúng UID `infrapulse-linux-host`, cả `var-server_id` và `var-agent_id`; dashboard hiển thị metrics thật. Sai cặp Server/Agent không được cấp dashboard link hợp lệ. Không phải simultaneous multi-host qualification.

Đã thử reinstall/update-config; wrong binary hash, identity drift, CA không tin cậy và concurrent lock đều bị từ chối, không đổi current pointer. Malformed TOML/unknown input plugin đã dẫn tới regression fix và được kiểm tra lại trên VM: syntax lỗi bị chặn trước pointer switch; config đúng TOML nhưng plugin sai làm activation fail và phục hồi pointer/service cũ; transaction cleared; valid update sau đó thành công.

![Monitoring từ Management thực trước reboot; không chứa credential](<evidence/grafana-app-monitoring-vm1-20261103.png>)

## 6. Bốn lỗi runtime đã sửa

1. **Grafana lọc environment của backend process:** [Compose overlay](<../../deploy/compose/compose.grafana-app.yaml>) thêm exact plugin-ID forwarding. Cơ chế upstream forward **toàn bộ container env** tới backend được tin cậy đó, không chỉ các biến `INFRAPULSE_*`; giữ cảnh báo ở [deployment](<../deployment/grafana-app.md>).
2. **Audience encoding thực khác assumption:** [identity verifier](<../../apps/grafana-app/pkg/plugin/identity.go>) nhận exact org dưới dạng string hoặc singleton array của JWT; vẫn bắt buộc signature/alg/issuer/org/subject/namespace/role/time. [Regression](<../../apps/grafana-app/pkg/plugin/identity_test.go>) có RED→GREEN cho singleton string và negatives wrong/multiple/duplicate/nonstring.
3. **Script Linux không executable:** [instructions](<../../apps/grafana-app/src/components/ProvisioningPreview.tsx>) dùng `sudo bash ./install.sh`, không suy ra executable mode từ archive Windows. [Deployment guards](<../../apps/grafana-app/tests/deployment.test.mjs>) kiểm tra regression.
4. **Installer báo applied quá sớm:** [lifecycle](<../../agents/telegraf/linux/lifecycle.py>) parse riêng ba TOML trước activation, mỗi file tối đa256KiB; deferred `tomllib` giữ finite Python-version guard. Quan sát active/running, PID/InvocationID/NRestarts ổn định hai giây trong budget ba giây trước report và khi phục hồi service từng active. [Regression startup](<../../agents/telegraf/tests/test_linux_startup.py>) kiểm tra syntax/liveness/transactions/rollback.

Không đổi unit `Type=simple` hoặc nới ownership/unit-byte guards. TOML bound là **per file**, không phải parser CPU/RAM sandbox; hai giây liveness không chứng minh semantic/plugin readiness, tồn tại lâu dài, delivery hay Online.

Fresh verification đã có: typecheck/build, lint zero warnings, Node2/2, Go tests/vet/backend build, Linux22/22 trong local isolated container và trên VM; source-only review độc lập không còn scoped findings ở bốn fixes. Đây không thay các gate runtime chưa làm.

## 7. Cảnh báo đã thử, không gây resource pressure

Nạp đúng bốn product rules. Runtime evaluator báo health `ok`; CPU/RAM/disk có Normal instances. Baseline Agent mất metrics trong lúc dùng test Agent đã tạo MetricsStale firing; private webhook nhận firing lúc18:38:37Z. Không gửi email/Telegram/webhook bên ngoài, không tạo CPU/RAM/disk pressure. Chưa xác minh resolution sau baseline recovery, full NoData/Error/missing-series/routing hoặc notification durability.

## 8. Sự cố reboot và recovery đang chờ

Lúc02:13:49+07, sau khi ghi nhận service enabled và năm container `unless-stopped`, assistant đã yêu cầu **reboot toàn VM** để thử autostart. Sau đó hai SSH attempts báo authentication failed. Người dùng cho biết đã phải **đặt lại mật khẩu thủ công**. Không coi đây là E2E pass và không suy đoán nguyên nhân đổi/trạng thái credential nếu chưa có log hệ thống.

Sau khi người dùng khôi phục truy cập, kiểm tra chỉ đọc xác nhận SSH vào được, Docker active và Agent active/running, `NRestarts=0`; **không xác nhận được fresh metrics/định danh baseline đã khôi phục**. `sudo -n` yêu cầu password. Không đổi password, `sshd`, sudoers hay cố vượt quyền; không yêu cầu secret trong chat.

Private backups đã được tạo trước rollout tại:

```text
/srv/infrapulse-lab-20261102/step6-20261103/backup/
```

Gồm DB dump, Grafana data snapshot, Agent files và cấu hình gốc; chưa thực hiện DB/filesystem restore. Recovery đầy đủ ban đầu chỉ chạy help, **chưa chạy `--apply`**. Người dùng sau đó đã chọn **Agent-only, không restart Grafana**: chỉ khôi phục đúng baseline Agent rồi kiểm tra receipt/service/fresh metrics. Bản Agent-only không dừng helper, không sửa routing/evaluator, không xóa records/tài khoản/secret copies hoặc restart container khác; các phần đó được giữ riêng trong danh sách còn mở. Không chạy lệnh recovery đầy đủ cũ. Agent-only vẫn cần operator tự chạy sudo trong terminal; chưa được thực thi tại lần cập nhật báo cáo này. Không tự chạy lại sau `STOP`; phải đọc receipt để biết partial state.

**Cập nhật 2026-11-03 theo báo cáo của người dùng:** sau khi chọn Agent-only, DSH read-only SSH preflight bị timeout; probe TCP không xác thực chỉ thấy cổng22 kết nối được nhưng không nhận banner trong timeout ngắn. Người dùng cũng cho biết không SSH vào được. Nguyên nhân hiện tại chưa xác định; không suy đoán password, VM health hoặc app load. Candidate Agent-only chỉ mới chuẩn bị/rà soát ở máy local, **chưa upload và chưa chạy**. Sau yêu cầu không reboot, không có reboot/restart service/container mới; chỉ có kiểm tra đọc, upload bản recovery đầy đủ cũ/chạy help trước đó và chuẩn bị tài liệu/script local. Không thử kết nối/kiểm thử VM thêm trong lúc bàn giao báo cáo.

**Việc chưa làm:** baseline restoration; retire/archive chính xác fixture IDs và reconcile/revoke test credentials; xóa hai Grafana lab users; xác nhận helper/tunnel/local routing cleanup. Không restore toàn database để che các record này hoặc làm mất audit. Không bật alert routing production từ cấu hình sink lab.

## 9. Gate còn thiếu

- Windows target riêng được chỉ định và cấp quyền: service/PDH/metrics/TLS/update/rollback/uninstall; không dùng workstation của người dùng thay thế.
- Production plugin signing, HTTPS/Grafana deployment và upstream identity maturity review; multi-org/instance replacement/JWKS rotation/cache-expiry/revocation/subpath matrix.
- Full UI accessibility/theme/responsive/request-race, long profile pagination, simultaneous multi-host isolation, sustained load/soak và alert fault/recovery matrix.
- Recovery/teardown phải được xác minh trước khi đóng mục tiêu E2E. [Checklist tổng](<grafana-app-checklist.md>) giữ unchecked các mục gộp có phần chưa đạt.
