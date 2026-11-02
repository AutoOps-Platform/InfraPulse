# Step 4 — Checklist kiểm thử sau khi có máy chủ

**Checklist nghiệm thu đầy đủ chưa hoàn tất.** Phiên implementation ban đầu chỉ sửa source, không chạy tests/runtime. Sau đó người dùng cho phép lab Linux riêng trên vm-1 ngày 2026-11-02; [biên bản lab](<telegraf-agent-vm1-20261102.md>) ghi rõ những trường hợp đã chạy và bằng chứng. Các mục dưới đây thường gộp nhiều OS/tình huống nên vẫn để unchecked nếu chưa hoàn thành toàn bộ mục; không suy rộng kết quả lab. Dùng máy thử nghiệm, Server/credential riêng, snapshot và console recovery trước khi bắt đầu.

Tham chiếu: [hướng dẫn Agent](<../deployment/telegraf-agent.md>), [hợp đồng API](<../contracts/agent-provisioning.md>), [quyết định và source review](<../architecture/telegraf-agent-implementation.md>).

## A. Offline/source — thực hiện trong đợt testing riêng

- [ ] Ghi OS/version/architecture/locale; phiên bản Python, PowerShell/systemd, Telegraf và nguồn hash/signature. Bao gồm Linux systemd amd64, Windows Server amd64, PowerShell 5.1/7, locale English và non-English.
- [ ] Kiểm tra cú pháp/lint/build Python, Bash, PowerShell, NestJS, TOML, JSON, YAML. Review resolved Compose model mà không xuất secrets; `!override` cần Compose 2.24.4+.
- [ ] So sánh local profile mirrors với seed published v1; không ghi đè version đã tồn tại. Chuẩn bị profile đổi interval/groups/options và phiên bản trước để rollback.
- [ ] Xác nhận Telegraf upstream 1.38.2 có đủ plugins, native SCM flags, HTTP/TLS/proxy và log rotation options; không dùng patched binary của dự án tham khảo.
- [ ] Kiểm thử renderer bằng response fixtures đúng schema NestJS: defaults, RFC8785 checksum, Unicode/non-BMP, quote/backslash, literal `$name`, `$$`, `@NIC@`, array rỗng/64 items. Đặt environment có biến trùng tên để xác minh literal dollars không bị expand.
- [ ] Reject unknown fields, sai OS, duplicate JSON keys, unsafe strings, UUID/hash/protocol/header mismatch và body quá lớn. Không có remote TOML/exec/plugin injection.

## B. Central/TLS

- [ ] Bootstrap/migrate/seed Step 3 hoàn tất; signed trust và Gateway source đúng. UID 10002/10001 đọc được cert/key tương ứng nhưng user không liên quan không đọc được private keys.
- [ ] Base Compose không override vẫn giữ behavior HTTP nội bộ cũ. TLS override dùng HTTPS có xác minh SAN/fullchain/CA; Gateway health dùng TLS verify; Management internal signed RPC vẫn hoạt động.
- [ ] Control TLS chỉ cho exact GET provisioning/POST config report. Admin/internal/OpenAPI, sai method/query/path phải bị từ chối. Thiếu hoặc sai cert/key làm startup fail; không fallback HTTP cho Agent. SIGTERM đóng cả hai listeners.
- [ ] Firewall/bind/DNS được review. Docker Gateway alias dùng DNS SAN đúng; provisioning trả Agent-visible HTTPS origin, không phải tên container không truy cập được từ VM.
- [ ] Cert expired, untrusted CA, SAN mismatch, HTTP origin, URL chứa credential/query/path, Gateway origin pin mismatch đều fail closed. Kiểm tra CA riêng cho control/data và OS trust mặc định.
- [ ] Endpoint control và metrics không redirect. Dùng test key để khảo sát redirect behavior upstream rồi loại bỏ cấu hình redirect trước rollout; không dùng key thật trong capture/logs. Không vô tình dùng proxy environment.

## C. Linux install/security

- [ ] Root, Bash, Python 3.11+, systemd, useradd/groupadd có sẵn. Cài nhiều Servers bằng key riêng mà không sửa source.
- [ ] Key file root0600 và prompt ẩn; key không xuất hiện trong argv/environment/history/logs. File prompt tạm được xóa khi success/error/INT/TERM.
- [ ] Sai hash, thiếu binary, sai OS/architecture, lỗi DNS/TLS/control plane, 401/403/409/429/503 có thông báo rõ và không phá installation cũ.
- [ ] Service account no-login, unique UID/group, không supplementary groups. Key/state root0600; TOML có key root:service0640; service không sửa binary/config. Log directory0700, log0600, rotation10MB/3archives; không lộ key qua journal.
- [ ] Service enabled sau reboot, stop/restart đúng; hardening không làm thiếu metrics host. Service Running chỉ là local acceptance.
- [ ] Foreign unit/service, effective drop-ins/transient/global overrides, external pointer, symlink/hardlink/unsafe ancestor bị từ chối; không sửa file ngoại lai. Hai installers/uninstaller đồng thời phải bị khóa.

