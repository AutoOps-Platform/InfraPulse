# InfraPulse — Bước 1: Central Infrastructure

- Ngày: 2026-10-30.
- Trạng thái: Thiết kế đã được thống nhất theo từng phần trong hội thoại; bản tổng hợp này chờ người dùng review trước khi lập implementation plan.
- Phạm vi hiện tại: chỉ thiết kế và lập kế hoạch; chưa cho phép triển khai.
- Nguồn yêu cầu: [INTRODUCT.md](<C:/MF/VSCODE/InfraPulse/INTRODUCT.md>), [AGENTS.md](<C:/MF/VSCODE/InfraPulse/AGENTS.md>) và các lựa chọn trực tiếp của người dùng trong phiên brainstorming.

## 1. Mục tiêu và tiêu chí thành công

Xây dựng nền tảng trung tâm tối giản, dễ bảo trì và tái triển khai cho InfraPulse, chạy lab trên máy Windows hiện tại bằng Docker Desktop/WSL2 với Linux containers. Bước 1 chỉ gồm Docker Compose, Prometheus, Grafana và PostgreSQL.

Kết quả triển khai sau này phải chứng minh được: ba service khởi động và có health check; Grafana tự kết nối Prometheus; Prometheus sẵn sàng nhận Remote Write trong Docker network; PostgreSQL có database dùng cho backend tương lai; dữ liệu được giữ qua việc tái tạo container; chỉ Grafana có cổng host, bind trên loopback.

Luồng mục tiêu dài hạn vẫn là Telegraf → FastAPI Ingestion Gateway → Prometheus → Grafana. Bước 1 chuẩn bị điểm tích hợp, không hiện thực hay nghiệm thu toàn bộ luồng này.

## 2. Quyết định đã thống nhất

| Hạng mục | Quyết định |
|---|---|
| Môi trường nghiệm thu | Windows + Docker Desktop/WSL2, Linux containers |
| Giao diện | Grafana tại `http://127.0.0.1:3000`, chỉ dùng trên máy hiện tại |
| TLS hiện tại | Chưa cấu hình TLS cho Grafana loopback trong lab; không áp dụng ngoại lệ này cho truy cập LAN hoặc ingestion tương lai |
| Orchestration | Một Docker Compose project tên `infrapulse` |
| Service trong thiết kế | `prometheus`, `grafana`, `postgres` |
| Network | Hai network: `monitoring` và `database` |
| PostgreSQL network | `database` có `internal: true`; Grafana/Prometheus không tham gia |
| Port host | Chỉ `127.0.0.1:3000:3000` của Grafana |
| Retention Prometheus | `7d` kết hợp `5GB`; ngưỡng đến trước quyết định xóa dữ liệu cũ |
| Persistence | Ba named volume riêng, do Docker Desktop quản lý |
| Grafana internal DB | SQLite trong volume Grafana, không dùng PostgreSQL |
| Mật khẩu lab | Trong `.env` tại root, bị Git ignore; không dùng secret file hoặc biến `*_FILE` |
| Grafana datasource | Provision tự động, UID cố định `infrapulse-prometheus` |
| Dashboard | Chuẩn bị file provider và hỗ trợ import UI; chưa xây dashboard nghiệp vụ |
| Restart policy | `unless-stopped` cho cả ba service |
| Container logs | Driver `json-file`, `max-size: 10m`, `max-file: 3` cho mỗi service |
| Reverse proxy/Admin Web | Không Nginx, không Admin Web độc lập |

Lựa chọn Linux VM/server ban đầu đã được người dùng sửa thành Windows + Docker Desktop/WSL2. Linux server không phải môi trường nghiệm thu của bước này.

## 3. Hiện trạng repository và cách tận dụng

Tại thời điểm khảo sát, workspace có [INTRODUCT.md](<C:/MF/VSCODE/InfraPulse/INTRODUCT.md>) và [AGENTS.md](<C:/MF/VSCODE/InfraPulse/AGENTS.md>), cùng bộ khung thư mục ứng dụng/hạ tầng nhưng chưa có file triển khai. Các cây liên quan đã tồn tại:

