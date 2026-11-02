# InfraPulse — biên bản lab Agent trên vm-1, 2026-11-02

## 1. Phạm vi và kết luận

Sau giai đoạn implementation source-only, người dùng cho phép dùng DSH SSH vào vm-1, khảo sát và chạy lab thực tế trên một VM. **Luồng Linux Telegraf → HTTPS Gateway có xác thực → Prometheus đã nhận metrics thật**, không dùng metrics giả hoặc chỉ dựa vào service Running.

Bằng chứng máy đọc được: [JSON đã loại trừ secrets](<evidence/telegraf-agent-vm1-20261102.json>). Snapshot cuối lúc 19:39:45 UTC+07; quan sát Backend cuối lúc 19:37:20 UTC+07. Đây là nghiệm chứng lab nhỏ, không phải nghiệm thu production hay cả Windows/Linux.

## 2. Môi trường và tài nguyên tạo mới

- vm-1: Ubuntu 24.04.5 LTS x86_64, 2 vCPU, 3856 MiB RAM, filesystem khoảng 29 GiB; Python 3.12.3, systemd, NTP đồng bộ. Ban đầu không có Docker, InfraPulse hoặc workload ứng dụng khác.
- Cài Docker 29.1.3 và Compose 2.40.3 từ Ubuntu packages. Project cô lập `infrapulse-vm1-step4`, không tái sử dụng volume/dữ liệu cũ.
- Bốn container: PostgreSQL 18.6, Prometheus v3.13.5, Management Backend, Ingestion Gateway. Không chạy Grafana.
- Hai runtime images lấy từ ECR Public bằng immutable digest đã công bố. Management operations dùng Dockerfile target `migrate` hiện có, build cục bộ rồi chuyển riêng qua SSH; **không publish image thứ ba**.
- Bootstrap → migration → seed được chạy tường minh và đều trả kết quả thành công trước khi khởi động Management/Gateway.
- Tạo credential DB riêng cho bootstrap/owner/runtime, Ed25519 keys riêng cho Admin lab/Gateway, private CA và hai TLS leaf certificates. Không tắt xác minh TLS, không cài CA vào trust store hệ điều hành.
- Agent native Telegraf 1.38.2 amd64; xác minh SHA256 archive theo bảng chính thức trong GitHub release, sau đó xác minh SHA256 executable khi installer copy. Hash đầy đủ có trong evidence JSON.

Các vị trí runtime và port của lab:

```text
/srv/infrapulse-lab-20261102       root-owned 0700; config, secrets, evidence, source
/opt/infrapulse-agent             installation và concrete releases
/var/lib/infrapulse-agent         log riêng 0700 của service user
127.0.0.1:3001                    Management Admin HTTP, chỉ loopback
127.0.0.1:3443                    Agent control HTTPS
127.0.0.1:8443                    Gateway HTTPS
127.0.0.1:9090                    Prometheus HTTP, chỉ loopback
```

Không mở cổng ứng dụng public, sửa Azure networking/firewall, cài Azure Arc hay publish PostgreSQL ra host. Agent dùng HTTPS; signed RPC nội bộ Gateway → Management vẫn dùng Docker network theo kiến trúc hiện có. Admin provisioning dùng ephemeral signed lab operator, **không phải kiểm thử Grafana SDK/identity adapter**.

## 3. Provisioning và bằng chứng metrics

Server/Agent được tạo qua API NestJS thực; gán đúng published `linux-base` v1, cấp reveal-once credential đủ ba scopes. API Key không được in ra hoặc truyền trên argv/environment. Không tạo key giả hoặc bỏ CredentialProvider.

