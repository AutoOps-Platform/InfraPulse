# Bước 7 — Central Stack trên vm-2

## Trạng thái và phạm vi

Ngày 2026-11-03 đã triển khai thật PostgreSQL, Prometheus, Grafana, NestJS Management, FastAPI Gateway và Go/React App Plugin trên **vm-2**, rồi kiểm chứng luồng Linux bằng UI/API/Agent/metrics thật. Xem [biên bản và giới hạn nghiệm thu](<../testing/step7-vm2-20261103.md>). Không thay đổi hay kết nối vm-1 trong đợt này; cấu hình lịch sử chỉ được tham khảo từ repository.

Đây là **lab/MVP một Linux host**, không phải production acceptance, Windows qualification hay HA/multihost qualification. Không reboot VM, restart Docker daemon, sửa firewall/SSH/sudoers/network cấu hình VPS, stress test hoặc gây dependency outage. Docker được cài mới và tạo các bridge của project theo nhu cầu triển khai, không sửa network của ứng dụng khác.

## 1. Địa chỉ và truy cập

| Thành phần | Địa chỉ thật | Phạm vi |
| --- | --- | --- |
| SSH vm-2 | `${SSH_USER}@${VM2_SSH_HOST}:22` | Lấy endpoint/login riêng từ cấu hình SSH của operator; không công khai địa chỉ quản trị hoặc credential trong Git |
| Grafana | `127.0.0.1:3000` trên vm-2 | Chỉ loopback, truy cập qua SSH tunnel |
| App Plugin | `/a/infrapulse-infrapulse-app/overview` | Trong Grafana, không có Admin Web riêng |
| Agent control | `https://172.16.0.4:3443` | Interface private thực của vm-2, certificate có IP SAN |
| Metrics Gateway | `https://172.16.0.4:8443/api/v1/ingest/remote-write` | Interface private, Bearer credential và TLS bắt buộc |
| Management HTTP | `127.0.0.1:3001` trên host | Loopback; signed RPC nội bộ dùng `management:3000` |
| Prometheus | `127.0.0.1:9090` trên host | Loopback; Grafana/Gateway dùng Docker service discovery |
| PostgreSQL | `postgres:5432` | Chỉ network database, không publish host port |

Tunnel DSH đang dùng tại lúc bàn giao: **<http://127.0.0.1:65525/a/infrapulse-infrapulse-app/overview>**. URL này chỉ hoạt động trên máy DSH khi tunnel `tun-5` còn sống; không phải public URL. Có thể mở tunnel riêng mà không đổi cấu hình VPS:

```sh
# POSIX shell: điền SSH_USER và VM2_SSH_HOST từ cấu hình riêng đã được xác minh.
# Hai biến là thông tin kết nối, không chứa password/private key.
ssh -N -L 13000:127.0.0.1:3000 "${SSH_USER:?Set SSH_USER privately}@${VM2_SSH_HOST:?Set VM2_SSH_HOST privately}"
# Sau đó mở http://127.0.0.1:13000/
```

Bản public chỉ ẩn địa chỉ/login SSH quản trị, không thay hoặc suy đoán thông số runtime. Evidence vẫn giữ địa chỉ private của lab và UUID không phải secret để đối chiếu chuỗi E2E.

Issuer server-side vẫn là `http://127.0.0.1:3000/`, không thay theo local forwarding port. Browser đi qua kênh SSH; HTTPS control/Gateway dùng CA riêng của deployment. Không mở Grafana/DB/Prometheus ra Internet.

## 2. Cấu hình được giữ lại trên VPS

Deployment root mới, root-owned0700:

```text
/srv/infrapulse-vm2-20261103/
  .env                       # private, không in/share/commit
  public-deployment.json     # metadata không secret
  compose.runtime.yaml       # reviewed images, memory bounds, alert evaluator
  compose-base.sh            # base + Agent TLS + runtime overlay
  compose.sh                 # base + Agent TLS + App + runtime overlay
  source/                    # source/config/artifacts đã kiểm hash
  secrets/                   # CA, TLS, signing keys, DB URLs, Agent key
  evidence/                  # private operational receipts/logs + allowlisted JSON
  backup/                    # config/keys, consistent Grafana SQLite, PG dump
  downloads/                 # verified official Telegraf binary/archive
```