- `deploy/compose/`.
- `observability/prometheus/`.
- `observability/grafana/`.
- `services/ingestion-gateway/`.
- `services/management-api/`.
- `docs/`, `scripts/` và `tests/`.

Cấu trúc này được ưu tiên hơn cây minh họa ở mục 20 của [INTRODUCT.md](<C:/MF/VSCODE/InfraPulse/INTRODUCT.md>). Không tạo thêm `monitoring/`, `grafana/` hoặc cây backend song song ở root.

Code Graph đã được kiểm tra readiness và coverage. Graph bỏ qua `deploy/`; khảo sát filesystem trực tiếp xác nhận chưa có file tại đây. Hai tài liệu nguồn đã được đọc trực tiếp đầy đủ, không chỉ dựa vào index.

Workspace chưa có metadata `.git`, nên không có lịch sử/diff để phân tích. Không khởi tạo Git, staging hoặc commit trong phạm vi này. Nếu trạng thái workspace thay đổi trước khi triển khai, phải khảo sát lại và giữ nguyên nội dung không liên quan.

## 4. Phương án đã cân nhắc

### Phương án chọn: một Compose, hai network

Grafana và Prometheus dùng `monitoring`; PostgreSQL chỉ dùng `database` có `internal: true`. Vẫn gọn cho lab nhưng tách được đường metrics khỏi database nghiệp vụ. Đây là lựa chọn được người dùng duyệt.

### Phương án không chọn: một Compose, một network

Cấu hình ngắn hơn nhưng cả Grafana và Prometheus đều có thể kết nối PostgreSQL ở lớp mạng. Không phù hợp bằng phương án hai network khi đã có ranh giới dữ liệu nghiệp vụ rõ ràng.

Không thêm orchestration khác, proxy, storage backend khác hoặc nhiều Compose overlay chỉ để chuẩn bị cho nhu cầu chưa xuất hiện.

## 5. Kiến trúc service và mạng

| Service | Network | Endpoint trong Docker | Port host |
|---|---|---|---|
| `prometheus` | `monitoring` | `http://prometheus:9090` | Không publish |
| `grafana` | `monitoring` | `http://grafana:3000` | `127.0.0.1:3000:3000` |
| `postgres` | `database` | `postgres:5432` | Không publish |

### 5.1. Quy tắc network

- Cả hai network do Compose quản lý, dùng bridge và DNS service name.
- `monitoring` là bridge thông thường; không tuyên bố network này chặn outbound Internet.
- `database` đặt `internal: true`, phục vụ traffic giữa những container được chủ động gắn vào network này.
- Không sử dụng default network chung thay thế hai network đã chọn.
- Không đặt IP tĩnh hoặc `container_name`; project name ổn định đủ để có namespace tài nguyên nhất quán.
- `expose` nếu có chỉ là metadata, không được coi là firewall hay cơ chế xác thực.
- Docker network không ngăn người có quyền Docker/host truy cập dữ liệu. Không gắn container không tin cậy vào các network của stack.

### 5.2. Điểm tích hợp tương lai, không phải service hiện tại

- Ingestion Gateway sẽ cần đường mạng tới `http://prometheus:9090/api/v1/write`.
- NestJS sẽ cần đường mạng tới `postgres:5432` qua `database`, đồng thời có kết nối thích hợp với Grafana server-side khi tích hợp management.
- Không tạo service giả, Dockerfile, thư mục mã nguồn mới hoặc environment variable đang hoạt động cho các backend chưa triển khai.
- Không publish cổng `8000`, `3001` hoặc cổng dành cho thành phần tương lai trong Bước 1.
- Thiết kế TLS, identity propagation, cache credential và nghiệp vụ ingest thuộc các bước sau, không được coi là đã giải quyết bởi network hiện tại.

## 6. Cấu hình từng thành phần

### 6.1. Prometheus