| Thuộc tính | Kết quả quan sát |
| --- | --- |
| Server ID | `76c61c9a-e845-474e-932b-c90b6ee86920` |
| Agent ID | `4e7ea3d4-da72-49ee-a35a-539d3e6865e2` |
| Profile version ID | `7d4fb804-276e-40c0-aa2c-0ebb618eb050` |
| Series có đúng hai ID | **300** |
| Tên metric khác nhau | **90** |
| Nhóm CPU/RAM/Disk/Network/uptime | Đủ cả năm |
| Sample timestamp trước/sau update | Tiếp tục tăng; sau update: `1793622975.832` → `1793622990.352` |
| Backend config report | `applied`, đúng profile version; local `report_pending=false` |
| Backend telemetry | `Online`, `recent_success`, source `healthy`; last metric 12:37:14.033Z |
| Service | Enabled, active/running, dedicated account, `NRestarts=0`, `ExecMainStatus=0` |

Ví dụ sau configuration refresh: CPU active ≈2.477%, RAM used ≈24.375%, uptime 12006 giây; disk và network cũng có samples thật. Đây là snapshot, không phải mức sử dụng cố định.

Truy vấn kiểm tra trong Prometheus:

```promql
count({server_id="76c61c9a-e845-474e-932b-c90b6ee86920",agent_id="4e7ea3d4-da72-49ee-a35a-539d3e6865e2"})

cpu_usage_active{server_id="76c61c9a-e845-474e-932b-c90b6ee86920",agent_id="4e7ea3d4-da72-49ee-a35a-539d3e6865e2"}

mem_used_percent{server_id="76c61c9a-e845-474e-932b-c90b6ee86920",agent_id="4e7ea3d4-da72-49ee-a35a-539d3e6865e2"}

max(timestamp(system_uptime{server_id="76c61c9a-e845-474e-932b-c90b6ee86920",agent_id="4e7ea3d4-da72-49ee-a35a-539d3e6865e2"}))
```

Gateway scrape `up{job="ingestion-gateway"}=1` là bằng chứng bổ sung về scrape health, **không thay thế** bằng chứng host metrics kể trên. Agent gửi Remote Write, không phải Prometheus scrape Agent trực tiếp.

## 4. Những case đã thực hiện

- Cài mới bằng [installer Linux](<../../agents/telegraf/linux/install.sh>), Telegraf executable/hash đã kiểm chứng, CA riêng và key file root0600.
- Cập nhật lại cấu hình bằng `--update-config`, reuse binary/key/origins/CAs; tạo concrete release mới, giữ nguyên Server/Agent/profile, applied report được acknowledge và release cũ đã acknowledge được purge. Metrics tiếp tục cập nhật sau restart.
- Untrusted CA bị từ chối. Provisioning thiếu credential trả 401. Agent control TLS không expose Admin route (404). Gateway với invalid API Key trả 401. Không sửa quyền OS để vượt qua kiểm tra.
- Key/state root0600; output TOML root:service0640; log directory service0700, log file0600. Telegraf chạy bằng account riêng, không root.
- [Regression suite Linux](<../../agents/telegraf/tests/test_linux_paths.py>): chạy trên VM với root, đủ **4/4 pass**. Trước fix, case ancestry bị từ chối đúng tại parent không an toàn; sau fix, case này pass và group-writable/symlink vẫn bị reject. Không test cài service từ unit test này.
- Bốn container cuối đều healthy. Snapshot VM dùng khoảng 959 MiB RAM, khoảng 2897 MiB available; disk còn khoảng 21 GiB. Agent service khoảng 29 MiB RAM. Đủ cho lab một Agent, không phải benchmark tải.

## 5. Lỗi phát hiện và xử lý

