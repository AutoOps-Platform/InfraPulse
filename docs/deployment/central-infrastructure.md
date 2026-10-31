# Central Infrastructure — Runbook Windows / Docker Desktop

## 1. Trạng thái và phạm vi

**Đã chạy nghiệm thu ngày 2026-10-30 sau khi người dùng cho phép chạy container/test: 11 PASS, 2 PARTIAL, 1 FAIL.** Ba service kết thúc ở trạng thái healthy. CI-01 không đạt phần missing-bind trên Docker Desktop/Windows; CI-07/CI-09 đã pass API nhưng chưa kiểm chứng UI browser. Xem [báo cáo và bằng chứng thực thi](<2026-10-30-central-infrastructure-acceptance.md>) và [ma trận §9](<#9-ma-trận-nghiệm-thu-thực-tế>). Các lệnh còn lại là quy trình vận hành, không phải cam kết mọi biến thể đã chạy. Phiên implementation ban đầu không test; quyền runtime được cấp sau đó.

- [Thiết kế đã duyệt](<../superpowers/specs/2026-10-30-central-infrastructure-design.md>) và [kế hoạch sáu task](<../superpowers/plans/2026-10-30-central-infrastructure.md>).
- Baseline Bước 1 của [Compose](<../../deploy/compose/compose.yaml>): project `infrapulse`, ba service `prometheus`, `grafana`, `postgres`; không backend, agent, plugin, dashboard nghiệp vụ hoặc lịch backup. Bổ sung Gateway hiện tại được tách riêng bên dưới.
- Grafana/Prometheus chỉ ở `infrapulse_monitoring`; PostgreSQL chỉ ở `infrapulse_database` (`internal: true`). Network monitoring không chặn outbound Internet.
- Chỉ Grafana publish `127.0.0.1:3000:3000`. Prometheus `9090` và PostgreSQL `5432` không có host binding. Không mở thêm cổng để debug.
- Grafana dùng SQLite, không phụ thuộc PostgreSQL. Network không bảo vệ secrets trước người có quyền host/Docker.
- HTTP loopback không TLS chỉ là ngoại lệ lab; không dùng cấu hình này làm public/LAN ingress.

### Bổ sung Bước 2 (2026-10-31), không sửa kết quả lịch sử

Stack hiện tại có thêm service `ingest` trên monitoring, publish riêng `127.0.0.1:8000`; xem [runbook Gateway](<ingestion-gateway.md>) và [nghiệm thu GW-01–GW-15](<ingestion-gateway-acceptance.md>). Ba service/volume Bước 1 và kết quả CI-01–CI-14 ở §9 vẫn là baseline ngày 2026-10-30, không được suy rộng thành nghiệm thu mới. Các thao tác kiểm tra baseline bên dưới chọn rõ ba service; lệnh `down`/startup toàn stack ảnh hưởng cả Gateway và chỉ dùng khi operator chủ ý cho phép.

**Plan CLI erratum (đã tái hiện ở Task 7):** root Compose phải dùng `--env-file .env -f deploy/compose/compose.yaml` và **không** `--project-directory .`. Override sai đó đổi anchor, đưa `../../services` và `../../observability` ra ngoài repo; config syntax quiet thành công vẫn không chứng minh resolved paths đúng. Giữ YAML `../../...`, project `infrapulse`, networks và volumes; không sửa báo cáo nghiệm thu lịch sử để che lỗi kế hoạch.

## 2. Prerequisites và input

Chạy **PowerShell 7.3+ (`pwsh`, bản còn được hỗ trợ) tại root workspace**, với `$PSNativeCommandArgumentPassing = 'Standard'`; không hỗ trợ Windows PowerShell 5.1/Legacy và không trộn đường dẫn Windows với WSL. Native argument passing kiểu Legacy có thể bỏ dấu quote trong Go template của Docker inspect hoặc shell argument. Docker Desktop phải chạy WSL2 backend, Linux containers, Docker Compose v2 hỗ trợ `up --wait` và `bind.create_host_path: false`. Xem dung lượng/RAM Docker Desktop, host disk và VHDX trước lần khởi động đầu. Retention `5GB` không phải dự toán tổng disk hoặc quota volume: WAL/head chunks/compaction và các service khác cần thêm dung lượng; `7d` không bảo đảm đủ bảy ngày nếu ngưỡng dung lượng đến trước.

### 2.1. Environment và mật khẩu

Operator tự copy [mẫu environment](<../../.env.example>) thành `.env` tại root, không ghi đè nếu đã có; điền **hai mật khẩu mạnh, khác nhau**, không `admin/admin`, và hạn chế quyền đọc file trên Windows. Phiên implementation ban đầu không tạo environment thật; phiên nghiệm thu được phép sau đó đã tạo [environment riêng](<../../.env>) với hai password ngẫu nhiên độc lập và ACL hạn chế. Không ghi đè credential hiện có.

```powershell
if (Test-Path -LiteralPath .env) { throw '.env already exists; do not overwrite it.' }
Copy-Item -LiteralPath .env.example -Destination .env
# Edit .env privately and set BOTH passwords before continuing.
```

- Root variables được mô tả trong [mẫu environment](<../../.env.example>). Mật khẩu rỗng/thiếu và image tag rỗng/thiếu phải làm Compose từ chối.
- Đặt password trong **single quotes** ở dotenv để giữ nguyên `$` và `#`; không copy các giá trị minh họa thành password thật. Dùng trình quản lý mật khẩu để tạo giá trị phù hợp dotenv, không multiline.
- Process environment cùng tên **ưu tiên hơn env-file**. Kiểm tra sự tồn tại/tên, không in giá trị; bỏ biến không mong muốn trong phiên PowerShell hiện tại, không sửa user/machine environment. Khi kiểm chứng precedence/literal, chỉ dùng fixture giả ngoài repository và khôi phục process environment trong `finally`.
- Không `env_file` trong service; Compose chỉ truyền từng biến cần thiết. DB password không được truyền vào Grafana/Prometheus.
- Không gửi `.env`, output `config` đầy đủ, full container inspect, dump hoặc log chưa redact qua hội thoại. [Ignore patterns](<../../.gitignore>) đã được kiểm chứng bằng Git trước initial commit: credential, backup, private key, bộ nhớ agent và artifact chạy thử bị loại trừ; chỉ template environment được phép theo dõi.
- `POSTGRES_USER=postgres` là **bootstrap superuser**, không cấp credential này cho backend tương lai.

### 2.2. Quy ước PowerShell

Dùng cùng root, env-file và project ở mọi lần thao tác. Không đặt `COMPOSE_PROJECT_NAME`, `-p` hoặc `--project-directory` khác cho stack live. Các project cô lập được nêu rõ riêng.

```powershell
if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'Use supported PowerShell 7.3+ (pwsh), not Windows PowerShell 5.1.' }
$PSNativeCommandArgumentPassing = 'Standard'
$dc = @('--env-file', '.env', '-f', 'deploy/compose/compose.yaml')
$baselineServices = @('prometheus', 'grafana', 'postgres')
function Assert-NativeExit {
    param([string]$Action)
    if ($LASTEXITCODE -ne 0) { throw "$Action failed (exit $LASTEXITCODE)." }
}
```

Sau **mỗi** lệnh native, kiểm tra exit code trước khi tiếp tục; các ví dụ dùng `Assert-NativeExit` cho exit 0, ngoại trừ probe sai mật khẩu được ghi rõ. Không đặt secret trong argument; shell/SQL nhiều dòng đi qua single-quoted here-string để host không nội suy. Không pipe binary dump qua PowerShell.

### 2.3. Preflight chỉ khi được phép chạy

```powershell
docker version
Assert-NativeExit 'Docker Engine'
docker compose version
Assert-NativeExit 'Compose version'
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
```

Nếu port 3000 bị chiếm: **dừng**, xác định xung đột, không tự bind `0.0.0.0` hoặc đổi port. Đối chiếu image pin/tag và support trước pull; nếu tag/tooling không còn đúng, dừng để thống nhất, không dùng `latest` hoặc tự nâng major.

| Service | Image pin | Tooling dự kiến / data mount |
|---|---|---|
| Prometheus | `prom/prometheus:v3.13.5-busybox` | `wget`, `promtool`; volume → `/prometheus` |
| Grafana | `grafana/grafana:13.3.0` | `curl`; UID 472; volume → `/var/lib/grafana` |
| PostgreSQL | `postgres:18.6-bookworm` | `pg_isready`, `psql`, `pg_dump`, `pg_restore`, `createdb`, `tar`; volume → `/var/lib/postgresql`, `PGDATA=/var/lib/postgresql/18/docker` |

Ba pin/tooling đã pull và recheck runtime ngày 2026-10-30; digest trong [báo cáo thực thi](<2026-10-30-central-infrastructure-acceptance.md>). Nguồn/tag research xem [kế hoạch §§1–2](<../superpowers/plans/2026-10-30-central-infrastructure.md#1-hiện-trạng-và-chi-tiết-đã-xác-minh-khi-lập-kế-hoạch>). Không tự đổi PostgreSQL sang major khác trên data directory hiện có.

## 3. Khởi động lần đầu

Chỉ chạy sau khi được phép nghiệm thu. Các one-off `run --rm` sau dùng chính ba service/image, không thêm service thường trực; chúng có thể khởi tạo named volume được khai báo. Xem đúng tên/label tài nguyên nếu lần chạy thất bại; không prune.

```powershell
# Required on Docker Desktop/Windows; run at workspace root BEFORE Docker.
if (-not (Test-Path -LiteralPath 'observability/prometheus/prometheus.yml' -PathType Leaf)) {
    throw 'Prometheus bind source must exist as a file.'
}
foreach ($dir in @('observability/grafana/provisioning', 'observability/grafana/dashboards')) {
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { throw "Missing bind directory: $dir" }
}
docker compose @dc config --quiet
Assert-NativeExit 'Compose configuration'
docker compose @dc pull @baselineServices
Assert-NativeExit 'Pull pinned images'
docker compose @dc run --rm --no-deps --entrypoint sh prometheus -c 'command -v wget && command -v promtool'
Assert-NativeExit 'Prometheus tooling'
docker compose @dc run --rm --no-deps --entrypoint sh grafana -c 'command -v curl'
Assert-NativeExit 'Grafana tooling'
docker compose @dc run --rm --no-deps --entrypoint sh postgres -c 'command -v pg_isready && command -v psql && command -v pg_dump && command -v pg_restore && command -v createdb && command -v tar'
Assert-NativeExit 'PostgreSQL tooling'
docker compose @dc run --rm --no-deps --entrypoint promtool prometheus check config /etc/prometheus/prometheus.yml
Assert-NativeExit 'Prometheus configuration'
docker compose @dc up -d --wait --wait-timeout 180 @baselineServices
Assert-NativeExit 'Stack startup'
docker compose @dc ps @baselineServices
Assert-NativeExit 'Stack status'
```

Kỳ vọng đúng ba service healthy. Thiếu client trong image → review pin, không cài package khi boot. Health dùng interval `10s`, timeout `5s`, retries `12`, start period `30s`. Grafana healthy không chứng minh datasource hoạt động; PostgreSQL `pg_isready` không chứng minh password đúng; Prometheus ready không chứng minh Remote Write ingest E2E.

### 3.1. Kiểm chứng input/mount trước nghiệm thu

Input/literal/precedence/tag đã PASS với fixture giả; missing-bind native FAIL như mô tả dưới. Khi kiểm chứng lại, tạo fixture ngoài repository chỉ chứa dữ liệu giả, ba pin và password giả; không sao chép `.env` thật. Lần lượt thiếu từng password, rỗng từng password (exit nonzero), cả hai non-empty (exit 0), và literal `GRAFANA_ADMIN_PASSWORD='ci$grafana#not-a-secret'`, `POSTGRES_PASSWORD='ci$postgres#not-a-secret'` (exit 0). Với fixture literal, capture `config --format json` vào biến, **không in raw output**, và kiểm tra DB password chỉ ở service postgres. Compose có thể serialize `$` thành `$$` trong output config; không so sánh output này trực tiếp với password runtime. Kiểm chứng literal bằng one-off container dùng **fixture giả**, entrypoint `sh` chỉ đọc biến tương ứng (không chạy initializer), không publish port và không in credential thật. Thử process override bằng giá trị giả khác rồi khôi phục environment trong `finally`.

Đối chiếu resolved bind sources từ thư mục Compose: [Prometheus config](<../../observability/prometheus/prometheus.yml>) là leaf file, [provisioning datasource](<../../observability/grafana/provisioning/datasources/prometheus.yml>) và [provider](<../../observability/grafana/provisioning/dashboards/providers.yml>) nằm trong directory provisioning; [dashboard placeholder](<../../observability/grafana/dashboards/.gitkeep>) giữ directory trống. Ba bind mount read-only, `create_host_path: false`. Hợp đồng thiết kế: thiếu source phải fail, không tự tạo directory. **Thực tế Docker Desktop/Windows trong lần nghiệm thu này vi phạm phần không tự tạo:** source không tồn tại đã trở thành directory, sau đó OCI mount mới fail với `not a directory`. Vì vậy giữ CI-01 FAIL; không coi config flag là đủ bảo vệ. Bắt buộc guard `Test-Path -PathType` ở §3 trước khi gọi Docker; guard giảm lỗi vận hành, không chứng minh engine đã sửa và không loại bỏ race giữa kiểm tra/mount. Xóa chỉ fixture do lần kiểm chứng tạo sau khi xác nhận absolute path.

## 4. Runtime, mạng và xác thực

### 4.1. Inspect có chọn lọc

```powershell
$ids = @(docker compose @dc ps -q @baselineServices)
Assert-NativeExit 'Get container IDs'
if ($ids.Count -ne 3) { throw 'Expected exactly three running services.' }
foreach ($id in $ids) {
    docker inspect --format '{{json .Name}} {{json .NetworkSettings.Ports}} {{json .NetworkSettings.Networks}} {{json .Mounts}} {{json .HostConfig.LogConfig}} {{json .HostConfig.RestartPolicy}} {{json .State.Health.Status}}' $id
    Assert-NativeExit 'Inspect selected runtime fields'
}
docker network inspect infrapulse_database --format '{{.Internal}}'
Assert-NativeExit 'Database isolation'
```

Đối chiếu: internal `true`; network membership đúng §1; chỉ host binding `127.0.0.1:3000`. Image `EXPOSE`/null port metadata không phải host publication. Mount đúng ba named volume tại đích trong bảng §2.3, không anonymous volume thay thế data PostgreSQL. Logging `json-file`, `max-size=10m`, `max-file=3`; restart `unless-stopped`. Không full inspect vì `.Config.Env` chứa secret.

### 4.2. Prometheus runtime và Grafana query

```powershell
$raw = docker compose @dc exec -T prometheus wget -q -O - http://127.0.0.1:9090/api/v1/status/flags
Assert-NativeExit 'Read Prometheus flags'
$flags = ($raw -join "`n") | ConvertFrom-Json
$raw = docker compose @dc exec -T prometheus wget -q -O - http://127.0.0.1:9090/api/v1/status/config
Assert-NativeExit 'Read Prometheus runtime config'
$runtimeConfig = ($raw -join "`n") | ConvertFrom-Json
```

Cả hai API `status=success`; flags `web.enable-remote-write-receiver=true`, `storage.tsdb.path=/prometheus`, retention tương đương `7d` và `5GB` (API có thể chuẩn hóa đơn vị). Runtime config có job `prometheus`, target `prometheus:9090`, scrape/evaluation interval `30s`.

Operator mở `http://127.0.0.1:3000` trong phiên chưa login: dashboard không truy cập anonymous và không có sign-up. Đăng nhập riêng bằng credential bootstrap; datasource **Prometheus**, default, UID `infrapulse-prometheus`, proxy URL `http://prometheus:9090`, không sửa qua UI. Explore chạy mới `up{job="prometheus"}` phải trả `1`; retry thủ công có giới hạn **90 giây** sau self-scrape, ghi lỗi nếu hết hạn. Không chấp nhận đồ thị cũ/cached làm bằng chứng.

Remote Write endpoint tương lai là `http://prometheus:9090/api/v1/write` trong network monitoring. Chỉ xác minh receiver flags ở bước này; không gửi JSON/body tùy ý và coi HTTP 400/415 là ingest pass. Chưa triển khai Gateway, protobuf/Snappy hay Telegraf.

### 4.3. SQL qua TCP, đúng và sai password

Probe đúng phải exit 0, database `infrapulse` (nếu giữ default), user tương ứng input:

```powershell
@'
export PGPASSWORD="$POSTGRES_PASSWORD" PGCONNECT_TIMEOUT=5
exec psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -w -v ON_ERROR_STOP=1 -c 'SELECT current_database(), current_user;'
'@ | docker compose @dc exec -T postgres sh
Assert-NativeExit 'Authenticated TCP SQL'
```

Probe sai phải exit nonzero và báo **password authentication failed**, không coi timeout/refused là kiểm chứng xác thực thành công. Dùng password giả chắc chắn khác password vận hành:

```powershell
@'
export PGPASSWORD=ci-intentionally-wrong PGCONNECT_TIMEOUT=5
exec psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -w -v ON_ERROR_STOP=1 -c 'SELECT 1;'
'@ | docker compose @dc exec -T postgres sh
if ($LASTEXITCODE -eq 0) { throw 'Wrong password was accepted; inspect HBA before proceeding.' }
# Also inspect the error category: it must be password authentication failed.
```

Fresh bootstrap khóa TCP (kể cả loopback) bằng `POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=trust` và `POSTGRES_HOST_AUTH_METHOD=scram-sha-256`. Local socket trust không chứng minh password. Volume đã tồn tại không được init lại/HBA không tự viết lại; nếu sai password vẫn được chấp nhận, inspect HBA và lập thay đổi có chủ đích, **không reset volume**.

### 4.4. Bootstrap không phải rotation

Đổi `.env` **không tự đổi** password đã lưu ở cả PostgreSQL và Grafana. Recreate có thể cập nhật environment trong container nhưng dữ liệu/account cũ vẫn nguyên.

- PostgreSQL: quản trị tương tác qua TCP, dùng `psql -W` (prompt kín), rồi `\password` cho đúng role; đồng bộ `.env` riêng và recreate postgres khi phù hợp. Không đặt password mới trong SQL argument hoặc history. Không dùng tài khoản bootstrap cho ứng dụng tương lai; tạo role least-privilege ở bước backend riêng.
- Grafana: đổi password qua UI đã xác thực; khi mất quyền truy cập dùng quy trình reset admin chính thức có interactive prompt của phiên bản đã pin. Không truyền password reset trong command-line; đồng bộ `.env` riêng, không xóa SQLite/volume.
- `POSTGRES_DB`/`POSTGRES_USER` cũng là input init, không tự migrate/rename database/role trên volume đã có.

**Quy trình bootstrap-is-not-rotation cô lập (để chạy sau):**

1. Tạo fixture giả A/B ngoài repository, cùng ba pin, cùng Grafana password giả; chỉ PostgreSQL password khác nhau. Kiểm soát process overrides, giữ/khôi phục trong `finally`.
2. Chọn project duy nhất `infrapulse-bootstrap-ci-<unique>`; luôn dùng `--env-file <A-or-B> -f deploy/compose/compose.yaml -p <ci-project>`. Chỉ `up -d --wait --wait-timeout 180 postgres`, không các service khác.
3. Init bằng A; probe TCP đúng/sai. Ghi container ID và tên/label volume thực. Recreate cùng project bằng B: `up -d --force-recreate --wait --wait-timeout 180 postgres`.
4. Probe TCP lấy password B trong environment phải fail authentication. Với fixture A, dùng `run --rm --no-deps --entrypoint sh postgres`; export `PGPASSWORD` từ environment và `psql -h postgres ...` phải thành công. ID container đổi nhưng volume mount giữ nguyên.
5. Trong `finally`, `down` đúng project cô lập; inspect tên/label chính xác rồi chỉ xóa volume test do lần chạy tạo, dọn fixture đúng absolute path. Không `down -v`, prune hoặc đụng project/volume live. Đây chỉ là test PostgreSQL, không phải bằng chứng rotation Grafana.

## 5. Failure isolation và phục hồi

Chỉ nghiệm thu khi đã được phép dừng service. Trước mỗi case, ba service healthy và query **mới** `up{job="prometheus"}=1`. Không thêm `depends_on` để che lỗi. `unhealthy` không tự làm Compose restart container; `unless-stopped` chủ yếu xử lý container exit và vẫn tôn trọng việc dừng chủ động.

### 5.1. Dừng Prometheus

```powershell
try {
    docker compose @dc stop prometheus
    Assert-NativeExit 'Stop Prometheus'
    # Grafana still opens. In Explore, Refresh/Run a NEW instant query:
    # up{job="prometheus"} must report an upstream error, not cached data.
    Read-Host 'Record the fresh-query error, then press Enter to restore'
} finally {
    docker compose @dc up -d --wait --wait-timeout 180 prometheus
    Assert-NativeExit 'Recover Prometheus'
}
```

Query mới phải trở lại `1` trong tối đa 90s sau phục hồi; cùng UID `infrapulse-prometheus`, không tạo lại datasource. Grafana còn healthy không thay thế bước query khi upstream bị dừng.

### 5.2. Dừng PostgreSQL

```powershell
try {
    docker compose @dc stop postgres
    Assert-NativeExit 'Stop PostgreSQL'
    # In Grafana Explore, run a NEW query: up{job="prometheus"} must remain 1.
    Read-Host 'Record the fresh successful query, then press Enter to restore'
} finally {
    docker compose @dc up -d --wait --wait-timeout 180 postgres
    Assert-NativeExit 'Recover PostgreSQL'
}
```

Chạy lại probe TCP đúng ở §4.3 sau phục hồi. Nếu case/query lỗi, vẫn cố phục hồi đúng service trong `finally`; báo service nào chưa phục hồi thay vì tiếp tục như đã healthy. Kết thúc bằng trạng thái đúng ba service healthy và query metrics/SQL mới thành công.

### 5.3. Logs và áp dụng cấu hình

```powershell
docker compose @dc logs --tail 100 prometheus
Assert-NativeExit 'Prometheus logs'
docker compose @dc logs --tail 100 grafana
Assert-NativeExit 'Grafana logs'
docker compose @dc logs --tail 100 postgres
Assert-NativeExit 'PostgreSQL logs'
```

Xem log cục bộ, redact credential/token/SQL nhạy cảm trước chia sẻ. Phân biệt syntax/startup/mount error với datasource error và password error. Không in environment hoặc full inspect để chẩn đoán.

- Thay Prometheus YAML: chạy lại `promtool` theo §3 rồi restart service; không bật lifecycle/admin API.
- Thay Grafana datasource/provider YAML: restart Grafana để nạp provisioning. Provider dashboard JSON poll 30s, nhưng vẫn xác minh UI, không giả định mọi file cấu hình hot reload.
- Trên Windows, editor thay file bằng atomic rename có thể làm file bind-mount còn inode cũ: nếu restart không nạp bản mới, dùng `up -d --force-recreate --wait --wait-timeout 180 <service>` để gắn lại mount.
- Thay Compose/environment/image pin đã review: `up -d --force-recreate --wait --wait-timeout 180 <service>`, kiểm tra health và query/SQL tương ứng. Đổi `.env` không rotate password đã bootstrap.
- Shutdown toàn stack: `docker compose @dc down`; kiểm tra exit 0. Startup lại cùng `$dc`: `docker compose @dc up -d --wait --wait-timeout 180`; kiểm tra exit 0. Không `down -v`, prune hoặc reset Docker Desktop. Recreate/restart không phải backup.

## 6. Dashboard và persistence lịch sử

Các JSON/SQL sau chỉ là **fixture hướng dẫn**, không được triển khai sẵn. Chỉ chạy sau khi được phép tạo dữ liệu nghiệm thu và recreate stack. Trước khi tạo, kiểm tra dashboard UID `infrapulse-ci-ui`, `infrapulse-ci-file`, schema `infrapulse_ci` và đường dẫn file tạm chưa tồn tại; collision → dừng, không ghi đè hoặc xóa dữ liệu không rõ chủ sở hữu.

### 6.1. Import UI và sentinel SQL

Import JSON tối thiểu này bằng Grafana UI và lưu dashboard. Không tải dashboard Internet/cài plugin:

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

Mở shell tương tác trong postgres, rồi nhập khối shell/SQL bên dưới **trong container**, không dán như PowerShell. Password lấy từ environment, không từ argument. Sau khi thoát shell, kiểm tra `$LASTEXITCODE` ở PowerShell.

```powershell
docker compose @dc exec postgres sh
```

```sh
export PGPASSWORD="$POSTGRES_PASSWORD" PGCONNECT_TIMEOUT=5
psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -w -v ON_ERROR_STOP=1 -c "SELECT nspname FROM pg_namespace WHERE nspname = 'infrapulse_ci';"
# Require exit 0 and NO existing row before continuing.
psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -w -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
CREATE SCHEMA infrapulse_ci;
CREATE TABLE infrapulse_ci.persistence_probe (id integer PRIMARY KEY, note text NOT NULL);
INSERT INTO infrapulse_ci.persistence_probe VALUES (1, 'central-infra-ci-20261030');
COMMIT;
SELECT * FROM infrapulse_ci.persistence_probe;
SQL
# Require exit 0 and (1, central-infra-ci-20261030); on error stop and inspect.
exit
```

Không dùng `IF NOT EXISTS` để che collision. Đây là schema kiểm chứng tạm, không phải migration. Giữ sentinel tới khi hoàn tất restore SQL ở §7.

### 6.2. Ghi timestamp mẫu thực, rồi recreate

```powershell
$raw = docker compose @dc exec -T prometheus wget -q -O - 'http://127.0.0.1:9090/api/v1/query?query=timestamp%28up%7Bjob%3D%22prometheus%22%7D%29'
Assert-NativeExit 'Read pre-recreate sample timestamp'
$sample = ($raw -join "`n") | ConvertFrom-Json
if ($sample.status -ne 'success' -or @($sample.data.result).Count -ne 1) {
    throw 'Expected exactly one successful self-scrape series.'
}
$sampleTs = [string]$sample.data.result[0].value[1]
$beforeIds = @(docker compose @dc ps -q @baselineServices)
Assert-NativeExit 'Record original container IDs'
# Privately record the non-secret $sampleTs and dashboard UID for recovery.
# Whole-stack recreate also stops Gateway now; only with separate authorization.
docker compose @dc down
Assert-NativeExit 'Recreate: down without deleting volumes'
# Restore the current four-service stack (Gateway must already have a reviewed build).
docker compose @dc up -d --wait --wait-timeout 180
Assert-NativeExit 'Recreate: startup'
$afterIds = @(docker compose @dc ps -q @baselineServices)
Assert-NativeExit 'Read replacement container IDs'
$oldQuery = "http://127.0.0.1:9090/api/v1/query?query=up%7Bjob%3D%22prometheus%22%7D&time=$sampleTs"
$raw = docker compose @dc exec -T prometheus wget -q -O - $oldQuery
Assert-NativeExit 'Query the historical sample'
$historical = ($raw -join "`n") | ConvertFrom-Json
if ($historical.status -ne 'success' -or @($historical.data.result).Count -ne 1) {
    throw 'Historical self-scrape sample is missing.'
}
if ($historical.data.result[0].value[1] -ne '1') { throw 'Historical sample is not up=1.' }
```

`timestamp(up)` trả timestamp mẫu ở **`value[1]`**, không phải evaluation timestamp `value[0]`. Đối chiếu đúng ba ID mới, volume names không đổi; dashboard UID `infrapulse-ci-ui` vẫn tồn tại; chạy lại SQL `SELECT * FROM infrapulse_ci.persistence_probe;` qua TCP và đối chiếu row. Chỉ query sample `up` mới sau boot không chứng minh TSDB lịch sử còn nguyên. Nếu bước down/up lỗi, cố phục hồi bằng startup cùng `$dc`, báo trạng thái thật.

### 6.3. File provider và UI khác nguồn lưu

- [Provider](<../../observability/grafana/provisioning/dashboards/providers.yml>) đọc `/etc/grafana/dashboards` mỗi 30s, folder `InfraPulse`; `allowUiUpdates: false`, `disableDeletion: false`. Dashboard file lấy repository làm nguồn; không lưu sửa đổi UI vào dashboard này. Xóa file nguồn cho phép provider xóa dashboard tương ứng.
- Dashboard import UI nằm trong SQLite volume `grafana_data`, được sửa qua UI, không tự xuất thành file repository. Provisioned datasource cố định UID để JSON không phụ thuộc ID sinh tự động.
- Để nghiệm thu sau: tạo tạm `observability/grafana/dashboards/ci-file-check.json` từ JSON trên, đổi UID thành `infrapulse-ci-file` và title khác; xác nhận path/UID chưa tồn tại trước tạo. Chờ có giới hạn 90s/provider refresh hoặc restart Grafana có kiểm soát; dashboard xuất hiện trong folder `InfraPulse` và không lưu sửa đổi qua UI.
- Sau xác minh đúng absolute path/quyền sở hữu, xóa **chỉ** file tạm đó; dashboard file phải bị provider xóa, dashboard UI vẫn còn. Không giữ JSON nghiệm thu trong đầu ra triển khai: nguồn dashboard cuối cùng chỉ có [placeholder](<../../observability/grafana/dashboards/.gitkeep>).

## 7. Backup/restore thủ công tách biệt

Chỉ chạy khi được phép tạo backup/dừng service. Named volume không bảo vệ trước mất/xóa Docker Desktop data disk; restart không phải backup. Không có lịch backup tự động trong Bước 1.

### 7.1. Chuẩn bị đích backup

Chọn folder **ngoài workspace và ngoài Docker Desktop data disk/VHDX**, hạn chế quyền đọc và kiểm tra dung lượng. Ví dụ sau không phải folder đã tạo:

```powershell
$backupDir = Join-Path 'C:\MF\Backups\InfraPulse' (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
if (Test-Path -LiteralPath $backupDir) { throw 'Backup destination already exists.' }
New-Item -ItemType Directory -Path $backupDir -ErrorAction Stop | Out-Null
$backupDir = (Resolve-Path -LiteralPath $backupDir).Path
# Review this resolved absolute path and available disk before continuing.
$dumpPath = Join-Path $backupDir 'infrapulse.dump'
if (Test-Path -LiteralPath $dumpPath) { throw 'Refusing to overwrite a backup.' }
```

Giữ config/provisioning và pin tương ứng cùng bản backup; backup `.env` nếu cần phải bảo vệ **riêng** (ACL/mã hóa phù hợp), không bỏ vào archive công khai. Mọi backup có thể chứa dữ liệu/credential nhạy cảm, không commit/share. Logical DB dump không bao gồm cluster roles/global objects; lưu ý tái tạo role khi phục hồi sang cluster mới.

### 7.2. Logical dump PostgreSQL, không qua binary redirection

```powershell
docker compose @dc exec -T postgres sh -c 'test ! -e /tmp/infrapulse-ci.dump || exit 1; umask 077; export PGPASSWORD="$POSTGRES_PASSWORD" PGCONNECT_TIMEOUT=5; exec pg_dump -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -w -Fc -f /tmp/infrapulse-ci.dump'
Assert-NativeExit 'Create SQL custom-format dump'
docker compose @dc cp postgres:/tmp/infrapulse-ci.dump $dumpPath
Assert-NativeExit 'Copy SQL backup to host'
if ((Get-Item -LiteralPath $dumpPath).Length -le 0) { throw 'Empty SQL backup.' }
```

Không dùng `pg_dump > backup.dump` qua PowerShell: có thể đổi encoding/làm hỏng binary. Không dùng `pg_dumpall` như thể đã xử lý quyền/role nếu chưa có kế hoạch riêng. Đường dẫn `/tmp` cố định chỉ dành cho lần nghiệm thu này; nếu tồn tại thì dừng xác minh chủ sở hữu, không ghi đè. Backup vận hành lặp lại nên dùng tên duy nhất có chủ đích.

### 7.3. Restore từ bản host vào database mới

Copy **bản đã lưu ở host** về path khác; không restore từ file gốc còn trong container:

```powershell
docker compose @dc exec -T postgres sh -c 'test ! -e /tmp/infrapulse-ci-restore.dump'
Assert-NativeExit 'Restore staging path must not exist'
docker compose @dc cp $dumpPath postgres:/tmp/infrapulse-ci-restore.dump
Assert-NativeExit 'Stage the HOST backup for restore'
docker compose @dc exec -T postgres pg_restore --list /tmp/infrapulse-ci-restore.dump
Assert-NativeExit 'Read the copied archive catalog'
# Catalog metadata is for local review; do not share unredacted output.
docker compose @dc exec postgres sh
```

Trong shell container, dùng cùng user/password environment. Query đầu phải exit 0 và **không row**; nếu database có sẵn thì dừng. `createdb` cũng từ chối khi tên đã tồn tại, không reuse database lạ.

```sh
export PGPASSWORD="$POSTGRES_PASSWORD" PGCONNECT_TIMEOUT=5
psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -w -v ON_ERROR_STOP=1 -tAc "SELECT datname FROM pg_database WHERE datname = 'infrapulse_ci_restore';"
# Require exit 0 and NO row; stop on collision before the following commands.
createdb -h 127.0.0.1 -U "$POSTGRES_USER" -w infrapulse_ci_restore || exit 1
pg_restore -h 127.0.0.1 -U "$POSTGRES_USER" -d infrapulse_ci_restore -w --no-owner --no-privileges --exit-on-error /tmp/infrapulse-ci-restore.dump || exit 1
psql -h 127.0.0.1 -U "$POSTGRES_USER" -d infrapulse_ci_restore -w -v ON_ERROR_STOP=1 -c 'SELECT * FROM infrapulse_ci.persistence_probe;' || exit 1
psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -w -v ON_ERROR_STOP=1 -c 'SELECT * FROM infrapulse_ci.persistence_probe;' || exit 1
exit
```

Sau shell, PowerShell kiểm tra `Assert-NativeExit 'Isolated SQL restore'`. Cả DB restore và DB live phải có row `(1, 'central-infra-ci-20261030')`. Không dùng `--clean` vào live DB, không restore vào `infrapulse`. Nếu restore dở dang, dừng và ghi lại DB kiểm chứng còn lại; không drop dữ liệu để che lỗi. CI-14 chỉ PASS khi đọc lại sentinel và xác nhận live data không bị ghi đè.

### 7.4. Cold archive Grafana/Prometheus

Lấy **tên volume thực từ mount của container**, không đoán tên (mount nhầm tên sẽ có thể tạo volume rỗng). Chuẩn bị trước khi stop:

```powershell
$grafanaId = docker compose @dc ps -q grafana
Assert-NativeExit 'Find Grafana container'
$prometheusId = docker compose @dc ps -q prometheus
Assert-NativeExit 'Find Prometheus container'
if (-not $grafanaId -or -not $prometheusId) { throw 'Expected running source containers.' }
$grafanaVolume = docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/grafana"}}{{.Name}}{{end}}{{end}}' $grafanaId
Assert-NativeExit 'Read Grafana volume name'
$prometheusVolume = docker inspect --format '{{range .Mounts}}{{if eq .Destination "/prometheus"}}{{.Name}}{{end}}{{end}}' $prometheusId
Assert-NativeExit 'Read Prometheus volume name'
if (-not $grafanaVolume -or -not $prometheusVolume) { throw 'Missing named volume source.' }
docker volume inspect $grafanaVolume $prometheusVolume --format '{{.Name}} {{json .Labels}}'
Assert-NativeExit 'Verify live volume names and project labels'
# Require labels identifying the intended infrapulse project/volume roles.
$pgId = docker compose @dc ps -q postgres
Assert-NativeExit 'Find the pinned helper image source'
if (-not $pgId) { throw 'PostgreSQL container is required to identify its pinned image.' }
$helperImage = docker inspect --format '{{.Config.Image}}' $pgId
Assert-NativeExit 'Read the pinned PostgreSQL image reference'
if ((Test-Path -LiteralPath (Join-Path $backupDir 'grafana.tar')) -or
    (Test-Path -LiteralPath (Join-Path $backupDir 'prometheus.tar'))) {
    throw 'Refusing to overwrite a volume archive.'
}
try {
    docker compose @dc stop grafana prometheus
    Assert-NativeExit 'Stop writers before cold archive'
    docker run --rm --network none --read-only --user 0 --entrypoint tar --mount "type=volume,src=$grafanaVolume,dst=/source,readonly" --mount "type=bind,src=$backupDir,dst=/backup" $helperImage --numeric-owner -C /source -cpf /backup/grafana.tar .
    Assert-NativeExit 'Archive stopped Grafana volume'
    docker run --rm --network none --read-only --user 0 --entrypoint tar --mount "type=volume,src=$prometheusVolume,dst=/source,readonly" --mount "type=bind,src=$backupDir,dst=/backup" $helperImage --numeric-owner -C /source -cpf /backup/prometheus.tar .
    Assert-NativeExit 'Archive stopped Prometheus volume'
} finally {
    docker compose @dc up -d --wait --wait-timeout 180 grafana prometheus
    Assert-NativeExit 'Restart archived services'
}
```

Helper dùng chính image PostgreSQL đã pin/kiểm tra `tar`; không thêm service hoặc dependency. Source readonly, host folder `/backup` writable để tạo archive; numeric owner/mode nằm trong archive, không phụ thuộc ownership file tar trên NTFS. Sau phục hồi, chạy query metrics mới và kiểm tra dashboard/health; nếu `finally` startup lỗi thì báo rõ, không coi backup procedure hoàn tất.

### 7.5. Restore archive vào volume xác minh mới

Không mount writable bất kỳ live volume nào vào helper restore. Chỉ dùng volume mới có tên độc nhất, xác nhận chưa tồn tại trước tạo:

```powershell
$restoreSuffix = [guid]::NewGuid().ToString('N')
$grafanaRestore = "infrapulse-restore-grafana-$restoreSuffix"
$prometheusRestore = "infrapulse-restore-prometheus-$restoreSuffix"
$existingVolumes = @(docker volume ls --format '{{.Name}}')
Assert-NativeExit 'List existing volume names'
if ($existingVolumes -contains $grafanaRestore -or $existingVolumes -contains $prometheusRestore) {
    throw 'Restore volume name collision.'
}
# Confirm $backupDir and both expected non-empty archive files before continuing.
docker volume create --label "infrapulse.restore=$restoreSuffix" $grafanaRestore
Assert-NativeExit 'Create separate Grafana restore volume'
docker volume create --label "infrapulse.restore=$restoreSuffix" $prometheusRestore
Assert-NativeExit 'Create separate Prometheus restore volume'
docker run --rm --network none --read-only --user 0 --entrypoint tar --mount "type=volume,src=$grafanaRestore,dst=/restore" --mount "type=bind,src=$backupDir,dst=/backup,readonly" $helperImage --numeric-owner -C /restore -xpf /backup/grafana.tar
Assert-NativeExit 'Restore Grafana files into NEW volume'
docker run --rm --network none --read-only --user 0 --entrypoint tar --mount "type=volume,src=$prometheusRestore,dst=/restore" --mount "type=bind,src=$backupDir,dst=/backup,readonly" $helperImage --numeric-owner -C /restore -xpf /backup/prometheus.tar
Assert-NativeExit 'Restore Prometheus files into NEW volume'
docker run --rm --network none --read-only --user 0 --entrypoint sh --mount "type=volume,src=$grafanaRestore,dst=/restore,readonly" $helperImage -c 'test -s /restore/grafana.db && ls -ldn /restore /restore/grafana.db'
Assert-NativeExit 'Check restored SQLite file and numeric ownership'
docker run --rm --network none --read-only --user 0 --entrypoint sh --mount "type=volume,src=$prometheusRestore,dst=/restore,readonly" $helperImage -c 'test -d /restore/wal && ls -ln /restore'
Assert-NativeExit 'Check restored TSDB structure and numeric ownership'
```

Đối chiếu ownership/mode với source/archive (Grafana thường UID 472; không `chown` đoán). File/structure listing **không chứng minh restored application boot hoặc query được**. Muốn nghiệm thu ứng dụng phục hồi phải có instance/project cô lập, volume restored và không host port trùng, được cho phép riêng. Không suy rộng CI-14 SQL thành đã boot-verify hai archive này.

### 7.6. Cleanup có chủ đích sau khi đủ bằng chứng

Lần nghiệm thu 2026-10-30 đã cleanup có kiểm chứng; giữ ba volume live, credential và backup host. Quy trình cho các lần sau:

1. Ghi lại kết quả CI trước cleanup. Kiểm tra schema `infrapulse_ci` chỉ chứa probe do lần thử tạo; mới được `DROP SCHEMA infrapulse_ci CASCADE` trong live DB, không schema khác. Thao tác SQL dùng TCP/password environment và `ON_ERROR_STOP` như trên.
2. Xác nhận `infrapulse_ci_restore` là DB của đúng lần thử; mới drop **DB kiểm chứng** đó. Không drop DB `infrapulse` hoặc volume live.
3. Xóa dashboard UI đúng UID `infrapulse-ci-ui`; xác nhận file tạm/provider dashboard `infrapulse-ci-file` đã dọn ở §6.3. Không xóa dashboard khác theo title gần giống.
4. Sau xác minh exact path, xóa chỉ `/tmp/infrapulse-ci.dump` và `/tmp/infrapulse-ci-restore.dump` thuộc lần thử. Không wildcard hoặc xóa dump chưa xác nhận chủ sở hữu. Giữ backup host theo lựa chọn operator.
5. Inspect **tên và label** `infrapulse.restore=<suffix>` của hai volume restore trước `docker volume rm <exact-name>`; dọn chỉ volume đã tạo. Tương tự cho bootstrap project cô lập ở §4.4. `--rm` chỉ dọn helper container, không coi đó là dọn volume.
6. Không `down -v`, volume prune, Docker reset hoặc xóa `.env`. Kết thúc ba service healthy, query metrics mới và SQL đúng credential; nếu chưa chạy hoặc lỗi thì ghi rõ, không PASS.

## 8. Troubleshooting và giới hạn nâng cấp

| Hiện tượng | Hướng xử lý không phá dữ liệu |
|---|---|
| Compose báo password/tag missing | Điền input riêng trong `.env`, kiểm tra process precedence, chỉ dùng `config --quiet`; không in secret để debug. |
| Mount source missing / is a directory | Resolve từ `deploy/compose`, kiểm tra leaf/directory đúng loại; không bỏ `create_host_path: false`. |
| Port 3000 đang dùng | Dừng và xác định tiến trình xung đột; không nới host binding. |
| Prometheus/Grafana unhealthy | Xem log cục bộ, tooling/image pin và config; không cài thêm client lúc boot. |
| Grafana healthy nhưng Explore lỗi | Kiểm tra Prometheus/runtime DNS/membership/UID/proxy URL, chạy query mới; không thêm DB dependency. |
| PostgreSQL ready nhưng password mới fail | `.env` không rotate account đã tồn tại; quản trị/đổi password có chủ đích, kiểm tra HBA, không reset volume. |
| PostgreSQL 18 báo layout/data incompatibility | Mount parent `/var/lib/postgresql`, PGDATA `/var/lib/postgresql/18/docker`; không đổi major tùy ý. |
| File config đã sửa nhưng service chưa đổi | Restart đúng service; nếu bind file cũ do editor rename thì recreate có kiểm soát, không giả định hot reload. |
| Disk/VHDX tăng dù retention 5GB | Tính WAL/head/compaction, logs, DB, Grafana và Docker disk; không prune dữ liệu live. |
| Restore fail / archive thiếu | Giữ live data, ghi nhận đích restore dở dang, kiểm tra backup host/binary path/ownership; không ghi đè live để thử lại. |

Trước đổi pin: backup, đọc release notes/support/layout, cập nhật pin và kiểm chứng được cho phép; không thay PostgreSQL major chỉ bằng sửa tag. Migration major cần `pg_upgrade` hoặc dump/restore được lập kế hoạch riêng. Bước 1 không giải quyết production security, HA, tải lớn hoặc full Remote Write ingest.

## 9. Ma trận nghiệm thu thực tế

**Nghiệm thu 2026-10-30: 11 PASS, 2 PARTIAL, 1 FAIL.** Trạng thái cuối ghi nhận lúc `2026-10-30T15:27:47Z`; [báo cáo chi tiết và bằng chứng](<2026-10-30-central-infrastructure-acceptance.md>). Đọc/review mã không phải PASS; API không thay thế thao tác browser.

| Mã | Nội dung và bằng chứng | Trạng thái |
|---|---|---|
| CI-01 | Input/literal/precedence, sáu missing/empty tag và bootstrap PASS; missing bind auto-create directory trên Windows vi phạm hợp đồng (§3.1) | **FAIL** |
| CI-02 | Tooling ba image và `promtool check config` thành công | PASS |
| CI-03 | `up --wait`; đúng ba service running/healthy | PASS |
| CI-04 | Chỉ `127.0.0.1:3000`, đúng network/internal, volume và read-only binds | PASS |
| CI-05 | Receiver bật; storage `/prometheus`; runtime retention `1w`/`5GiB`, scrape/evaluation `30s` | PASS |
| CI-06 | UID `infrapulse-prometheus`, default/readOnly/proxy đúng; anonymous API bị 401 | PASS |
| CI-07 | Query mới qua authenticated Grafana API trả `up=1`; chưa thao tác browser Explore | **PARTIAL** |
| CI-08 | TCP đúng credential thành công, password sai bị từ chối | PASS |
| CI-09 | Dashboard tối thiểu create/read qua authenticated API; chưa browser Import | **PARTIAL** |
| CI-10 | Ba container ID đổi, cùng volume; historical sample, saved dashboard (API) và SQL sentinel còn nguyên | PASS |
| CI-11 | Stop Prometheus: Grafana healthy, query mới lỗi upstream; recover: `up=1` cùng UID | PASS |
| CI-12 | Stop PostgreSQL: query metrics vẫn `up=1`; recover SQL/sentinel thành công | PASS |
| CI-13 | Runtime `json-file`, `max-size=10m`, `max-file=3`, restart `unless-stopped`; runbook cập nhật | PASS |
| CI-14 | Custom SQL dump → host → isolated DB restore; sentinel trùng, live DB nguyên | PASS |

Bootstrap-not-rotation PASS trên volume cô lập với fake password A/B; file-provider read-only/delete PASS. Cold archive hai volume đã extract vào volume mới và kiểm tra file/ownership/mode; **chưa boot ứng dụng từ archive**. Chưa có throughput, binary Remote Write E2E hay production-readiness claim. Lần nghiệm thu ban đầu chưa có Git; sau đó người dùng cho phép initial commit/push và quy tắc ignore đã được kiểm chứng bằng Git. Không commit credential, backup, private key, bộ nhớ agent hoặc artifact chạy thử.
