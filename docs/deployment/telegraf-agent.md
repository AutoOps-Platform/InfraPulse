# HISTORICAL — Bước 4 Telegraf Agent & Installer

> **Source retirement — 2026-11-20:** legacy Gateway/Telegraf, old Compose/Prometheus provisioning and unmounted management editors are deleted from current source. Historical instructions below are records only, not runnable installation paths. Existing live lab/data/secrets are unchanged. Use the [current AWS architecture](<../architecture/aws-ssm-cloudwatch.md>).


> Archive only: all instructions, API-key flows, HTTP/CA changes and lab results below belong to the retired Telegraf/Gateway product. They are **not current AWS installation commands or proof of AWS/native support**. Historical documents remain; the first-party installer source is deleted and is not provisioned by current AWS images. The replacement is [hybrid SSM + CloudWatch](<../architecture/aws-ssm-cloudwatch.md>); use the [AWS runbook](<aws-lab.md>) and [current app flow](<grafana-app.md>). No old lab, service, certificate or volume is changed by this cleanup.

**Trạng thái:** đã triển khai source. Sau giai đoạn source-only, người dùng cho phép lab Linux riêng trên vm-1 ngày 2026-11-02: cài mới, update-config, TLS/auth cơ bản và Agent → Gateway → Prometheus đã có bằng chứng thực tế; xem [biên bản lab](<../testing/telegraf-agent-vm1-20261102.md>). Windows và checklist nghiệm thu đầy đủ vẫn chưa hoàn tất; không suy rộng kết quả lab thành production qualification.

## 1. Thiết kế và điều kiện

Agent là **Telegraf upstream**, không fork collector, không daemon Python bổ sung. Python 3.11+ standard library chỉ dùng trong lúc provisioning/render/report/lifecycle. Linux cần Bash, systemd, Python, `useradd`/`groupadd`; Windows cần Windows PowerShell 5.1+ hoặc PowerShell 7, Python 3.11+ cài thực sự (không Windows Store alias), quyền Administrator. Baseline cần qualification: Linux systemd amd64 và Windows Server amd64, Telegraf 1.38.2. Kiến trúc khác chỉ dùng binary đúng kiến trúc và phải kiểm thử riêng.

Installer không tải package, không gọi package manager và không tự lấy `latest`. Operator tải/extract **binary Telegraf chính thức**, xác minh nguồn phát hành/signature/checksum độc lập, rồi cung cấp đường dẫn executable và SHA-256 của **executable**, không phải archive. Installer băm lại bản copy trước khi chạy. Hash lấy từ chính file chưa có nguồn tin cậy không chứng minh tính xác thực. Bundle installer cũng phải được operator review và đặt ở thư mục tin cậy trước khi chạy quyền root/Admin. Không chạy bundle từ share/thư mục người dùng khác có quyền sửa.

Mỗi Server có bộ ID/key riêng. Không copy thư mục Agent đã cài sang máy khác. Không cần sửa source theo IP hay credential. Installer không mở firewall, không cài CA vào OS trust store và không sửa service Telegraf có sẵn.

### Bố cục source

- Linux installer (`../../agents/telegraf/linux/install.sh`, retired source), uninstaller (`../../agents/telegraf/linux/uninstall.sh`, retired source), lifecycle (`../../agents/telegraf/linux/lifecycle.py`, retired source), systemd unit (`../../agents/telegraf/linux/infrapulse-telegraf.service`, retired source).
- Windows installer (`../../agents/telegraf/windows/install.ps1`, retired source), uninstaller (`../../agents/telegraf/windows/uninstall.ps1`, retired source), lifecycle module (`../../agents/telegraf/windows/AgentLifecycle.psm1`, retired source).
- Provisioning/renderer/report (`../../agents/telegraf/common/agentctl.py`, retired source), agent template (`../../agents/telegraf/templates/agent.toml.tpl`, retired source), HTTP output template (`../../agents/telegraf/templates/output-http.toml.tpl`, retired source).
- Profile mirrors: linux-base (`../../agents/telegraf/profiles/linux-base.json`, retired source), windows-base (`../../agents/telegraf/profiles/windows-base.json`, retired source). Các file này chỉ mô tả seed hiện có, không được installer nạp để ghi đè profile từ Management.
- [Checklist nghiệm thu](<../testing/telegraf-agent-checklist.md>), [quyết định kỹ thuật](<../architecture/telegraf-agent-implementation.md>).

## 2. Chuẩn bị Management và credential