1. Bundle tar từ Windows mang mode directory0777/file0666: installer từ chối như thiết kế. Chỉ normalize bundle mới thuộc root trong thư mục lab; không nới guard và không đổi quyền thư mục dùng chung.
2. Ubuntu có parent log root:syslog0775: installer cũ fail closed. Sửa [lifecycle](<../../agents/telegraf/linux/lifecycle.py>), [renderer](<../../agents/telegraf/common/agentctl.py>) và [systemd unit](<../../agents/telegraf/linux/infrapulse-telegraf.service>) đồng bộ sang private service directory dưới `/var/lib`; giữ nguyên strict ancestor check và deletion boundary. Không chmod parent log của OS. Thêm regression và hướng dẫn migration pre-release trong [deployment guide](<../deployment/telegraf-agent.md>).
3. Truy vấn chẩn đoán ban đầu dùng `timestamp` trên mọi metric làm PromQL bỏ tên metric, tạo duplicate labelsets và trả 422. Sửa truy vấn sang một metric family uptime; không sửa Gateway/Prometheus để né lỗi và không coi đây là lỗi ingest.
4. Docker import chuyển đổi metadata làm config ID hiển thị khác export: xác minh SHA256 toàn archive, canonical runtime configuration và toàn bộ filesystem-layer hashes đều khớp trước khi dùng ops tooling. Không lấy một image không rõ nguồn để thay thế.
5. URL checksum sidecar upstream trả 404: dùng đúng bảng SHA256 trong official release metadata, vẫn bắt buộc so sánh hash trước khi chạy binary; không bỏ bước xác minh.

Log không có dòng `E!` ở thời điểm kiểm tra. Có ba loại cảnh báo upstream: strict environment handling mặc định mới, option `fielddrop` deprecated (dự kiến bỏ ở 1.40), và default `skip_processors_after_aggregators` sẽ đổi. Không thêm `--non-strict-env-handling`; lab dùng strict behavior. Telegraf mới hơn baseline cần qualification và cập nhật option deprecated, chưa tự auto-upgrade.

Scoped source review xác nhận đường dẫn log/guard/unit/cleanup đồng bộ. Không tự nhận hỗ trợ migration in-place từ unit pre-fix; exact-byte ownership check vẫn giữ nguyên. Reviewer không thực hiện SSH/test thay parent.

## 6. Truy cập và vận hành lab còn chạy

Lab được để chạy cho người dùng kiểm tra. DSH SSH tunnel `tun-1` trong phiên này forward localhost51843 → vm-1 loopback9090; mở [Prometheus qua tunnel](<http://127.0.0.1:51843/>) khi tunnel còn hoạt động. Port local là cấp động, không phải cấu hình triển khai cố định; tunnel mất thì mở lại qua DSH SSH hoặc SSH local forwarding, không mở public9090.

Các lệnh **chỉ khi người vận hành muốn dùng**, không đã chạy thay cho yêu cầu dừng:

```bash
# Xem trạng thái, không in secrets/config đã expand
sudo /srv/infrapulse-lab-20261102/compose.sh ps
sudo systemctl is-active infrapulse-telegraf.service

# Dừng lab nhưng giữ dữ liệu/credential/release
sudo systemctl stop infrapulse-telegraf.service
sudo /srv/infrapulse-lab-20261102/compose.sh stop management ingest prometheus postgres

# Mở lại, không build và không bootstrap/migrate/seed lại
sudo /srv/infrapulse-lab-20261102/compose.sh up -d --no-build --wait management ingest postgres prometheus
sudo systemctl start infrapulse-telegraf.service
```

Không chia sẻ nội dung private env/keys/URL files/TOML hoặc raw log. Không chạy `down -v`, xóa thư mục lab, uninstall hay revoke key nếu còn cần lab. Cert leaf của lab có hạn 30 ngày, private CA 90 ngày; chưa cấu hình auto-renew. Backend credential có expiry theo API; cần operator quản lý khi dùng lâu hơn lab ngắn hạn.

## 7. Chưa kiểm thử / chưa nghiệm thu

Windows; mạng giữa hai VM; reboot/power loss; rotation/revoke/expiry và cache TTL; đổi profile nội dung/rollback version; failure injection, rollback/crash recovery; uninstall/reinstall vòng đầy đủ; log rotation thật khi đủ10MB; multi-host cardinality/load; outage/backpressure; Grafana adapter; comprehensive renderer/security fixtures và toàn bộ suite Backend/Gateway. Không chạy thêm các hạng mục này trong lab cơ bản.

Tiếp tục theo [checklist đầy đủ](<telegraf-agent-checklist.md>). Kết quả hiện tại chỉ xác nhận đường metrics thực và các case cụ thể đã ghi ở trên trên Linux vm-1.