- Bật `--web.enable-remote-write-receiver`; receiver tại `/api/v1/write`.
- Cấu hình nằm ở `/etc/prometheus/prometheus.yml`, được bind-mount read-only.
- TSDB nằm ở `/prometheus`, trên named volume `prometheus_data`.
- Retention mặc định qua Compose là `--storage.tsdb.retention.time=7d` và `--storage.tsdb.retention.size=5GB`.
- Tự scrape endpoint `prometheus:9090` với job name `prometheus`, chu kỳ `30s`. Không thêm exporter hoặc agent.
- Không cấu hình outbound `remote_write` để bật receiver; đây là hai chức năng khác nhau.
- Không bật lifecycle HTTP hoặc admin API khi không có nhu cầu.
- Không có ingress authentication riêng trong Bước 1; receiver chỉ dành cho container tin cậy ở network `monitoring`.

`5GB` là ngưỡng retention dung lượng, không phải quota cứng của Docker volume. WAL, head chunks, compaction và phần dung lượng dự phòng vẫn phải được tính vào lưu trữ Docker Desktop. Không đảm bảo luôn có đủ 7 ngày lịch sử nếu chạm ngưỡng dung lượng trước.

Remote Write Receiver chỉ là nền tảng thử nghiệm tải thấp. Không có tuyên bố throughput hoặc khả năng phục vụ số lượng agent lớn.

### 6.2. Grafana

- Publish loopback trên Windows; URL người dùng là `http://127.0.0.1:3000`.
- Tắt anonymous access và tự đăng ký tài khoản; dùng tài khoản admin bootstrap từ `.env`.
- SQLite và trạng thái Grafana nằm trong named volume `grafana_data`, mount tại `/var/lib/grafana`.
- Không cấu hình Grafana sử dụng PostgreSQL; lỗi PostgreSQL không được làm gián đoạn đường truy vấn metrics.
- Datasource Prometheus được provision qua file, dùng server-side/proxy access và URL `http://prometheus:9090`.
- UID datasource là `infrapulse-prometheus`; đặt làm mặc định và không cho sửa cấu hình datasource này qua UI.
- Provisioning files mount read-only tại `/etc/grafana/provisioning`.
- Dashboard JSON từ repository mount read-only tại `/etc/grafana/dashboards`; provider trỏ tới đúng đường dẫn đó.
- Dashboard file-provisioned lấy repository làm nguồn cấu hình; không cho lưu sửa đổi vào chúng qua UI. Xóa file nguồn sẽ cho phép provider xóa dashboard tương ứng.
- Dashboard import thủ công qua UI được lưu trong SQLite và tồn tại qua việc tái tạo container; chúng không tự trở thành file có version trong repository.
- Thư mục dashboard ban đầu chỉ có `.gitkeep`. Dashboard dùng trong nghiệm thu là dữ liệu kiểm chứng tạo/import tạm, không phải dashboard nghiệp vụ được triển khai sẵn.
- Không cài custom plugin hoặc tự động tải dashboard/plugin từ Internet khi khởi động.

### 6.3. PostgreSQL

- Dùng image PostgreSQL chính thức; database ban đầu tên `infrapulse`.
- `POSTGRES_USER` phục vụ bootstrap, mặc định `postgres`; phải ghi rõ đây là superuser của official image, không phải tài khoản ứng dụng least-privilege.
- Mật khẩu bootstrap được cấp qua `POSTGRES_PASSWORD` từ `.env`.
- Không đặt `POSTGRES_HOST_AUTH_METHOD=trust`; kết nối TCP phải dùng password authentication. Không publish `5432` và không mount Docker socket. Local Unix socket có thể giữ cơ chế trust mặc định của official image; vì vậy kiểm chứng password phải dùng TCP, không dùng socket.
- Dữ liệu nằm trên named volume `postgres_data`. Destination phải khớp layout dữ liệu của image đã pin; implementation plan phải ghi image tag và mount destination như một cặp, đặc biệt phân biệt layout PostgreSQL trước và từ major 18.
- Không tạo bảng nghiệp vụ, init SQL, ORM hoặc migrations trong Bước 1.
- Khi tích hợp NestJS ở bước sau, phải cấp role không có quyền superuser; không tái sử dụng credential bootstrap làm credential ứng dụng.

## 7. Environment, phiên bản và bảo mật lab

### 7.1. Vị trí và cách truyền cấu hình