Theo [hợp đồng provisioning](<../contracts/agent-provisioning.md>) và [hướng dẫn Management](<management-backend.md>), operator dùng Admin/service assertion hợp lệ, **không dùng Agent key cho Admin API**:

1. `POST /api/v1/servers` với OS thực tế `linux` hoặc `windows`.
2. `POST /api/v1/servers/{server_id}/agents` để lấy Agent đã gắn Server.
3. Chọn profile `linux-base`/`windows-base` đã seed/publish; `PUT /api/v1/servers/{server_id}/profile` với `profile_version_id` cụ thể đã published, đúng OS. Installer không tự chọn bản latest.
4. `POST /api/v1/agents/{agent_id}/credentials` với `issuance_request_id` UUID mới và đủ scopes `metrics:write`, `provisioning:read`, `config:report`. Lưu API Key chỉ trả **một lần** vào file private hoặc password manager. Retry issuance cùng UUID có thể trả 409, không phục hồi plaintext. Không ghi key vào terminal history, ticket, logs hoặc script.
5. Chuẩn bị control origin và Gateway origin thực sự Agent truy cập được. HTTP chỉ dùng trên mạng private/VPN được kiểm soát: API key và telemetry truyền plaintext. HTTPS tùy chọn dùng trust store hệ thống, không có tham số CA riêng trong bộ cài. Đồng bộ thời gian/NTP trên Agent và central.

Installer gọi `GET /api/v1/agent/provisioning` Bearer. Kiểm tra response schema, OS, UUIDs, immutable version, SHA-256 canonical config, headers/protocol và Gateway origin phải trùng origin operator chỉ định. ID không lấy từ hostname hoặc nhập tùy ý. Khi cập nhật/cài lại, ID Agent/Server và Management origin phải khớp trạng thái cũ; muốn chuyển sang Agent khác phải uninstall có chủ đích rồi cài mới. Không tự tạo credential hoặc gọi DB/Gateway internal verification.

`POST /api/v1/agent/config-reports` gửi `applied` sau activation; Linux còn parse offline ba TOML và quan sát service active/running, PID/InvocationID/NRestarts ổn định hai giây trong budget ba giây. Windows hiện dựa service-manager acceptance và chưa có native runtime qualification. Gửi `failed` cho activation thất bại khi có receipt hợp lệ. Lỗi trước provisioning thành công không thể gửi receipt tùy ý. Các gate local này **không chứng minh semantic/plugin readiness, delivery hoặc Online**; report không phải heartbeat. Gateway chỉ công nhận metrics sau upstream acceptance. Agent version trong report là phiên bản installer/renderer, không phải binary Telegraf được chứng thực. Xem [regression và E2E Linux bổ sung](<../testing/grafana-app-vm1-20261103.md>); recovery lab vẫn còn mở.

## 3. HTTP central trên mạng private

Từ thay đổi 2026-11-18, bộ cài chấp nhận HTTP và không nhận/copy/render CA riêng. API key, scopes, checksum và identity/origin pin vẫn được kiểm tra; chúng **không mã hóa** HTTP và không chống được kẻ tấn công trên đường truyền. Chỉ dùng trên mạng private tin cậy/VPN với firewall giới hạn máy Agent. Không mở các cổng này ra Internet.

Compose gốc (`../../deploy/compose/compose.yaml`, retired source) vẫn mặc định bind loopback. Để chuẩn bị lab nhiều máy, đặt **IP private thật của central**, ví dụ dưới đây chỉ là minh họa:

```dotenv
AGENT_CONTROL_BIND=172.16.0.4
MANAGEMENT_HOST_PORT=3001
AGENT_GATEWAY_BIND=172.16.0.4
INGEST_HOST_PORT=8000
MANAGEMENT_AGENT_INGEST_BASE_URL=http://172.16.0.4:8000
AGENT_GATEWAY_ORIGIN=http://172.16.0.4:8000
INFRAPULSE_AGENT_CONTROL_URL=http://172.16.0.4:3001
```

`MANAGEMENT_AGENT_INGEST_BASE_URL` và `AGENT_GATEWAY_ORIGIN` phải khớp chính xác. Backend chỉ cho HTTP loopback hoặc IP private literal (RFC1918/IPv6 ULA), không public IP/FQDN. IP bind phải có trên host; origin phải truy cập được từ Agent, không dùng Docker hostname hay loopback cho Agent ở máy khác. `MANAGEMENT_HOST_PORT`/`INGEST_HOST_PORT` là cổng HTTP; `AGENT_CONTROL_PORT`/`AGENT_GATEWAY_PORT` chỉ dành cho TLS overlay.

