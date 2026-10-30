# InfraPulse — Central Infrastructure: Implementation Plan

> **Dành cho Agent thực hiện:** Bắt buộc dùng `subagent-driven-development` (khuyến nghị của bộ kỹ năng) hoặc `executing-plans` để thực hiện lần lượt từng task. Theo dõi tiến độ bằng checkbox (`- [ ]`).

**Mục tiêu:** Triển khai và nghiệm thu nền tảng lab gồm Prometheus, Grafana và PostgreSQL trên Windows + Docker Desktop/WSL2, đúng phạm vi Bước 1.

**Kiến trúc:** Một Compose project `infrapulse`; Grafana và Prometheus dùng network `monitoring`, PostgreSQL chỉ dùng `database` có `internal: true`. Ba named volume giữ dữ liệu; chỉ Grafana publish loopback; provisioning kết nối Grafana → Prometheus mà không phụ thuộc PostgreSQL.

**Công nghệ:** Docker Engine/Linux containers, Docker Compose v2, PowerShell, Prometheus `v3.13.5-busybox`, Grafana `13.3.0`, PostgreSQL `18.6-bookworm`.

**Đặc tả:** [Thiết kế Central Infrastructure đã được người dùng duyệt](<../specs/2026-10-30-central-infrastructure-design.md>), nhất là §§5–11. Đọc cả spec và plan trước khi thực hiện. Người dùng đã duyệt spec trong hội thoại; **kế hoạch này chưa phải quyền triển khai**.

## Ràng buộc toàn cục

- Hiện tại chỉ ghi tài liệu kế hoạch. Chờ review plan và yêu cầu thực hiện riêng trước khi tạo cấu hình, pull image, chạy container hoặc tạo dữ liệu nghiệm thu.
- Môi trường nghiệm thu: `Windows + Docker Desktop/WSL2, Linux containers`; lệnh chính chạy PowerShell tại root workspace. Không trộn đường dẫn WSL với Windows.
- Chỉ ba service `prometheus`, `grafana`, `postgres`; không `container_name`, static IP, `depends_on` bắt buộc, default network dùng chung hoặc Docker socket mount.
- Chỉ host binding `127.0.0.1:3000:3000`; không publish `9090`, `5432`, `8000`, `3001`. Không tự nới binding khi port bị chiếm.
- Prometheus: retention `7d` và `5GB`, self-scrape `30s`; `5GB` không phải quota cứng hoặc bảo đảm đủ bảy ngày dữ liệu.
- Ba named volume `prometheus_data`, `grafana_data`, `postgres_data`; không `down -v`, volume prune hoặc reset Docker Desktop.
- Grafana dùng SQLite, datasource UID `infrapulse-prometheus`; không dùng PostgreSQL làm Grafana internal DB.
- `.env` tại root chỉ cho lab, không version-control; truyền từng biến bằng `environment`, không dùng `env_file`, `*_FILE` hoặc secret file.
- Mọi image tag phải có patch version. Không tự đổi major PostgreSQL, không cài HTTP client khi container boot, không custom Dockerfile/plugin.
- Health baseline: `interval: 10s`, `timeout: 5s`, `retries: 12`, `start_period: 30s`; mọi service `restart: unless-stopped` và `json-file` với `max-size: 10m`, `max-file: 3`.
- Không thêm backend, agent, dashboard nghiệp vụ, alert, Nginx, Terraform, lịch backup, dependency hoặc script kiểm thử. Không tạo README/test dưới `infra/`.
- Không sửa [INTRODUCT.md](<../../../INTRODUCT.md>) hoặc [AGENTS.md](<../../../AGENTS.md>). Không khởi tạo Git, stage hoặc commit; mọi checkpoint bên dưới là checkpoint review, không phải commit.
- Không xuất secret qua `config`, full `inspect`, log, screenshot hoặc command-line argument. Chỉ dùng `config --quiet` hoặc output đã chọn lọc.

## Review Focus

| Đầu vào/điều kiện dễ gây lỗi | Hành vi bắt buộc và kiểm chứng sở hữu |
|---|---|
| Mật khẩu thiếu/rỗng; dấu `$`, `#`; environment của shell ghi đè dotenv | Reject thiếu/rỗng; giữ nguyên literal được single-quote trong dotenv; thông báo precedence và không in giá trị. Task 1: `env_required_and_literal`. |
| Compose ở thư mục con; source bind-mount bị thiếu hoặc sai loại | Resolve từ `deploy/compose`; file cấu hình thiếu phải fail rõ, không âm thầm tạo directory. Tasks 1–2: `bind_mount_contract`. |
| Volume đã bootstrap nhưng operator sửa `.env` | Không coi `.env` là rotation; password cũ còn hiệu lực đến khi đổi trong service; không xóa volume. Tasks 3, 6: `bootstrap_is_not_rotation`. |
| Upstream dừng nhưng Grafana vẫn healthy hoặc hiển thị dữ liệu cũ | Truy vấn mới báo lỗi khi Prometheus dừng; PostgreSQL dừng không làm hỏng metrics. Task 4: `independent_failure_recovery`. |
| Recreate/restore trỏ nhầm project, volume hoặc database | Chứng minh mẫu metrics cũ, SQL sentinel và dashboard còn nguyên; restore vào đích riêng, không ghi đè live. Tasks 5–6: `historical_persistence`, `isolated_restore`. |