- `.env` nằm tại root, do người vận hành tạo; không version-control.
- `.env.example` nằm tại root, chỉ chứa giá trị cấu hình mặc định và placeholder mật khẩu không thể dùng như credential vận hành.
- Compose dùng `environment` để truyền rõ từng biến cần thiết cho từng service. Không dùng `env_file` để đưa toàn bộ `.env` vào mọi container.
- `.env` là input cho Compose interpolation, không tự động trở thành environment của mọi container.
- Thiếu mật khẩu hoặc để rỗng phải làm bước kiểm tra Compose thất bại; tài liệu phải yêu cầu thay placeholder trước khi chạy.
- Không dùng `POSTGRES_PASSWORD_FILE`, `GF_SECURITY_ADMIN_PASSWORD__FILE` hoặc secret file trong phương án đã chọn.

### 7.2. Hợp đồng tên biến dự kiến

| Biến root `.env` | Consumer/ý nghĩa |
|---|---|
| `PROMETHEUS_IMAGE_TAG` | Tag image `prom/prometheus` |
| `GRAFANA_IMAGE_TAG` | Tag image `grafana/grafana` |
| `POSTGRES_IMAGE_TAG` | Tag image `postgres` |
| `PROMETHEUS_RETENTION_TIME` | Mặc định `7d` |
| `PROMETHEUS_RETENTION_SIZE` | Mặc định `5GB` |
| `GRAFANA_ADMIN_USER` | Truyền thành `GF_SECURITY_ADMIN_USER` |
| `GRAFANA_ADMIN_PASSWORD` | Truyền thành `GF_SECURITY_ADMIN_PASSWORD` |
| `POSTGRES_DB` | Mặc định `infrapulse` |
| `POSTGRES_USER` | Mặc định `postgres`, chỉ bootstrap |
| `POSTGRES_PASSWORD` | Chỉ truyền cho container PostgreSQL |

Cổng loopback `3000`, project name, datasource UID và network topology là cấu hình thiết kế cố định, không thêm biến môi trường cho mọi giá trị. Không chuẩn bị `DATABASE_URL` chứa credential ứng dụng hoặc biến AIOps khi chưa có consumer.

### 7.3. Chính sách image và xác minh trước coding

- Pin tag phiên bản đầy đủ, có patch version; không dùng `latest` hoặc chỉ major tag.
- Chọn phiên bản còn được hỗ trợ và kiểm tra tag tồn tại trong registry khi lập implementation plan. Những tag cụ thể chưa được tuyên bố là đã xác minh trong phiên thiết kế.
- Implementation plan phải ghi rõ ba tag, PostgreSQL data mount destination và command health check thực sự có sẵn trong từng image.
- Không tự cài curl/wget vào container lúc khởi động, thêm custom Dockerfile hoặc mở cổng chỉ để thực hiện health check.
- Không nâng major PostgreSQL bằng cách đổi tag rồi tái sử dụng data directory cũ; việc nâng major cần kế hoạch riêng.

### 7.4. Giới hạn của việc dùng `.env`

Đây là lựa chọn có chủ đích cho lab cục bộ. Mật khẩu có thể xuất hiện trong container inspect hoặc output Compose đã resolve; người có quyền Docker phải được coi là có quyền truy cập secrets.

- Git ignore `.env`, bản dump, backup và dữ liệu phát sinh nhạy cảm.
- Không đưa giá trị thật vào tài liệu, screenshot, log hoặc command-line argument.
- Dùng `docker compose config --quiet` khi chỉ cần kiểm tra syntax; không chia sẻ output cấu hình đầy đủ đã resolve.
- Giới hạn quyền đọc `.env` trên host; không gửi file này qua hội thoại hoặc lưu trong backup công khai.
- Thay `.env` không tự đổi mật khẩu đã bootstrap trong PostgreSQL hay Grafana. Rotation phải dùng cơ chế quản trị của service, rồi đồng bộ cấu hình cần thiết; không xóa volume để đổi mật khẩu.

## 8. Health check, dependency và xử lý lỗi