**Lưu ý exposure:** bind HTTP Management ra LAN mở toàn bộ API có xác thực (Admin/internal/health), không chỉ hai Agent routes như listener TLS chuyên dụng. Giới hạn firewall/network trước rollout; bộ cài không tự làm việc này. PostgreSQL/Prometheus/Grafana vẫn giữ network/bind mặc định.

Sau khi operator bootstrap/migrate/seed, build plugin và review đầy đủ các biến Grafana, dùng base Compose cùng Grafana overlay, **không kèm TLS overlay** cho HTTP. Lệnh dưới đây dành cho operator chạy sau từ repository root, **chưa được thực thi trong phiên sửa source này**:

```sh
docker compose --env-file .env \
  -f deploy/compose/compose.yaml \
  -f deploy/compose/compose.grafana-app.yaml \
  up -d --build prometheus management ingest grafana
```

Phải bao gồm `ingest`: chỉ `up -d grafana` không khởi tạo/cập nhật Gateway khi cài mới hoặc đổi HTTP bind. Nếu đã có deployment TLS, cần kế hoạch migration riêng cho container/config và Agent identity; không chạy lệnh này lên stack cũ một cách mù quáng. Hướng dẫn enrollment/build Grafana: [runbook](<grafana-app.md>).

HTTPS vẫn được hỗ trợ bằng system trust, không `insecure_skip_verify` và không CA arguments. TLS overlay (`../../deploy/compose/compose.agent-tls.yaml`, retired source) cùng [runbook TLS trước đây](<central-vm2-step7.md>) được giữ như lựa chọn central riêng; CA health/scrape của central không phải CA phân phối bởi Agent installer. Không tự xóa cert hoặc đổi deployment TLS đang chạy. Cert phải được Python/Telegraf tin cậy qua hệ thống; bỏ CA flags không đồng nghĩa bỏ xác minh certificate.

Provisioning/report không redirect hoặc dùng proxy environment. Telegraf upstream `outputs.http` vẫn có thể theo redirect chuẩn; metrics origin phải là URL cuối không redirect. Origin pin là kiểm tra đích ban đầu, không thay firewall hay bảo vệ HTTP trước MITM. Không log Authorization hay đưa output TOML vào ticket.

## 4. Linux

Cài từ bundle đầy đủ, không chỉ copy một script. Key file root-owned 0600, không symlink/hardlink. Có thể bỏ `--key-file` lần đầu để nhập prompt ẩn nếu stdin tương tác. Không truyền plaintext qua option/env. Cài ban đầu:

```bash
sudo bash agents/telegraf/linux/install.sh \
  --management-url http://172.16.0.4:3001 \
  --gateway-origin http://172.16.0.4:8000 \
  --key-file /root/secure/infrapulse-agent.key \
  --telegraf-binary /root/reviewed/telegraf \
  --telegraf-sha256 '<SHA256_EXECUTABLE>'
```

Thay IP/port bằng origin đã review của central; không thêm CA options. Đường dẫn binary phải là file executable đúng Linux/architecture, không archive. Shell scripts gọi bằng `bash` rõ ràng; không cần tự ý staging Git để đổi executable bit. Bundle/file nguồn và mọi ancestor phải không symlink; đặt bundle ở thư mục thực như `/opt/...`, không `/home` bị redirect symlink trên hệ điều hành đặc thù.

Cấu trúc runtime cố định `/opt/infrapulse-agent/releases/<release>` + internal symlink `current`. Service `infrapulse-telegraf.service`; user/group chuyên dụng `infrapulse-telegraf`, không login, không supplementary groups. Key/state root0600; TOML có Authorization root:service0640, chỉ group chuyên dụng được đọc; service không sửa config/binary. Log private `/var/lib/infrapulse-agent/telegraf.log`, rotation 10MB, 3 archives; unit UMask0077. Dùng `/var/lib` để giữ kiểm tra ancestor root-controlled trên Ubuntu có `/var/log` root:syslog0775; không đổi quyền thư mục log chung của OS. Output service không đi ra shared journal để hạn chế lộ dữ liệu.

Config update (sau khi Admin đổi pin profile):

```bash
sudo bash agents/telegraf/linux/install.sh --update-config
```