---

## 1. Hiện trạng và chi tiết đã xác minh khi lập kế hoạch

Ngày kiểm tra: **2026-10-30**. Docker Desktop `4.55.0`, Engine `29.1.3`, context `desktop-linux`, Compose `v2.40.3-desktop.1` đang khả dụng. Workspace chưa có `.git`; các cây `deploy/` và `observability/` chưa có file triển khai. Code Graph project `C-MF-VSCODE-InfraPulse` ready nhưng loại trừ `deploy/`, và metadata tài liệu chưa được theo dõi đầy đủ; đã đọc trực tiếp tài liệu và kiểm tra các scope bằng filesystem. Đây là hiện trạng khảo sát, phải kiểm tra lại khi thực hiện.

### Image pin và health-check contract

| Service | Tag mặc định đã kiểm tra registry, có Linux/amd64 | Tooling/volume contract |
|---|---|---|
| Prometheus | `prom/prometheus:v3.13.5-busybox` | LTS 3.13 còn hỗ trợ tới `2027-07-31`; image có `/bin/promtool`, BusyBox và `/bin/wget`; volume → `/prometheus`. Chọn variant BusyBox tường minh, không giả định distroless có shell/HTTP client. |
| Grafana | `grafana/grafana:13.3.0` | Tag mặc định dùng Alpine, Dockerfile cài `curl`; UID `472`; volume → `/var/lib/grafana`. Dòng 13.3.x có patch support tới `2027-07-20`. |
| PostgreSQL | `postgres:18.6-bookworm` | Major 18 còn hỗ trợ; package `postgresql-18` có `pg_isready`, `psql`, `pg_dump`, `pg_restore`. **Volume → `/var/lib/postgresql`; `PGDATA=/var/lib/postgresql/18/docker`**, không mount vào layout major cũ `/var/lib/postgresql/data`. |