| Service | Kiểm tra sức khỏe | Giới hạn của tín hiệu |
|---|---|---|
| Prometheus | HTTP `/-/ready` bên trong container | Không chứng minh Remote Write payload hợp lệ đã được ingest |
| Grafana | HTTP `/api/health`, yêu cầu thành công | Không chứng minh datasource Prometheus đang query được |
| PostgreSQL | `pg_isready` với user/database cấu hình | Không đủ để chứng minh password authentication hoặc quyền SQL đúng |

- Baseline health check: `interval: 10s`, `timeout: 5s`, `retries: 12`, `start_period: 30s`.
- Cả ba service có `restart: unless-stopped`.
- Container unhealthy không tự động được Docker Compose restart; cần xem log và xử lý nguyên nhân. Restart policy xử lý container exit theo chính sách, không phải cơ chế chữa mọi lỗi health.
- Không dùng `depends_on` bắt buộc giữa ba service hiện tại. PostgreSQL độc lập; Grafana có thể mở giao diện trước Prometheus và truy vấn khi upstream sẵn sàng.
- Khi Prometheus dừng, Grafana vẫn mở được nhưng truy vấn phải báo lỗi/không khả dụng; không hiển thị dữ liệu giả như dữ liệu mới.
- Khi PostgreSQL dừng, Grafana vẫn truy vấn Prometheus được.
- Sau thay đổi cấu hình, dùng quy trình recreate/restart thích hợp và chạy lại kiểm tra; không giả định mọi service hot-reload file mount.

## 9. Danh sách file triển khai dự kiến

Tất cả các file dưới đây là đầu ra tương lai của giai đoạn implementation, chưa được tạo bởi bản thiết kế này:

| File | Nội dung/trách nhiệm |
|---|---|
| `.env.example` | Mẫu biến đúng hợp đồng, không có secret thật |
| `.gitignore` | Bảo vệ `.env`, backup, dump và dữ liệu phát sinh |
| `README.md` | Trạng thái thực tế của Bước 1, prerequisites và Quick Start |
| `deploy/compose/compose.yaml` | Ba service, networks, named volumes, ports, logging, health checks |
| `observability/prometheus/prometheus.yml` | Global interval và job tự scrape Prometheus |
| `observability/grafana/provisioning/datasources/prometheus.yml` | Datasource mặc định UID cố định |
| `observability/grafana/provisioning/dashboards/providers.yml` | Provider cho file dashboard JSON |
| `observability/grafana/dashboards/.gitkeep` | Giữ thư mục nguồn dashboard trống trong repository |
| `docs/deployment/central-infrastructure.md` | Runbook Windows/WSL2, kiểm tra, persistence, backup/restore và troubleshooting |

Compose nằm trong `deploy/compose/`; relative bind-mount phải được tính từ thư mục Compose, không giả định nằm tại root. Runbook phải nhất quán về vị trí chạy lệnh và env-file.

Không sửa [INTRODUCT.md](<C:/MF/VSCODE/InfraPulse/INTRODUCT.md>) hoặc [AGENTS.md](<C:/MF/VSCODE/InfraPulse/AGENTS.md>) chỉ để đồng bộ cây minh họa. Không thêm README/test/verification script dưới `infra/`. Không thêm script kiểm thử hoặc dependency khi các lệnh CLI/runbook đã đáp ứng kiểm chứng hiện tại.

Tài liệu thiết kế hiện tại: [Central Infrastructure design](<C:/MF/VSCODE/InfraPulse/docs/superpowers/specs/2026-10-30-central-infrastructure-design.md>). Implementation plan chỉ được viết sau khi người dùng review và đồng ý bản này.

## 10. Khởi động và vận hành dự kiến

### 10.1. Prerequisites

- Docker Desktop đang chạy, dùng WSL2 backend và Linux containers.
- Docker Compose v2 hỗ trợ `up --wait`.
- Dành đủ RAM/disk cho cả Docker Desktop và stack; kiểm tra dung lượng VHDX/filesystem thực tế trước lần chạy đầu. Ngưỡng retention `5GB` không phải dự toán tổng dung lượng cần thiết.
- Host port `127.0.0.1:3000` chưa bị chiếm. Nếu bị chiếm, báo xung đột và thống nhất thay đổi; không tự bind ra `0.0.0.0`.
- Người vận hành đã tạo `.env` từ mẫu, thay password placeholder và bảo vệ file.
- Hướng dẫn chính chạy PowerShell tại root workspace. Không trộn đường dẫn Windows và WSL trong cùng một chuỗi lệnh; nếu chạy bằng WSL phải sử dụng bản hướng dẫn đường dẫn tương ứng.