Origins, key và checksum binary được tái sử dụng từ trạng thái được kiểm tra. Full reinstall/binary upgrade: chạy installer với cặp `--telegraf-binary` và `--telegraf-sha256` mới; không cần nhập lại origins/key nếu cùng installation. Renderer tạo lại toàn bộ allowlisted config, không merge custom plugin thủ công. Không tự poll profile hoặc auto-upgrade.

**Chuyển từ bộ cài CA cũ:** Linux lifecycle metadata mới là schema 2 (không CA). Metadata schema 1 không được tự migrate. Với cả hai OS, đổi Management origin (kể cả HTTPS → HTTP) vẫn bị từ chối để giữ identity pin. Giữ API key/IDs riêng tư, dùng uninstaller trong **concrete release cũ** đã kiểm tra ownership, rồi cài bundle mới với cùng key/IDs và origin HTTP đã review. Không sửa state để vượt guard, không xóa cert/CA đang được dịch vụ khác dùng. Đây là hướng dẫn bảo trì riêng, không tự thực hiện trên máy đang chạy.

**Bản thử nghiệm trước khi sửa đường dẫn log:** nếu đã cài thành công unit dùng `/var/log/infrapulse-agent`, bundle mới không nhận nó là unit hiện tại vì kiểm tra ownership so sánh chính xác bytes. Chưa có migration in-place từ layout cũ. Giữ credential/IDs ở nơi private, dùng `bundle/linux/uninstall.sh` trong concrete release cũ đã cài, không đi qua symlink `current` (khi kiểm tra ancestry cũ vẫn hợp lệ), rồi cài bundle mới với cùng credential. Nếu unit/ancestry đã thay đổi hoặc không xác định được release cũ, dừng để operator rà soát và recovery; không sửa unit/permission guard để ép nhận installation. Không áp dụng quy trình này cho installation mới đang dùng `/var/lib`.

Key rotation: cấp successor qua Admin API, rồi `--update-config --key-file /root/secure/successor.key`; giữ Agent/Server cũ. Cửa sổ overlap tối đa 300s của backend là ngắn: chuẩn bị sẵn bundle/binary/trust, phối hợp activation rồi revoke key cũ. Gateway positive cache có thể giữ proof tối đa 30s. Không xóa file nguồn private key của operator tự động; operator cần quản lý nó riêng.

Gỡ bỏ:

```bash
sudo bash agents/telegraf/linux/uninstall.sh
```

Stop/disable service, xóa đúng unit/release/config/keys/logs thuộc installer; account giữ lại để tránh tái sử dụng UID gây rủi ro. Không gỡ Telegraf bên ngoài hay tự xóa account. Backend credential revoke và trạng thái Server/Agent là thao tác Admin riêng.

## 5. Windows

Dùng PowerShell elevated, policy chạy script theo quy định tổ chức (không cần bypass). Ví dụ đường dẫn bundle ở `C:\Deploy\InfraPulse` và Python ở `C:\Program Files\Python312\python.exe`; thay đường dẫn thực. Key file chỉ SYSTEM, Administrators hoặc chính user operator được đọc, không inherited `Users`/`Authenticated Users`/`Everyone`. Có thể dùng `-PromptKey` thay `-KeyFile`, input SecureString rồi ghi tạm trong root private.

```powershell
& .\agents\telegraf\windows\install.ps1 `
  -ManagementUrl 'http://172.16.0.4:3001' `
  -GatewayOrigin 'http://172.16.0.4:8000' `
  -KeyFile 'C:\Secure\InfraPulse\agent.key' `
  -TelegrafBinary 'C:\Secure\Reviewed\telegraf.exe' `
  -TelegrafSha256 '<SHA256_EXECUTABLE>' `
  -PythonExecutable 'C:\Program Files\Python312\python.exe'
```

Native Telegraf service tên `infrapulse-telegraf`, Automatic + recovery restart. Không đụng service mặc định `telegraf`. Root cố định dưới system Program Files: `InfraPulse Agent`; protected release directories chứa binary/config/key/state/bundle. Không junction/symlink/reparse points. ACL SYSTEM/Administrators-only; service LocalSystem là lựa chọn deployment rõ ràng, quyền cao hơn Linux để dùng Windows counters/SCM upstream. Muốn least-privilege Windows account cần thiết kế/qualification riêng, chưa tự áp đặt gMSA.

