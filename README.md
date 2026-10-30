# InfraPulse

## Trạng thái hiện tại

**Bước 1 — Central Infrastructure: ba container đang chạy healthy; đã chạy nghiệm thu ngày 2026-10-30 sau khi người dùng cho phép.** Kết quả: **11 PASS, 2 PARTIAL, 1 FAIL**. CI-01 chưa đạt hợp đồng không tự tạo bind source trên Docker Desktop/Windows; CI-07/CI-09 đã kiểm chứng bằng API nhưng chưa thao tác browser Explore/Import. Xem [báo cáo thực thi](<docs/deployment/2026-10-30-central-infrastructure-acceptance.md>) và [ma trận nghiệm thu](<docs/deployment/central-infrastructure.md#9-ma-trận-nghiệm-thu-thực-tế>).

Đã tạo [environment riêng](<.env>) với hai password ngẫu nhiên độc lập và ACL hạn chế; không hiển thị credential. SQL backup/isolated restore đã pass; dữ liệu thử đã dọn, ba volume thật và backup host được giữ. Credential, backup và artifact chạy thử không được đưa vào Git.

Bước này chỉ có Prometheus, Grafana và PostgreSQL. Chưa triển khai Telegraf, FastAPI Ingestion Gateway, NestJS, AIOps, dashboard nghiệp vụ, alert hay Remote Write E2E.

## Kiến trúc lab

| Service | Image pin | Network | Port host | Named volume / destination |
|---|---|---|---|---|
| Prometheus | `prom/prometheus:v3.13.5-busybox` | `monitoring` | Không | `prometheus_data` → `/prometheus` |
| Grafana | `grafana/grafana:13.3.0` | `monitoring` | `127.0.0.1:3000` | `grafana_data` → `/var/lib/grafana` |
| PostgreSQL | `postgres:18.6-bookworm` | `database`, internal | Không | `postgres_data` → `/var/lib/postgresql` |

Project `infrapulse`; PostgreSQL 18 dùng `PGDATA=/var/lib/postgresql/18/docker`. Grafana dùng SQLite, không phụ thuộc PostgreSQL; datasource tự provision UID `infrapulse-prometheus`. Prometheus tự scrape mỗi `30s`, bật receiver nội bộ, retention `7d`/`5GB` (không phải quota cứng hoặc bảo đảm luôn đủ bảy ngày). Không publish `9090`/`5432`.

## Prerequisites

- Windows, Docker Desktop đang chạy WSL2 backend / Linux containers; Docker Compose v2 hỗ trợ `up --wait` và long-syntax bind mounts.
- Đủ RAM/disk Docker Desktop/VHDX, có headroom ngoài retention; host port 3000 chưa bị chiếm khi khởi động lần đầu.
- PowerShell 7.3+ (`pwsh`, bản còn được hỗ trợ) tại root workspace, native argument passing `Standard`; không hỗ trợ Windows PowerShell 5.1/Legacy vì có thể làm mất quote trong Docker Go template/shell argument. Không trộn đường dẫn WSL và Windows.
- Khi cài lần đầu, operator tạo [environment riêng](<.env>) từ [mẫu environment](<.env.example>), thay cả hai password mạnh/khác nhau, bảo vệ quyền đọc và không commit/share. Single-quote giá trị để giữ literal `$`/`#`; shell environment có precedence cao hơn env-file. Máy này đã có credential: không copy đè.
- Tag/tooling đã recheck bằng runtime; Docker 29.1.3, Compose 2.40.3-desktop.1, PowerShell 7.6.9. Đọc preflight/tooling trong [runbook](<docs/deployment/central-infrastructure.md>) trước vận hành.

## Quick Start — cài mới khi được phép vận hành

Máy hiện tại đã chạy stack: không chạy lại bước copy environment. Với cài mới, điền và bảo vệ credential trước khi chạy lệnh Docker. Khối lệnh hướng dẫn không tự thay thế bằng chứng nghiệm thu.

```powershell
if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'Use supported PowerShell 7.3+ (pwsh), not Windows PowerShell 5.1.' }
$PSNativeCommandArgumentPassing = 'Standard'
if (Test-Path -LiteralPath .env) { throw '.env already exists; do not overwrite.' }
Copy-Item -LiteralPath .env.example -Destination .env
# Edit .env privately: set GRAFANA_ADMIN_PASSWORD and POSTGRES_PASSWORD.
# Complete the runbook preflight, protect .env ACL, and confirm port 3000 is available.
$dc = @('--env-file', '.env', '-f', 'deploy/compose/compose.yaml')
function Assert-NativeExit {
    param([string]$Action)
    if ($LASTEXITCODE -ne 0) { throw "$Action failed (exit $LASTEXITCODE)." }
}
# Docker Desktop can auto-create missing bind sources despite create_host_path=false.
# Abort on the host BEFORE Docker touches any bind source.
if (-not (Test-Path -LiteralPath 'observability/prometheus/prometheus.yml' -PathType Leaf)) {
    throw 'Prometheus bind source must exist as a file.'
}
foreach ($dir in @('observability/grafana/provisioning', 'observability/grafana/dashboards')) {
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { throw "Missing bind directory: $dir" }
}
docker compose @dc config --quiet
Assert-NativeExit 'Compose configuration'
docker compose @dc pull
Assert-NativeExit 'Pull pinned images'
# Check image tooling as described in the runbook before continuing.
docker compose @dc run --rm --no-deps --entrypoint promtool prometheus check config /etc/prometheus/prometheus.yml
Assert-NativeExit 'Prometheus configuration'
docker compose @dc up -d --wait --wait-timeout 180
Assert-NativeExit 'Stack startup'
docker compose @dc ps
Assert-NativeExit 'Stack status'
```

Grafana: <http://127.0.0.1:3000>. Operator đăng nhập bằng credential riêng; Explore chạy `up{job="prometheus"}` sau self-scrape. Health không thay thế query datasource hoặc SQL authentication. Không gửi secret qua argument, full config/inspect/log hoặc screenshot.

Đổi [environment](<.env>) không tự rotate password trong volume PostgreSQL/Grafana. `POSTGRES_USER` là bootstrap superuser, **không phải tài khoản ứng dụng**. Không đổi major PostgreSQL chỉ bằng sửa tag.

Dừng bằng `docker compose @dc down`, kiểm tra exit code; khởi động lại cùng `$dc` và named volumes. **Không `down -v`, prune hoặc reset Docker Desktop**. Named volume và recreate không thay thế backup ngoài Docker data disk. SQL host-backup → isolated restore đã pass; archive Grafana/Prometheus đã extract kiểm tra file/ownership trên volume mới nhưng **chưa boot ứng dụng từ archive**.

## File chính và tài liệu

- [Compose](<deploy/compose/compose.yaml>) — topology, mounts, health, logging và restart.
- [Prometheus config](<observability/prometheus/prometheus.yml>) — self-scrape.
- [Grafana datasource](<observability/grafana/provisioning/datasources/prometheus.yml>) và [dashboard provider](<observability/grafana/provisioning/dashboards/providers.yml>).
- [Dashboard placeholder](<observability/grafana/dashboards/.gitkeep>) — chưa có dashboard JSON triển khai sẵn; dashboard thử đã dọn.
- [Runbook và ma trận CI-01–CI-14](<docs/deployment/central-infrastructure.md>) — startup, auth, failure recovery, persistence, backup/restore, troubleshooting.
- [Báo cáo nghiệm thu 2026-10-30](<docs/deployment/2026-10-30-central-infrastructure-acceptance.md>) — bằng chứng, phần pass và giới hạn còn lại.
- [Thiết kế](<docs/superpowers/specs/2026-10-30-central-infrastructure-design.md>), [kế hoạch sáu task](<docs/superpowers/plans/2026-10-30-central-infrastructure.md>) và [định hướng dự án](<INTRODUCT.md>).
- [Ignore patterns](<.gitignore>) — đã kiểm chứng bằng Git: loại trừ credential, backup, private key, bộ nhớ agent và artifact chạy thử; chỉ giữ environment template không chứa password.