Nguồn: [registry Prometheus](https://hub.docker.com/v2/repositories/prom/prometheus/tags/v3.13.5-busybox), [registry Grafana](https://hub.docker.com/v2/repositories/grafana/grafana/tags/13.3.0), [registry PostgreSQL](https://hub.docker.com/v2/repositories/library/postgres/tags/18.6-bookworm), [Prometheus LTS](https://prometheus.io/docs/introduction/release-cycle/), [Grafana support](https://grafana.com/docs/grafana/latest/upgrade-guide/when-to-upgrade/), [PostgreSQL support](https://www.postgresql.org/support/versioning/).

Tooling đã đối chiếu qua [Prometheus Dockerfile](https://github.com/prometheus/prometheus/blob/v3.13.5/Dockerfile), [BusyBox base](https://github.com/prometheus/busybox/blob/master/glibc/Dockerfile), [Grafana Dockerfile](https://github.com/grafana/grafana/blob/v13.3.0/Dockerfile), [PostgreSQL Dockerfile](https://github.com/docker-library/postgres/blob/master/18/bookworm/Dockerfile) và registry image config. Đã đọc archive base-layer của image Prometheus để xác nhận `bin/busybox`, `bin/sh`, `bin/wget`, không pull vào Engine hoặc chạy container. Nguồn nhánh `master` là mutable; khi thực hiện phải đối chiếu lại tag và kiểm tra executable theo Task 3. **Chưa có kết quả health/runtime của stack**.

Health-check Compose cần viết chính xác:

```yaml
# prometheus.healthcheck.test
["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:9090/-/ready"]
# grafana.healthcheck.test
["CMD", "curl", "--fail", "--silent", "--show-error", "--output", "/dev/null", "http://127.0.0.1:3000/api/health"]
# postgres.healthcheck.test — $$ trì hoãn expansion tới shell trong container
["CMD-SHELL", "pg_isready -h 127.0.0.1 -U \"$${POSTGRES_USER}\" -d \"$${POSTGRES_DB}\""]
```

Registry tag không bất biến; recheck trước pull. Nếu tag/tooling/support thay đổi, dừng để thống nhất cập nhật pin, không tự thay bằng `latest` hoặc variant khác.

## 2. Bản đồ file và thứ tự thực hiện

| Task | File sẽ tạo | Trách nhiệm |
|---|---|---|
| 1 | `.env.example`, `.gitignore`, `deploy/compose/compose.yaml`, `observability/prometheus/prometheus.yml` | Hợp đồng input, Compose topology, storage/health/logging và self-scrape. |
| 2 | `observability/grafana/provisioning/datasources/prometheus.yml`, `observability/grafana/provisioning/dashboards/providers.yml`, `observability/grafana/dashboards/.gitkeep` | Datasource và dashboard provider; repository không có dashboard nghiệp vụ. |
| 3–6 | `docs/deployment/central-infrastructure.md` | Runbook được viết cùng từng nhóm kiểm chứng, không dồn kiểm chứng vào cuối. |
| 6 | `README.md` | Trạng thái thực tế, prerequisites, Quick Start và link runbook. |

Nếu các file đã xuất hiện khi bắt đầu thực hiện: đọc trước, đối chiếu với yêu cầu và giữ nguyên thay đổi không liên quan; đổi thao tác “tạo” thành sửa có mục tiêu. `.env`, dump/archive và dữ liệu CI là **local artifacts**, không phải file bàn giao.

Các task có thứ tự `1 → 2 → 3 → 4 → 5 → 6`. Chọn một luồng thực hiện tuần tự; không để nhiều agent dùng chung Docker project hoặc đồng thời sửa runbook.

### Quy ước lệnh dùng trong toàn bộ runbook

Sau khi operator tự tạo `.env` từ mẫu, thay password và bảo vệ quyền đọc, dùng một phiên PowerShell tại root:

```powershell
$dc = @('--env-file', '.env', '-f', 'deploy/compose/compose.yaml')
docker compose @dc config --quiet
```

Mọi lệnh native cần kiểm tra `$LASTEXITCODE`; chỉ tiếp tục khi đúng exit code dự kiến. Không dùng `docker compose config` không lọc. Trong PowerShell, gửi shell/SQL nhiều dòng qua **single-quoted here-string** vào `exec -T ... sh`; không đặt mật khẩu vào argument hoặc nội suy ở host. GUI đăng nhập do operator nhập riêng.

---

## Task 1 — Compose foundation và cấu hình Prometheus

**File:** Tạo `.env.example`, `.gitignore`, `deploy/compose/compose.yaml`, `observability/prometheus/prometheus.yml`.

**Interfaces:**
- Input: biến root theo bảng dưới; hai password là bắt buộc.
- Output: project `infrapulse`; ba service cùng tên thiết kế; network `monitoring`, `database`; ba volume logical name đúng spec. Các task sau chỉ dùng service DNS và `$dc`, không đoán container ID.

- [ ] **1. Khóa kiểm chứng trước khi viết cấu hình.** Chạy `Test-Path` cho bốn file, ghi nhận trạng thái ban đầu. Với workspace hiện tại, `docker compose --env-file .env.example -f deploy/compose/compose.yaml config --quiet` phải thất bại vì input chưa tồn tại; nếu đã có file thì không dùng lỗi này làm bằng chứng red.
- [ ] **2. Tạo mẫu environment và ignore.** Mẫu dùng các giá trị sau, password để rỗng kèm chú thích bắt buộc thay. Ignore `.env`, `.env.*` nhưng cho phép `!.env.example`; thêm `backups/`, `*.dump`, `/infrapulse-*.sql`, `*.tar`, `*.tar.gz`, `*.tgz` (không ignore mọi `*.sql` vì có thể che migration tương lai) và các thư mục dữ liệu local nếu được hướng dẫn dùng. Không ignore file cấu hình cần bàn giao. Không khởi tạo Git để thử ignore; khi chưa có `.git`, chỉ review patterns và ghi rõ chưa thể xác minh Git ignore thực tế.

| Root variable | Giá trị mẫu / mapping |
|---|---|
| `PROMETHEUS_IMAGE_TAG` | `v3.13.5-busybox` |
| `GRAFANA_IMAGE_TAG` | `13.3.0` |
| `POSTGRES_IMAGE_TAG` | `18.6-bookworm` |
| `PROMETHEUS_RETENTION_TIME` | `7d` |
| `PROMETHEUS_RETENTION_SIZE` | `5GB` |
| `GRAFANA_ADMIN_USER` | `admin` → `GF_SECURITY_ADMIN_USER` |
| `GRAFANA_ADMIN_PASSWORD` | Rỗng → `GF_SECURITY_ADMIN_PASSWORD` |
| `POSTGRES_DB` | `infrapulse` |
| `POSTGRES_USER` | `postgres`, bootstrap superuser |
| `POSTGRES_PASSWORD` | Rỗng; chỉ truyền cho PostgreSQL |

- [ ] **3. Viết Compose.** `name: infrapulse`; image dùng tag variable bắt buộc `${...:?message}`. Hai password dùng `${GRAFANA_ADMIN_PASSWORD:?GRAFANA_ADMIN_PASSWORD must be set and non-empty}` và `${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set and non-empty}`. Retention/user/database dùng default theo bảng. Không truyền toàn bộ `.env` cho container. Grafana đặt `GF_AUTH_ANONYMOUS_ENABLED=false`, `GF_USERS_ALLOW_SIGN_UP=false`, `GF_DATABASE_TYPE=sqlite3`; không cấu hình tải plugin. PostgreSQL đặt cố định `POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=trust` và `POSTGRES_HOST_AUTH_METHOD=scram-sha-256`, không thêm biến root cho hai setting này. `initdb` mặc định có thể tạo host-loopback `trust`, còn entrypoint chỉ append rule host rộng ở cuối; phải khóa TCP authentication ngay khi init, không để probe `127.0.0.1` vô tình qua trust. Xem [initdb authentication](https://www.postgresql.org/docs/18/app-initdb.html) và [official entrypoint](https://github.com/docker-library/postgres/blob/master/docker-entrypoint.sh). Với volume đã tồn tại, init args không viết lại HBA; kiểm tra/migrate HBA có chủ đích nếu probe sai password vẫn thành công, không reset volume. Áp dụng health/logging/restart theo contract và topology đúng spec.
- [ ] **4. Khóa đường dẫn và Prometheus flags.** Dùng bind-mount long syntax `read_only: true`, `bind.create_host_path: false`: `../../observability/prometheus/prometheus.yml` → `/etc/prometheus/prometheus.yml`; `../../observability/grafana/provisioning` → `/etc/grafana/provisioning`; `../../observability/grafana/dashboards` → `/etc/grafana/dashboards`. Data mounts: `prometheus_data:/prometheus`, `grafana_data:/var/lib/grafana`, `postgres_data:/var/lib/postgresql`. Prometheus command gồm `--config.file=/etc/prometheus/prometheus.yml`, `--storage.tsdb.path=/prometheus`, `--web.enable-remote-write-receiver`, hai retention flags đọc biến tương ứng; không lifecycle/admin API. Viết `global.scrape_interval: 30s`, `evaluation_interval: 30s`, một job `prometheus`, target `prometheus:9090`; không outbound `remote_write`.
- [ ] **5. Kiểm tra `env_required_and_literal` và syntax mà không start container.** Tạo các env fixture tạm **ngoài repository** chỉ chứa dữ liệu giả và ba pin ở bảng; không sao chép `.env` thật. Dùng `docker compose --env-file <fixture> -f deploy/compose/compose.yaml config --quiet`. Bốn case: thiếu từng key password; từng password rỗng; cả hai non-empty; hai literal `GRAFANA_ADMIN_PASSWORD='ci$grafana#not-a-secret'`, `POSTGRES_PASSWORD='ci$postgres#not-a-secret'`. Hai nhóm đầu exit nonzero, hai nhóm cuối exit 0. Tạm bỏ các biến trùng tên trong process environment rồi khôi phục trong `finally`; không sửa environment cấp user/machine. Với fixture giả cuối, capture `config --format json` **vào biến, không in raw output**, assert giá trị resolve bằng chuỗi literal và không có password DB trong Grafana/Prometheus. Kiểm chứng shell override bằng một giá trị giả khác rồi khôi phục process environment. Xóa đúng fixture tạm sau khi kiểm tra resolved absolute path.
- [ ] **6. Review checkpoint.** Đối chiếu service/network/volume/port/mount và CI-01 trên cấu hình đã resolve bằng fixture giả. Chưa `up`: provisioning files của Task 2 chưa sẵn sàng. Không stage/commit.

## Task 2 — Provision Grafana từ repository

**File:** Tạo ba file Grafana trong bản đồ file.

**Interfaces:**
- Input: Prometheus DNS `http://prometheus:9090`, mounts của Task 1.
- Output: datasource UID `infrapulse-prometheus`; dashboard file provider `infrapulse`, path `/etc/grafana/dashboards`.

- [ ] **1. Xác nhận red cho `bind_mount_contract`.** Kiểm tra hai file provisioning chưa có; trên workspace đã có cấu hình, đối chiếu nội dung thay vì khẳng định red do thiếu file. Không chạy Compose để tự tạo directory còn thiếu.
- [ ] **2. Viết datasource.** `apiVersion: 1`; một datasource `name: Prometheus`, `type: prometheus`, `orgId: 1`, `uid: infrapulse-prometheus`, `access: proxy`, `url: http://prometheus:9090`, `isDefault: true`, `editable: false`, `version: 1`; `jsonData.timeInterval: 30s`. Không datasource PostgreSQL, không credential không dùng.
- [ ] **3. Viết provider và `.gitkeep`.** `apiVersion: 1`; provider `name: infrapulse`, `orgId: 1`, `folder: InfraPulse`, `type: file`, `disableDeletion: false`, `allowUiUpdates: false`, `updateIntervalSeconds: 30`, `options.path: /etc/grafana/dashboards`, `options.foldersFromFilesStructure: false`. File `.gitkeep` rỗng; không dashboard JSON cố định.
- [ ] **4. Chạy lại config check với fixture giả hợp lệ của Task 1.** Exit 0. Assert source Prometheus là leaf file; hai source Grafana là directory; resolved paths đều nằm trong workspace, tất cả bind-mount read-only và không auto-create host path. Đối chiếu YAML với [quy tắc provisioning](https://grafana.com/docs/grafana/latest/administration/provisioning/). Chưa gọi health là pass; Grafana sẽ thực sự parse provisioning ở Task 3.
- [ ] **5. Review checkpoint.** Xác nhận CI-06 có thể được chứng minh từ provisioning, không có dashboard nghiệp vụ và không cài plugin. Không stage/commit.

## Task 3 — Runbook khởi động, health, network và SQL authentication

**File:** Tạo `docs/deployment/central-infrastructure.md`; không thêm file kiểm thử.

**Interfaces:**
- Input: Task 1–2 hoàn chỉnh, operator đã điền `.env` riêng.
- Output: các lệnh startup/diagnostic chạy được; CI-01–CI-08, binding và credentials được kiểm chứng độc lập với health.

- [ ] **1. Viết phần prerequisites và preflight trước startup.** Docker Desktop dùng WSL2/Linux containers; `docker version`, `docker compose version`, kiểm tra RAM/disk Docker Desktop/VHDX và port bằng `Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue`. Port chiếm → dừng, không đổi binding. Giải thích dotenv single quote giữ `$`/`#`, không dùng `admin/admin`, không gửi `.env`; shell environment ưu tiên hơn env-file. Ghi cơ chế bootstrap/rotation khác nhau; tài khoản PostgreSQL hiện tại là superuser, không cấp nó cho ứng dụng tương lai.
- [ ] **2. Sau khi được phép thực hiện, pull pin và kiểm tra tool availability.** `docker compose @dc pull`; chạy `run --rm --no-deps --entrypoint sh prometheus -c 'command -v wget && command -v promtool'`, lệnh tương tự cho Grafana với `curl`, PostgreSQL với `pg_isready`, `psql`, `pg_dump`, `pg_restore`, `tar`. Chỉ là one-off tooling check, không service mới. Nếu thiếu tool: fail và review pin, không cài thêm package. Ghi rõ one-off container/volume phụ nếu có để kiểm tra và dọn đúng đối tượng; không prune.
- [ ] **3. Kiểm tra Prometheus rồi startup.** Chạy bốn lệnh dưới, mọi lệnh exit 0; `ps` đúng ba service healthy. `promtool` là CI-02, không thay cho runtime CI-03.

```powershell
docker compose @dc config --quiet
docker compose @dc run --rm --no-deps --entrypoint promtool prometheus check config /etc/prometheus/prometheus.yml
docker compose @dc up -d --wait --wait-timeout 180
docker compose @dc ps
```

- [ ] **4. Kiểm tra runtime CI-04/CI-05/CI-13.** Lấy IDs bằng `docker compose @dc ps -q`; chỉ inspect các trường `.Name`, `.NetworkSettings.Ports`, `.NetworkSettings.Networks`, `.Mounts`, `.HostConfig.LogConfig`, `.HostConfig.RestartPolicy`, `.State.Health.Status`. `docker network inspect infrapulse_database --format '{{.Internal}}'` phải `true`. Grafana/Prometheus chỉ thuộc `infrapulse_monitoring`, PostgreSQL chỉ `infrapulse_database`; chỉ Grafana có HostIp `127.0.0.1`, HostPort `3000`. Phân biệt port exposed metadata và host binding. Mount PostgreSQL phải dùng đúng named volume ở `/var/lib/postgresql`, không anonymous volume thay thế data. Logging/restart đúng contract.
- [ ] **5. Đọc runtime Prometheus.** Dùng các request từ bên trong container, không publish 9090:

```powershell
$flags = docker compose @dc exec -T prometheus wget -q -O - http://127.0.0.1:9090/api/v1/status/flags | ConvertFrom-Json
$runtimeConfig = docker compose @dc exec -T prometheus wget -q -O - http://127.0.0.1:9090/api/v1/status/config | ConvertFrom-Json
```

Assert API `status=success`, flag receiver `true`, TSDB path `/prometheus`, retention tương đương `7d` và `5GB` nếu API chuẩn hóa đơn vị; runtime config có job `prometheus`, target `prometheus:9090`, interval `30s`. Không gửi body JSON/tùy ý tới Remote Write rồi coi lỗi HTTP là ingest pass. Không tuyên bố kiểm chứng protobuf/Snappy hay Gateway.
- [ ] **6. Chứng minh SQL qua TCP, bao gồm sai mật khẩu.** Thêm vào runbook hai probe qua single-quoted here-string như bên dưới; probe đúng phải exit 0, database `infrapulse`, user theo `.env`; probe sai phải exit nonzero/password authentication failed. Không chạy bằng socket trust và không chỉ dựa vào `pg_isready`.

```powershell
@'
export PGPASSWORD="$POSTGRES_PASSWORD" PGCONNECT_TIMEOUT=5
exec psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -w -v ON_ERROR_STOP=1 -c 'SELECT current_database(), current_user;'
'@ | docker compose @dc exec -T postgres sh

@'
export PGPASSWORD=ci-intentionally-wrong PGCONNECT_TIMEOUT=5
exec psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -w -v ON_ERROR_STOP=1 -c 'SELECT 1;'
'@ | docker compose @dc exec -T postgres sh
```

- [ ] **7. Kiểm chứng Grafana CI-06/CI-07 và auth.** Mở `http://127.0.0.1:3000`; cửa sổ chưa login không xem dashboard qua anonymous và không có sign-up. Operator đăng nhập bằng credential riêng; datasource có UID đúng, default, proxy URL nội bộ và không sửa được. Explore trả `up{job="prometheus"}=1` sau khi self-scrape thành công; retry có giới hạn tối đa 90s, không sleep mù hoặc bỏ qua lỗi. Lưu kết quả đã lọc secret trong phần nghiệm thu runbook khi thực hiện, không điền PASS trước.
- [ ] **8. Kiểm chứng `bootstrap_is_not_rotation` trên PostgreSQL cô lập, ghi hướng dẫn cho cả hai service.** Không đổi password thật chỉ để thử. Dùng hai env fixture giả ngoài repository, A/B chỉ khác `POSTGRES_PASSWORD`, cùng ba pin và Grafana password giả non-empty; process environment không được ghi đè fixture. Tạo project test duy nhất `infrapulse-bootstrap-ci-<unique>`, luôn truyền `-p <ci-project>` cùng `--env-file <A-or-B> -f deploy/compose/compose.yaml`; chỉ `up ... postgres`, không start Grafana/Prometheus hoặc publish thêm port. Init PostgreSQL qua A, xác nhận TCP đúng/sai password; recreate **cùng project/volume** bằng B (`up -d --force-recreate --wait --wait-timeout 180 postgres`). Probe `exec` lấy password B từ environment phải fail; probe client one-off `run --rm --no-deps --entrypoint sh postgres` với fixture A, `PGPASSWORD` từ container environment và `psql -h postgres ...` phải thành công. So sánh volume mount vẫn cùng tên, chỉ container ID đổi. Trong `finally`, `down` đúng project test, inspect volume name/label để chắc chắn thuộc lần thử rồi chỉ xóa volume test đó; không `down -v`, không prune/live volume. Dọn đúng fixtures đã tạo. Ghi rõ đây là runtime test PostgreSQL, không suy rộng thành đã thử rotation Grafana. Runbook giải thích `.env` không tự rotate cả hai service; đổi thật bằng `\password` ở phiên quản trị tương tác/cơ chế đổi hoặc reset admin chính thức của Grafana rồi đồng bộ `.env`, không đặt secret trong argument/log. Review checkpoint, không commit.

## Task 4 — Nghiệm thu failure isolation và phục hồi

**File:** Bổ sung phần lỗi/phục hồi trong `docs/deployment/central-infrastructure.md`.

**Interfaces:** Input stack healthy và datasource provisioned; output quy trình CI-11/CI-12 không có dependency giả.

- [ ] **1. Viết kỳ vọng `independent_failure_recovery` trước khi chạy.** Baseline `up{job="prometheus"}=1`; Grafana healthy không chứng minh datasource healthy; unhealthy không tự kích hoạt restart policy. Truy vấn tức thời/làm mới bắt buộc, không chấp nhận ảnh đồ thị cũ làm bằng chứng.
- [ ] **2. Stop Prometheus.** `docker compose @dc stop prometheus`; Grafana vẫn mở được nhưng **Refresh/Run query mới** trong Explore phải báo upstream error. Không coi một sample cũ trên màn hình là giá trị mới. Trong `finally`, chạy `docker compose @dc up -d --wait --wait-timeout 180 prometheus`; query mới trở lại `1`, cùng UID datasource, không tạo lại datasource.
- [ ] **3. Stop PostgreSQL.** `docker compose @dc stop postgres`; lặp query mới trên Grafana, vẫn nhận `1`. Trong `finally`, `docker compose @dc up -d --wait --wait-timeout 180 postgres`; probe TCP đúng của Task 3 thành công. Nếu lệnh dừng/query lỗi, vẫn phải cố phục hồi đúng service và báo trạng thái còn lại.
- [ ] **4. Review checkpoint.** Cả ba service healthy lại; runbook có `logs --tail 100 <service>` và chỉ dẫn redaction trước khi chia sẻ, phân biệt startup/config error với datasource error. Không thêm `depends_on` để che lỗi và không commit.

## Task 5 — Dashboard import, provisioning policy và persistence lịch sử

**File:** Bổ sung runbook; JSON/schema kiểm chứng là local/tạm, không bàn giao dashboard nghiệp vụ.

**Interfaces:**
- Input: stack đã phục hồi; UID `infrapulse-prometheus`.
- Output: ba dấu mốc trước recreate: sample timestamp thực, dashboard UID `infrapulse-ci-ui`, SQL sentinel. Giữ SQL sentinel tới Task 6 để restore-check.

- [ ] **1. Chuẩn bị `historical_persistence`.** Trước tạo, kiểm tra dashboard UID và schema `infrapulse_ci` chưa tồn tại; nếu collision thì dừng, không ghi đè đối tượng không rõ chủ sở hữu. Import qua UI bằng JSON tối thiểu dưới, datasource cố định và lưu dashboard. Đây là CI-09, không dùng dashboard tải Internet.

```json
{
  "uid": "infrapulse-ci-ui", "title": "InfraPulse CI — temporary",
  "schemaVersion": 39, "version": 0, "tags": ["infrapulse-ci"],
  "time": {"from": "now-15m", "to": "now"},
  "panels": [{
    "id": 1, "type": "timeseries", "title": "Prometheus self up",
    "gridPos": {"x": 0, "y": 0, "w": 24, "h": 8},
    "datasource": {"type": "prometheus", "uid": "infrapulse-prometheus"},
    "targets": [{"refId": "A", "expr": "up{job=\"prometheus\"}"}]
  }]
}
```

- [ ] **2. Tạo sentinel chỉ trong schema kiểm chứng, qua TCP theo Task 3.** `psql` dùng `ON_ERROR_STOP=1`; không init SQL/migration. Chạy đúng SQL sau và query lại row:

```sql
CREATE SCHEMA infrapulse_ci;
CREATE TABLE infrapulse_ci.persistence_probe (id integer PRIMARY KEY, note text NOT NULL);
INSERT INTO infrapulse_ci.persistence_probe VALUES (1, 'central-infra-ci-20261030');
SELECT * FROM infrapulse_ci.persistence_probe;
```

- [ ] **3. Ghi sample timestamp thực của metrics trước dừng.** Qua `exec ... wget`, query URL `http://127.0.0.1:9090/api/v1/query?query=timestamp%28up%7Bjob%3D%22prometheus%22%7D%29`; parse JSON, `status=success`, một result. Lưu **`data.result[0].value[1]`** thành `$sampleTs` trong phiên PowerShell và ghi chú không nhạy cảm; đây là timestamp của sample do `timestamp(up)` trả, không phải evaluation timestamp `value[0]`. Lưu container IDs trước recreate để so sánh.
- [ ] **4. Recreate không xóa dữ liệu.** `docker compose @dc down`, rồi `docker compose @dc up -d --wait --wait-timeout 180`. Đúng cùng project/env-file. Assert IDs mới; query `up{job="prometheus"}` với tham số API `time=$sampleTs` trả `1`; dashboard UID vẫn còn, SQL row vẫn đúng. Chỉ thấy sample mới sau startup không đủ pass CI-10. Không chạy `down -v`.
- [ ] **5. Thử file-provider policy có cleanup.** Tạo tạm `observability/grafana/dashboards/ci-file-check.json` từ JSON trên nhưng đổi UID thành `infrapulse-ci-file`, title khác; phải kiểm tra path chưa tồn tại. Chờ tối đa 90s/provider reload hoặc restart Grafana có kiểm soát; dashboard xuất hiện trong folder `InfraPulse`, không lưu sửa đổi qua UI được. Xóa **chỉ** file tạm sau khi xác minh absolute path; provider xóa dashboard đó, dashboard UI `infrapulse-ci-ui` vẫn còn. Kết thúc thư mục dashboard repository chỉ có `.gitkeep`; không để JSON nghiệm thu trong đầu ra triển khai.
- [ ] **6. Review checkpoint.** CI-09/CI-10 có bằng chứng riêng cho từng storage; không coi restart đơn thuần là backup. Chưa xóa schema sentinel trước backup/restore Task 6. Không commit.

## Task 6 — Backup/restore tách biệt, Quick Start và đối chiếu nghiệm thu

**File:** Hoàn thiện `docs/deployment/central-infrastructure.md`; tạo `README.md`.

**Interfaces:**
- Input: schema/sentinel của Task 5, các volume runtime đã inspect.
- Output: runbook backup/restore không phá live data; README Quick Start; ma trận CI-01–CI-14 có kết quả thật hoặc lý do chưa chạy.

- [ ] **1. Viết `isolated_restore` trước thao tác backup.** Chọn thư mục backup host **ngoài workspace và Docker Desktop data disk**, ví dụ `C:\MF\Backups\InfraPulse\<timestamp>`; xác minh absolute path, quyền truy cập và dung lượng. Không ghi đè archive có sẵn. Phân biệt config/provisioning, `.env` được bảo vệ riêng và ba kho dữ liệu. Mọi restore dùng database/volume mới; không ghi đè live volume.
- [ ] **2. Logical backup PostgreSQL, không redirect binary qua PowerShell.** Qua `exec -T postgres sh` với password lấy từ environment bên trong, chạy `pg_dump -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -w -Fc -f /tmp/infrapulse-ci.dump` với `PGPASSWORD` export. Sau exit 0, dùng `docker compose @dc cp postgres:/tmp/infrapulse-ci.dump <absolute-host-backup-path>`; kiểm tra file có dung lượng và `pg_restore --list` đọc được archive. Không dùng `docker exec ... pg_dump > backup.dump`, tránh hỏng binary do encoding PowerShell. Bản dump chứa dữ liệu nhạy cảm, không in nội dung/share/commit. Runbook hướng dẫn backup toàn DB; không giả định logical dump bao gồm role/global objects.
- [ ] **3. Restore PostgreSQL vào database riêng từ bản backup host.** Copy **file đã lưu ở host** trở lại đường dẫn mới bằng `docker compose @dc cp <absolute-host-backup-path> postgres:/tmp/infrapulse-ci-restore.dump`; không restore trực tiếp từ dump gốc còn trong container. Kiểm tra `infrapulse_ci_restore` chưa tồn tại; dùng `createdb -h 127.0.0.1 -U "$POSTGRES_USER" -w infrapulse_ci_restore` với password environment trong container. `pg_restore -h 127.0.0.1 -U "$POSTGRES_USER" -d infrapulse_ci_restore -w --no-owner --no-privileges --exit-on-error /tmp/infrapulse-ci-restore.dump`; query row trong `infrapulse_ci.persistence_probe`, phải đúng `(1, 'central-infra-ci-20261030')`. Query lại live DB để xác nhận không bị ghi đè. Đây là CI-14, không restore vào `infrapulse`.
- [ ] **4. Hướng dẫn cold backup hai volume còn lại.** Stop Grafana/Prometheus trước khi copy; lấy **tên volume thực từ `.Mounts`**, `docker volume inspect` xác nhận đã tồn tại (tránh mount nhầm tên tạo volume rỗng). Dùng helper từ chính image `postgres:18.6-bookworm` đã kiểm tra có `tar`, `--rm --network none --read-only --user 0`, source mount `readonly`, host backup folder mount `/backup`. Lệnh archive tương ứng: `tar --numeric-owner -C /source -cpf /backup/grafana.tar .` và `tar --numeric-owner -C /source -cpf /backup/prometheus.tar .`; giữ numeric ownership/mode. Không bật Prometheus admin API. Trong `finally` khởi động lại hai service bằng `up -d --wait --wait-timeout 180` và kiểm tra query.
- [ ] **5. Hướng dẫn restore archive vào volume xác minh mới.** Tạo hai named volume mới có suffix lần thử, kiểm tra chưa tồn tại trước tạo; helper như bước 4 mount archive read-only tại `/backup`, target mới writable tại `/restore`; `tar --numeric-owner -C /restore -xpf /backup/<grafana-or-prometheus>.tar`. Kiểm tra `grafana.db`/cấu trúc TSDB và ownership được giữ. Ghi rõ kiểm tra archive/restore file không tự chứng minh ứng dụng restored boot thành công; nếu muốn nghiệm thu boot phải dùng instance cô lập và không bind port trùng. CI-14 bắt buộc ở bước 3, không suy rộng từ file listing.
- [ ] **6. Dọn chỉ artifact kiểm chứng sau khi đủ bằng chứng.** Xác nhận tên/schema/path/volume và quyền sở hữu trước thao tác xóa. `DROP SCHEMA infrapulse_ci CASCADE` chỉ trong live DB sau khi biết schema chỉ chứa bảng probe; drop **database kiểm chứng** `infrapulse_ci_restore`, không database `infrapulse`; xóa dashboard UI có UID `infrapulse-ci-ui` sau khi persistence đã ghi nhận; dọn hai file `/tmp/infrapulse-ci.dump`, `/tmp/infrapulse-ci-restore.dump` và volume restore/helper chỉ do lần thử tạo. Giữ backup host theo lựa chọn operator. Không prune, không xóa live named volume hoặc `.env`. Ba service trở lại healthy.
- [ ] **7. Viết README và hoàn thiện vận hành.** README ghi đúng trạng thái sau nghiệm thu, link spec/runbook, prerequisites, thao tác operator tạo `.env`, và Quick Start dùng `$dc`, `config --quiet`, `promtool`, `up --wait`, URL loopback. Runbook có startup/shutdown/recreate; cách áp dụng config mount không giả định hot reload; health/unhealthy vs restart; version/layout/major upgrade; bootstrap/rotation; dashboard UI vs file source; backup/restore và troubleshooting. Không tuyên bố Telegraf/Gateway/NestJS/AIOps hoặc Remote Write E2E đã hoàn thành.
- [ ] **8. Đối chiếu toàn bộ ma trận, review thay đổi và bàn giao.** Kiểm tra chỉ các file dự kiến được sửa, không secret/artifact tạm trong repository, các link nội bộ mở được. Chạy lại `config --quiet`, `promtool`, `up --wait`, query Grafana và SQL đúng credential sau cleanup. Ghi kết quả thật từng CI; mọi mục chưa chạy phải ghi chưa kiểm chứng, không PASS. Nếu có Git từ trước lúc thực hiện, chỉ xem status/diff, không init/add/commit. Yêu cầu review cuối, không tự tích hợp branch.

## 3. Ma trận truy vết spec → task

| Tiêu chí | Task / bằng chứng |
|---|---|
| CI-01 | 1.5: thiếu/rỗng/literal/precedence; 3.3 config với env vận hành. |
| CI-02 | 3.3 và 6.8: `promtool check config` từ image pin. |
| CI-03 | 3.3 và 6.8: ba service healthy qua `up --wait`. |
| CI-04 | 1.3–1.4, 3.4: binding, memberships, network internal và mounts thực. |
| CI-05 | 1.4, 3.5: flags/config API và TSDB mount. |
| CI-06 | 2.2, 3.7: datasource tự provision, UID/default/proxy/readonly. |
| CI-07 | 3.7: Explore trả self-scrape `1`. |
| CI-08 | 3.6: TCP SQL với đúng/sai password. |
| CI-09 | 5.1: import UI JSON tối thiểu, không plugin. |
| CI-10 | 5.2–5.4: SQL row, dashboard và sample ở timestamp cũ qua down/up. |
| CI-11 | 4.2: Prometheus stop/query error/recovery, cùng datasource. |
| CI-12 | 4.3: PostgreSQL stop không ảnh hưởng query metrics; SQL phục hồi. |
| CI-13 | 3.4, 3.8, 6.1–6.7: log rotation và runbook đầy đủ. |
| CI-14 | 6.2–6.3: SQL dump restore vào database riêng, sentinel đúng/live DB nguyên. |

## 4. Gate bàn giao và cách thực hiện đề xuất

Kế hoạch là một stack nhỏ nhưng runtime/network/storage và runbook phụ thuộc nhau khá chặt; đề xuất **thực hiện nguyên bản trong phiên, tuần tự từng task**, dùng `executing-plans`, sau khi người dùng review và yêu cầu triển khai riêng. Nếu muốn review độc lập sau từng task, có thể chọn `subagent-driven-development`; không chạy task đồng thời trên cùng project.

Khi kết thúc giai đoạn lập kế hoạch này: **chỉ có tài liệu kế hoạch mới; chưa tạo file triển khai, `.env`, image/container/volume, chưa chạy acceptance tests và chưa commit**. Duyệt spec không đồng nghĩa đã duyệt plan hoặc cho phép coding/deployment.