```powershell
# Sau khi Admin gán profile published khác:
& .\agents\telegraf\windows\install.ps1 -UpdateConfig -PythonExecutable 'C:\Program Files\Python312\python.exe'
# Rotate key, cùng IDs:
& .\agents\telegraf\windows\install.ps1 -UpdateConfig -KeyFile 'C:\Secure\InfraPulse\successor.key' -PythonExecutable 'C:\Program Files\Python312\python.exe'
# Uninstall:
& .\agents\telegraf\windows\uninstall.ps1
```

Reinstall/upgrade binary dùng cặp `-TelegrafBinary`/`-TelegrafSha256`, không `-UpdateConfig`. Native argument quoting được thực hiện trong module để giữ nguyên quoted SCM binPath trên PowerShell 5.1; cần nghiệm thu thực tế trên cả 5.1/7. Uninstall xóa owned service + EventLog source + mọi release/credential/log. Giữ root rỗng với owner marker/lock để không tạo race khi hai tiến trình lifecycle chạy đồng thời. Không tự revoke backend.

## 6. Monitoring profiles và Remote Write

Published profile từ NestJS là nguồn duy nhất. Schema v1: interval 5–300s (seed 15s), bốn boolean groups `cpu`, `memory`, `disk`, `network`. Basic system/uptime luôn bật, không tùy ý tạo endpoint, exec, script hay plugin khác từ profile.

| Nhóm | Linux | Windows |
| --- | --- | --- |
| Uptime/basic | `inputs.system`: uptime/load/CPU count/users | `win_perf_counters` System: System Up Time/Processes/Threads/Processor Queue Length |
| CPU | `inputs.cpu`, total CPU, active usage | Processor `_Total`, CPU/User/Privileged/Idle counters |
| RAM | `inputs.mem`, `inputs.swap` | `inputs.mem`: total/available/used/percent |
| Disk | `inputs.disk`, `inputs.diskio` | LogicalDisk free space/MB, read/write bytes/s, queue |
| Network | `inputs.net` | `inputs.net` native Windows interface names |