Secret mới được sinh **trên vm-2**, không sao chép từ vm-1: ba DB role credentials khác nhau, Gateway Ed25519 key, App Ed25519 key, CA và hai leaf TLS keys. Management chỉ đọc runtime DB URL và public trust; Gateway UID10001, Management UID10002, Grafana UID472 chỉ đọc đúng file được mount. Không đưa PEM/key/DB URL vào frontend hoặc argv. File private giữ0400/0600; public CA/config có thể0644 bên dưới parent private để non-root container đọc bind mount.

Grafana Admin password khởi tạo nằm trong private runtime dotenv. Không chép nó vào chat, logs hay báo cáo; operator quản lý/lấy thông tin này riêng bằng quyền hợp lệ trên VPS hoặc secret manager. Thay dotenv **không tự rotate password trong volume**. API Key Agent chỉ trả một lần; bản dùng cho installation được bảo vệ riêng ở `secrets/agent-key-vm2-linux` trên VPS, không có plaintext trong PostgreSQL.

Các named volumes giữ nguyên qua redeploy cùng project `infrapulse-vm2-step7`:

| Volume | Container path |
| --- | --- |
| `infrapulse-vm2-step7_postgres_data` | `/var/lib/postgresql` — PG18 layout |
| `infrapulse-vm2-step7_prometheus_data` | `/prometheus` |
| `infrapulse-vm2-step7_grafana_data` | `/var/lib/grafana` — SQLite |

Prometheus retention7d/2GB là giới hạn cấu hình, không bảo đảm đủ bảy ngày ở mọi tải. Đã kiểm tra mounts thật và Grafana giữ user/database qua các lần recreate cần thiết để bật plugin/alerts. Không chạy reboot hoặc persistence fault test; volume không thay thế backup đã thử restore. Backup được tạo trước App onboarding; **chưa chạy restore drill** trên vm-2.

## 3. Artifact và thứ tự triển khai

Baseline source `e6bd0097967a389f130940672573af310e0af610` cộng bản sửa TLS scrape của Bước7; tại thời điểm deploy, bản sửa là working-tree changes. Git publication được xử lý riêng sau khi người dùng yêu cầu. Các runtime images và Management `migrate` target được build từ source hiện tại **ở workstation**, rồi chuyển bằng SSH; không build nặng trên VPS, không publish image mới. Config và ordered layer-chain hashes được so sánh sau `docker load`, không so sánh mù local/loaded image ID vì image store có thể normalize metadata. Frontend và Linux/amd64 backend được build riêng từ [App Plugin](<../../apps/grafana-app/README.md>).

Thứ tự đã thực hiện:

1. Read-only inventory: Ubuntu24.04.5, 2CPU/~4GiB, VPS mới không có app/Agent; xác minh port/path/sudo/NTP.
2. Cài Docker29.1.3/Compose2.40.3; tạo root private mới, từ chối adopt/overwrite deployment cũ.
3. Chuẩn bị TLS/trust/DB files, source/artifact manifest; kiểm tra Compose không in expanded config.
4. Khởi chạy PostgreSQL, Prometheus, Grafana; xác minh Grafana thật, Admin user1 và org1 trước khi dùng App.
5. Explicit `management-bootstrap` → `management-migrate` → `management-seed`; runtime app không tự migration.
6. Khởi chạy Management rồi HTTPS Gateway; bật App sau enrollment. Chỉ container liên quan được deploy/recreate.
7. Onboard từ UI, cài native Linux Agent; sau khi có metrics thật mới bật bốn Grafana alert evaluators. Không cấu hình contact point/webhook/email ra ngoài.

Tham khảo [Management runbook](<management-backend.md>) và [App identity/security](<grafana-app.md>) trước rollout mới. Org/namespace/context phải đối chiếu deployment thật; context UUID không thay thế signed user identity. Go adapter xác minh Grafana ID token/JWKS và Nest tiếp tục RBAC/assertion/nonce validation.