### 10.2. Lệnh dự kiến

Các lệnh sau là hợp đồng vận hành sau khi có cấu hình, không phải lệnh đã được thực thi:

```powershell
docker version
docker compose version
docker compose --env-file .env -f deploy/compose/compose.yaml config --quiet
docker compose --env-file .env -f deploy/compose/compose.yaml run --rm --no-deps --entrypoint promtool prometheus check config /etc/prometheus/prometheus.yml
docker compose --env-file .env -f deploy/compose/compose.yaml up -d --wait --wait-timeout 180
docker compose --env-file .env -f deploy/compose/compose.yaml ps
```

`promtool` được dùng từ cùng image Prometheus đã pin, không tạo service kiểm thử thường trực. Image tags và command availability phải được xác minh trước implementation.

Truy cập Grafana bằng trình duyệt tại `http://127.0.0.1:3000`. Theo dõi log theo service khi cần; không đưa secret vào log.

### 10.3. Dừng, recreate và bảo toàn dữ liệu

```powershell
docker compose --env-file .env -f deploy/compose/compose.yaml down
docker compose --env-file .env -f deploy/compose/compose.yaml up -d --wait --wait-timeout 180
```

- Dùng cùng project name và file cấu hình để gắn lại các named volume đã có.
- Không dùng `down -v`, volume prune hoặc Docker Desktop reset trong vận hành bình thường.
- Restart/recreate không phải backup; hỏng/xóa Docker Desktop data disk vẫn có thể làm mất dữ liệu.
- Giới hạn logs không thay thế retention TSDB hoặc backup.

### 10.4. Backup/restore thủ công

Runbook triển khai phải hướng dẫn:

- PostgreSQL: logical backup bằng công cụ cùng major phù hợp (`pg_dump`/`pg_restore`), không đặt password trực tiếp trong command line; restore thử vào database/container kiểm chứng tách biệt.
- Grafana: dừng ghi/stop Grafana trước khi sao lưu SQLite cùng volume trạng thái để có bản sao nhất quán; giữ provisioning/config version tương ứng.
- Prometheus: dùng bản sao volume khi service đã dừng để có quy trình lab đơn giản; không bật admin API chỉ để chụp snapshot trong bước này.
- Backup được lưu ra ngoài data disk của Docker Desktop, không commit, có quyền truy cập phù hợp. Backup `.env` nếu có phải được bảo vệ riêng.
- Restore thử không ghi đè volume đang dùng; không thêm service backup tự động hay lịch backup trong Bước 1.

## 11. Kiểm chứng và tiêu chí nghiệm thu

### 11.1. Phân tầng kiểm tra

1. Cấu hình tĩnh: Compose interpolation/syntax và Prometheus configuration hợp lệ.
2. Runtime: health của từng service, flags thực tế, network và port binding.
3. Tích hợp hiện có: Grafana truy vấn Prometheus; PostgreSQL thực thi SQL với credential cấu hình.
4. Persistence và phục hồi: dữ liệu còn qua recreate; lỗi một service không bị che giấu hoặc kéo theo dependency không cần thiết.

Chưa có kết quả kiểm thử runtime trong phiên thiết kế. Không ghi rằng một lệnh đã pass nếu chưa chạy trên cấu hình thực tế.

### 11.2. Ma trận nghiệm thu