Options Linux `disk.exclude_filesystems` → `ignore_fs`, `disk.mount_points` → mount filter; Windows `disk.include_volumes` → PDH LogicalDisk instance names như `C:` (không `C:\`), mặc định `*`, bỏ `_Total`. `network.interfaces` dùng native interface names/glob của Telegraf trên cả hai OS, không phải PDH sanitized names. Không cho plugin options ngoài schema; chuỗi được validate/escape, canonical checksum tính trên JSON config chứ không hash TOML. Lưu ý mount_points chỉ lọc capacity `inputs.disk`, không lọc block-device IO `inputs.diskio`. Include list rỗng dùng mặc định Telegraf/all; muốn tắt nhóm dùng boolean `false`.

Windows counters dùng English names với `UseWildcardsExpansion=true`, `LocalizeWildcardsExpansion=false` để giữ field names ổn định; cần nghiệm thu máy localized/missing counters/ổ mount đặc biệt. Không giả định metric names Windows bằng Linux.

HTTP output `data_format="prometheusremotewrite"` tự marshal protobuf **và raw-block Snappy**; `content_encoding="identity"` của HTTP plugin tránh gzip lần hai. Headers khai báo `Content-Type: application/x-protobuf`, `Content-Encoding: snappy`, `X-Prometheus-Remote-Write-Version: 0.1.0`, User-Agent, Bearer và hai identity headers được provisioning xác nhận. Global labels `server_id`/`agent_id` trùng key binding; Gateway vẫn là authority, reject mismatch. Không gửi Prometheus trực tiếp.

Batch 100 **Telegraf metrics**/buffer1000 giới hạn cục bộ, không đồng nghĩa 100 protobuf series. Nhiều fields/volumes/NICs vẫn có thể chạm 5000 series/1MiB compressed/8MiB decompressed. Tuning cần measured load rồi mới thay source/profile; không tăng Gateway limits tùy tiện. Bộ đệm Telegraf hiện in-memory, restart mất pending buffer; outage dài có thể drop oldest. Retry chuẩn Telegraf không là durable exactly-once, và 502/503/504 có thể uncertain upstream acceptance. Không triển khai collector hoặc queue riêng.

## 7. Vận hành lỗi, rollback và report retry

- 401: key invalid/expired/revoked; 403: thiếu scope/identity mismatch; 409: profile chưa gán/published/receipt không hợp lệ. Sửa qua Management; không tự xin key mới.
- HTTPS/trust/hostname/pin mismatch: kiểm tra DNS/route/firewall và origins; nếu dùng HTTPS, kiểm tra SAN/chain qua system trust, không bỏ TLS verify hoặc dùng lại CA flags đã bỏ.
- Binary mismatch/sai OS/arch: cung cấp đúng reviewed binary/hash. Installer không chạy `--version`/`--test` như bước probe.
- Foreign service, unsafe ACL/ownership, symlink/reparse/drop-in, Agent ID drift: fail closed, không tự ghi đè. Cần Admin inspect và quyết định bảo trì.
- Nếu activation thất bại, installer cố phục hồi service/config trước đó và báo lỗi; rollback thất bại giữ dữ liệu để Admin phục hồi, không xóa mù quáng. Lệnh SCM/systemd thành công chỉ là service-manager acceptance.
- Nếu `applied` report lỗi sau activation, giữ service mới và state `report_pending=true`, cảnh báo rõ; không rollback service vì lỗi control plane. Linux giữ release failed/pending receipt cho retry; previous acknowledged release được purge sau local success. Windows có thể purge failed candidate sau failed report attempt; nếu report không đến backend phải GET provisioning lại và reinstall để tạo kết quả report mới; không fabricate report applied.

Ví dụ retry Linux, chọn **concrete release** từ current pointer đã kiểm tra, không vô tình report version khác:

```bash
sudo python3 -I /opt/infrapulse-agent/releases/RELEASE/bundle/common/agentctl.py report \
  --state /opt/infrapulse-agent/releases/RELEASE/state.json \
  --key-file /opt/infrapulse-agent/releases/RELEASE/api-key --result applied
```

Ví dụ Windows, elevated và thay RELEASE bằng directory thực trong active state:

```powershell
& 'C:\Program Files\Python312\python.exe' -I 'C:\Program Files\InfraPulse Agent\releases\RELEASE\bundle\common\agentctl.py' report `
  --state 'C:\Program Files\InfraPulse Agent\releases\RELEASE\state.json' `
  --key-file 'C:\Program Files\InfraPulse Agent\releases\RELEASE\api-key' --result applied
```

Chỉ retry `applied` cho release thực đã được activate; dùng `failed` cho attempted release activation thất bại. Sau khi rotate/revoke credential của pending receipt, report retry với key cũ có thể không còn được chấp nhận. Không rollback pin backend tự động.

Linux có single-writer lock + transaction journal. SIGINT/SIGTERM rollback best-effort; **SIGKILL/power loss không có đảm bảo rollback**. Journal `.transaction` làm lần sau fail closed. Admin cần đọc protected journal, kiểm tra concrete `current`/unit/service/release, phục hồi coherent state rồi mới xóa journal sau khi có backup và xác nhận; không dùng `rm -rf` theo path trong journal không kiểm tra. Windows chưa có crash-recovery journal: nếu mất điện giữa SCM change và active pointer update có thể ownership check từ chối; Admin đối chiếu SCM ImagePath với protected releases và active state trước khi phục hồi. Không có auto recovery suy đoán hoặc đảm bảo giao dịch across filesystem+service manager.

Logs chứa thông tin host/URL/counter và error body, cần coi là dữ liệu nhạy cảm. Không bật Telegraf debug/print config, không dump output TOML, không thu thập Authorization vào tickets. Installer chỉ in finite local diagnostic codes, không in exception/body từ API/native commands; service log xoay vòng private dùng để điều tra chi tiết. `outputs.http.headers` dùng secret type của Telegraf để giảm lộ key; bảo vệ runtime files/credential backups, không dựa vào redaction như ranh giới duy nhất. Dọn/revoke credential cũ và failed/pending releases có chủ đích; uninstall purge owned copies nhưng không xóa key file nguồn của operator.

## 8. Nguồn tham khảo upstream

Chỉ đọc source, **không chạy Telegraf**: [HTTP output](<https://github.com/influxdata/telegraf/blob/v1.38.2/plugins/outputs/http/http.go>), [Remote Write serializer](<https://github.com/influxdata/telegraf/blob/v1.38.2/plugins/serializers/prometheusremotewrite/prometheusremotewrite.go>), [Windows service implementation](<https://github.com/influxdata/telegraf/blob/v1.38.2/cmd/telegraf/telegraf_windows.go>), [Windows counters](<https://github.com/influxdata/telegraf/blob/v1.38.2/plugins/inputs/win_perf_counters/README.md>). Không sử dụng endpoint, key, patched binary hoặc agent protocol từ dự án tham khảo cũ.