## D. Windows install/security

- [ ] Elevated PowerShell5.1 và7, trusted Python không Store shim, binary/hash đúng. Kiểm tra đường dẫn có spaces/backslashes và SCM ImagePath round-trip qua CRT quoting.
- [ ] Key file chỉ operator/SYSTEM/Admin hoặc prompt SecureString. ACL rộng/reparse/junction/foreign explicit ACE bị từ chối; kiểm tra effective access, không chỉ ACL hiển thị.
- [ ] SCM trỏ đúng concrete release, LocalSystem, Automatic/recovery restart. Không đụng service mặc định `telegraf` hoặc service cùng tên không thuộc installer.
- [ ] Root/release/state/key/config/copy bundle và log archives không ordinary-user-readable/writable. Không key trong PowerShell transcript/history, process argv, SCM registry hoặc EventLog.
- [ ] Reboot/stop/restart; thiếu Python, copy lỗi, native install đã tạo SCM rồi nonzero/timeout, timeout Running, locked executable, foreign SCM parameters/EventLog source đều được xử lý không xóa state ngoại lai. EventLog source tạo/xóa đúng.

## E. Metrics và CredentialProvider

- [ ] CPU/RAM/Disk/Network/uptime có dữ liệu thực trên cả hai OS. Windows localized/missing counters, multi-volumes `C:` và Linux filesystem/mount filters hoạt động đúng. Network filter dùng native interface names/globs.
- [ ] Remote Write đúng WriteRequest protobuf + **raw-block Snappy**, không framed Snappy/double gzip, đúng path/content headers/version/User-Agent/Bearer/IDs. Không dùng riêng `telegraf --test` để chứng minh end-to-end.
- [ ] Gateway inject/validate IDs theo CredentialProvider; key A không ghi được Agent B. Conflicting identity/payload labels và duplicate/malformed headers bị reject đúng.
- [ ] Metrics được Prometheus chấp nhận; Online chỉ theo accepted-metrics telemetry. Provision/report/service Running không tự làm Online. Xác minh Unknown/Stale/Offline và dependency outage theo hợp đồng hiện có.
- [ ] Invalid/expired/revoked/missing-scope key và cold verification outage fail closed. Positive cache không quá30s, không stale fallback. Kiểm tra provisioning/report scope riêng.
- [ ] Gateway/Prometheus outage, 429/4xx/502/503/504/timeouts/recovery: xác minh retry/drop/backpressure, buffer mất khi restart. Đo series/bytes/samples trên máy nhiều NIC/mounts, không vượt1MiB compressed/8MiB decompressed/5000series/20000samples. Không tuyên bố exactly-once.

## F. Reinstall/update/rollback/report

- [ ] Cùng IDs: reinstall với binary/hash mới; update-config reuse binary/key/origins/CAs; pin profile mới hoặc phiên bản published trước. Không tạo trùng Server/Agent/key issuance.
- [ ] Different Agent/Server/OS/control origin bị từ chối trước activation, kể cả retry sau first activation thất bại. Không clone installed state sang Server khác.
- [ ] Rotate successor rồi activate trong overlap tối đa300s; revoke old key và quan sát cache tối đa30s. Không giữ plaintext key cũ ngoài nhu cầu pending receipts.
- [ ] Gây lỗi activation có kiểm soát: phục hồi config/binary và Running/enabled state trước đó; first-install failure dọn owned service theo best effort. Backend failed report không xóa last applied.
- [ ] Applied report lỗi sau activation: service mới giữ nguyên, protected report_pending được retry đúng receipt, không mark Online. Revoked key pending receipt cần quy trình Admin, không fabricate applied.
- [ ] Previous acknowledged release được purge; pending/failed receipts được bảo vệ và quản lý cleanup/revocation. Windows failed candidate có thể được purge sau failed-report attempt nhưng identity binding vẫn giữ.
- [ ] Interrupt INT/TERM, PowerShell cancellation, SIGKILL/power loss ở từng phase: không cleanup mù. Linux journal fail closed; Windows SCM/active pointer mismatch cần Admin recovery. Không giả định crash atomicity.

## G. Uninstall/nghiệm thu

- [ ] Chỉ xóa owned service/unit/EventLog/config/binary/current/releases/owned key copies/logs. Không xóa operator source key hoặc tự revoke backend. Linux giữ account; Windows giữ root marker/lock không secret.
- [ ] Uninstall lặp, partial cleanup failure, concurrent admission; foreign files/links/services fail closed. Reinstall sau uninstall có chủ đích cho phép new IDs.
- [ ] Admin revoke key sau uninstall, không metrics mới sau stop, status chuyển theo telemetry hiện có.
- [ ] Lưu kết quả mỗi case, version/hash, redacted evidence và limitations. Chỉ nghiệm thu hoạt động sau khi TLS/identity/provisioning/update/rollback/uninstall trên **cả hai OS** đạt; không đánh dấu pass dựa trên source review.