**Lab gates còn giữ:** upstream Grafana13.3 ID token/signing-key implementation còn experimental; development unsigned exception chỉ đúng plugin ID. Không gọi đây là production identity/signing acceptance. Management HTTP chỉ trên private Docker transport có kiểm soát; signatures không cung cấp encryption.

## 4. TLS Gateway và Prometheus self-monitoring

[Base Prometheus config](<../../observability/prometheus/prometheus.yml>) dùng HTTP cho HTTP-only stack. [TLS overlay](<../../deploy/compose/compose.agent-tls.yaml>) chuyển toàn bộ Gateway listener sang HTTPS, vì vậy Bước7 bổ sung verified TLS scrape thay vì để self-monitoring lỗi protocol hoặc bỏ xác minh cert.

Render **file mới** trước khi dùng overlay; hostname phải đúng DNS SAN trong certificate Gateway:

```sh
python3 deploy/scripts/render-prometheus-tls.py \
  --server-name gateway.example.internal \
  --output /operator-owned/new-prometheus-tls.yml
# Điền riêng trong private dotenv:
# PROMETHEUS_TLS_SCRAPE_CONFIG_FILE=/operator-owned/new-prometheus-tls.yml
# AGENT_GATEWAY_TLS_CA_FILE=/operator-owned/gateway-ca.pem
# INGEST_TLS_SERVER_NAME=gateway.example.internal
```

[Renderer](<../../deploy/scripts/render-prometheus-tls.py>) chỉ tạo JSON hợp lệ như YAML, không gọi mạng/service, không ghi đè file cũ. Mount public CA vào Prometheus và cấu hình `scheme: https`, `server_name` thật, không `insecure_skip_verify`. Chạy `promtool check config` và kiểm tra `up{job="ingestion-gateway"}` sau deploy; trên vm-2 đã quan sát giá trị1 với target `ingest:8000`.

**Thay đổi tương thích:** người dùng TLS overlay cũ phải thêm `PROMETHEUS_TLS_SCRAPE_CONFIG_FILE`; HTTP base không thêm yêu cầu mới. Không copy đè config đang dùng; tạo file versioned, backup, cập nhật đúng env/path, chỉ rollout container liên quan trong cửa sổ được phép.

## 5. Onboarding và vận hành không gây gián đoạn

Trong Grafana: **Install → Add Server → Register Agent → published linux-base exact version → explicit acceptance → Issue API Key → provisioning preview → cài bundle/binary đã review → Monitoring**. [Agent runbook](<telegraf-agent.md>) có Linux/Windows flags, private CA, key handling và update/uninstall. Không dùng `curl|bash`, command chứa plaintext key hoặc TLS bypass.

Read-only vận hành hiện tại:

```sh
sudo /srv/infrapulse-vm2-20261103/compose.sh ps
sudo systemctl status infrapulse-telegraf.service --no-pager
# Không share raw service logs, dotenv, output TOML hoặc docker inspect Config.Env.
```

Deploy bản sửa sau này cần backup, manifest/hash, reviewed image/config và quyền riêng. Không tự chạy `up` cả stack để thử; chỉ chỉ định service cần thay đổi. Không `down -v`, prune, drop/reset DB/TSDB, đổi secret/major PG hay reboot để nghiệm thu. Không sửa vm-1 để hoàn thành vm-2.

Certificate leaf hiện tại hết hạn **2027-02-01 05:03:17Z**; CA365d, chưa có auto-renew. Agent credential hiện tại hết hạn **2026-12-03 05:15:13.720Z**; cần quy trình rotate/update có chủ đích trước hạn. Đây là thời hạn bảo mật, không phải giới hạn trial. Không suy ra dữ liệu sẽ bị xóa khi cert/key hết hạn.

Helper login/key-transfer tạm thời và hai tài khoản role thử đã được dừng/xóa; tunnel helper đã đóng. Chỉ tunnel Grafana được giữ để operator dùng. Agent và Central Stack được giữ chạy, không teardown deployment vừa bàn giao.