| Mã | Kiểm chứng | Điều kiện đạt |
|---|---|---|
| `CI-01` | Compose config và secret input | `config --quiet` thành công với cấu hình hợp lệ; thiếu/rỗng password bị từ chối; không xuất secret khi kiểm tra |
| `CI-02` | Prometheus config | `promtool check config` thành công bằng image đã pin |
| `CI-03` | Khởi động | `up --wait` thành công; đúng ba service chạy và healthy trong timeout nghiệm thu |
| `CI-04` | Port và network | Chỉ Grafana publish `127.0.0.1:3000`; không có host binding cho `9090` hoặc `5432`; PostgreSQL chỉ ở network database có `internal: true` |
| `CI-05` | Prometheus runtime | Storage tại `/prometheus`, receiver bật, retention time `7d`, size `5GB`, volume đúng; xác minh qua runtime flags/config thay vì chỉ đọc Compose |
| `CI-06` | Datasource provisioning | Grafana tự có datasource mặc định UID `infrapulse-prometheus`, URL nội bộ đúng; không thêm thủ công |
| `CI-07` | Query end-to-end hiện có | Sau một chu kỳ tự scrape thành công, Grafana Explore trả `up{job="prometheus"} = 1` |
| `CI-08` | SQL readiness thực tế | Dùng user/password cấu hình để kết nối TCP đến PostgreSQL và thực thi SQL, xác nhận database `infrapulse`; không chỉ dùng socket trust hoặc kết quả `pg_isready` |
| `CI-09` | Dashboard import | Import dashboard kiểm chứng tối thiểu qua UI, chọn datasource UID đã provision và lưu được; không cài custom plugin |
| `CI-10` | Persistence | Sau `down`/`up` không xóa volume, truy vấn được mẫu metrics đã ghi trước lần dừng tại khoảng thời gian cũ, dashboard UI đã lưu còn tồn tại, dữ liệu SQL kiểm chứng còn nguyên |
| `CI-11` | Lỗi/phục hồi Prometheus | Stop Prometheus: Grafana vẫn mở được, truy vấn báo lỗi; start Prometheus: truy vấn phục hồi mà không cần tạo lại datasource |
| `CI-12` | PostgreSQL độc lập | Stop PostgreSQL: Grafana vẫn query Prometheus được; start lại PostgreSQL và xác minh SQL hồi phục |
| `CI-13` | Logging và tài liệu | Logging rotation đúng; runbook đủ startup/shutdown, health, mật khẩu bootstrap/rotation, persistence và backup/restore thủ công |
| `CI-14` | Khôi phục dữ liệu kiểm chứng | Restore bản backup SQL vào đích kiểm chứng tách biệt và đọc lại sentinel; dữ liệu gốc không bị ghi đè |

SQL persistence có thể dùng schema/sentinel kiểm chứng tạm, không phải migration hoặc bảng nghiệp vụ. Phải dọn dữ liệu kiểm chứng sau nghiệm thu bằng thao tác nhắm đúng đối tượng, không drop database/volume thật.

Truy vấn sample cũ phải dùng khoảng thời gian đã ghi nhận trước recreate; chỉ thấy sample `up` mới không đủ chứng minh TSDB cũ đã được giữ.

Kiểm tra network không chỉ dựa vào việc không thấy port ở UI; phải kiểm tra cấu hình/runtime binding và membership của container. Chính sách loopback áp dụng cho Docker Desktop/Engine được hỗ trợ, không được suy rộng thành bảo đảm an toàn trước người có quyền host/Docker.

### 11.3. Remote Write: phạm vi bằng chứng

Trong Bước 1, kiểm tra receiver flag đang hoạt động, endpoint được đặt đúng trong network nội bộ và không publish ra host. Không gửi JSON hoặc body tùy ý rồi dùng HTTP 400/415 làm bằng chứng ingest thành công.

Không tuyên bố đã kiểm chứng binary protobuf/Snappy Remote Write end-to-end hoặc ràng buộc server identity. Chứng minh ingest thực sự cần payload đúng giao thức và query lại mẫu đã gửi; đó là kiểm chứng tích hợp của bước Gateway/agent, không phải tiêu chí bắt buộc của Bước 1 này.

## 12. Ngoài phạm vi

- Cài đặt hoặc cấu hình Telegraf trên máy đích.
- FastAPI Gateway, API Key, parsing protobuf/Snappy, identity enforcement hoặc buffer/retry nghiệp vụ.
- NestJS API, bảng nghiệp vụ, ORM, migration hoặc RBAC management.
- Grafana App Plugin, frontend độc lập, dashboard nghiệp vụ hoặc alert rules.
- AIOps, LLM, Telegram, remediation, Loki/Alloy hoặc queue/worker.
- Nginx, reverse proxy thay thế, public ingress, TLS cho truy cập LAN chưa được yêu cầu.
- Terraform, Kubernetes, HA, multi-tenant hoặc storage backend khác.
- Tự động hóa backup định kỳ, benchmark tải hoặc cam kết uptime/throughput.
- Khởi tạo Git, staging, commit, merge hoặc triển khai ngay sau khi duyệt spec.

## 13. Rủi ro và giới hạn được chấp nhận

| Rủi ro | Kiểm soát/giới hạn |
|---|---|
| Mật khẩu plaintext và environment inspect | Chỉ lab cục bộ; Git ignore; hạn chế host/Docker access; không chia sẻ output có secret |
| Không auth riêng cho receiver | Chỉ network monitoring tin cậy; không publish; không coi LAN là nguồn ingest trực tiếp |
| Mất Docker Desktop data disk | Named volumes không đủ; cần backup ra ngoài và kiểm chứng restore |
| Chạm retention size trước 7 ngày | Chấp nhận xóa dữ liệu sớm; theo dõi disk thực tế, không coi 5GB là quota tổng |
| Image không có HTTP client | Kiểm tra tooling khi pin version; không cài thêm công cụ lúc container boot |
| Layout PostgreSQL thay đổi theo major | Chốt tag và mount path cùng nhau trước coding; không nâng major tùy ý |
| Dependency bị hiểu sai | Grafana không dùng PostgreSQL; health từng service không chứng minh tích hợp |
| Dashboard UI khác file provisioning | Runbook giải thích nơi lưu, quyền sửa và cách chuyển JSON sang repository nếu cần sau này |
| Windows/WSL2 filesystem khác Linux server | Named volume cho dữ liệu; đường dẫn bind-mount được kiểm chứng trên Docker Desktop mục tiêu |

## 14. Gate trước implementation plan và coding

1. Người dùng review bản spec tổng hợp này; nếu có chỉnh sửa thì cập nhật và kiểm tra nhất quán lại.
2. Sau khi spec được duyệt, dùng skill `writing-plans` để lập các task cụ thể, file thay đổi, lệnh xác minh và acceptance checks theo thiết kế này.
3. Trong implementation plan, xác minh và ghi ba image tag đầy đủ, data mount PostgreSQL và health-check commands phù hợp image; không để việc này trở thành phỏng đoán khi coding.
4. Người dùng review kế hoạch. Do yêu cầu hiện tại chỉ là thiết kế/kế hoạch, không bắt đầu implementation nếu chưa có yêu cầu riêng.
5. Không staging/commit nếu chưa được người dùng cho phép sau khi review thay đổi.

Không còn quyết định kiến trúc chưa được trình bày trong phạm vi Bước 1. Việc review spec và xác minh chi tiết phụ thuộc image ở giai đoạn lập kế hoạch vẫn là các gate bắt buộc, không phải bằng chứng đã triển khai.

## 15. Tài liệu tham khảo

- Tài liệu nội bộ: [INTRODUCT.md](<C:/MF/VSCODE/InfraPulse/INTRODUCT.md>), đặc biệt mục 4, 6.6, 14, 15, 19 và 20.
- Quy định repository: [AGENTS.md](<C:/MF/VSCODE/InfraPulse/AGENTS.md>).
- Prometheus storage/retention: https://prometheus.io/docs/prometheus/latest/storage/
- Grafana Docker configuration: https://grafana.com/docs/grafana/latest/setup-grafana/configure-docker/
- Grafana provisioning: https://grafana.com/docs/grafana/latest/administration/provisioning/
- PostgreSQL official image: https://hub.docker.com/_/postgres
- Docker Compose service/network reference: https://docs.docker.com/reference/compose-file/services/ và https://docs.docker.com/reference/compose-file/networks/

Các đường dẫn chính thức là nguồn tham khảo để kiểm chứng chi tiết image/config ở giai đoạn lập kế hoạch. Không có tuyên bố rằng tag image hoặc runtime đã được kiểm thử trong tài liệu thiết kế này.
