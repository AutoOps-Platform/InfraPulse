# Central Infrastructure — kết quả nghiệm thu 2026-10-30

## 1. Kết luận và phạm vi

Người dùng cho phép chạy container và test sau phiên implementation không-test. Đã pull pin, tạo credential riêng, khởi động và kiểm chứng stack. Trạng thái cuối lúc **2026-10-30T15:27:47Z**: **Prometheus, Grafana, PostgreSQL đều running/healthy**; fresh Grafana datasource query `up{job="prometheus"}=1`, TCP SQL `SELECT 1` thành công.

**11 PASS, 2 PARTIAL, 1 FAIL — chưa nghiệm thu đầy đủ toàn bộ hợp đồng.** [Ma trận CI-01–CI-14](<central-infrastructure.md#9-ma-trận-nghiệm-thu-thực-tế>) là tổng hợp theo tiêu chí, không đếm số dòng PASS của harness. Các dòng API PASS không có nghĩa browser đã được thao tác.

- **CI-01 FAIL:** missing bind source vẫn bị Docker Desktop tạo thành directory dù `create_host_path: false`; startup sau đó thất bại ở OCI mount. Các phần input/tag/literal/precedence/bootstrap PASS.
- **CI-07/CI-09 PARTIAL:** đã query datasource và tạo/đọc dashboard qua authenticated Grafana API, **chưa browser Explore/Import**.
- Không kiểm chứng binary Remote Write E2E, throughput, HA, production readiness hoặc application boot từ cold archive.

Không thay cấu hình service/image để che failure, không nới port/network, không đổi credential thật, không `down -v`/prune, không init/stage/commit Git. Thay đổi tài liệu sau test: cập nhật kết quả và thêm host-path guard trong [runbook](<central-infrastructure.md#3-khởi-động-lần-đầu>) cùng [Quick Start](<../../README.md#quick-start--cài-mới-khi-được-phép-vận-hành>).

## 2. Môi trường và runtime cuối

- Docker Engine **29.1.3**, Compose **2.40.3-desktop.1**, context `desktop-linux`; Windows Docker Desktop/Linux containers.
- Dùng portable PowerShell **7.6.9**, native argument passing `Standard`. Windows PowerShell 5.1 có trên máy không đáp ứng runbook; portable archive đã đối chiếu SHA-256 trước sử dụng, không thay PATH hệ thống.
- Project `infrapulse`; chỉ Grafana publish **127.0.0.1:3000**. Prometheus/PostgreSQL không publish host port.

| Service | Image đã pull | Trạng thái | Volume live |
|---|---|---|---|
| Grafana | `grafana/grafana:13.3.0` | running/healthy | `infrapulse_grafana_data` |
| Prometheus | `prom/prometheus:v3.13.5-busybox` | running/healthy | `infrapulse_prometheus_data` |
| PostgreSQL | `postgres:18.6-bookworm` | running/healthy | `infrapulse_postgres_data` |

Repo digests thực đo (không đổi tag trong cấu hình thành digest):

```text
grafana/grafana@sha256:488984b716c0862639f91a698adbe2862677a5a07bad42da5f03f3030883b205
prom/prometheus@sha256:aafa9d694e6a883c02db516d9f6e5b84e14195f49a2a6456a4cca815edda72b9
postgres@sha256:5c4783a8cc3f0074912164f94dfa1be4e043438f0f707cf968d7af9a0d31a2c8
```

[Environment thật](<../../.env>) đã được tạo bằng hai password ngẫu nhiên độc lập 256-bit, không in ra output. ACL tắt inheritance, chỉ cho current user, SYSTEM và Administrators. Mở file này riêng trên máy nếu cần đăng nhập; không paste vào chat/log. Đổi env-file không tự rotate password đã bootstrap.

## 3. Bằng chứng kiểm chứng

### Cấu hình, mạng và xác thực

- `config --quiet` PASS; bốn missing/empty password và sáu missing/empty image-tag cases đều bị từ chối. Fake literal `$`/`#` và process override đã kiểm chứng qua one-off container, không dùng credential thật làm fixture.
- Tooling trong ba image có đủ; `promtool check config` PASS. Ba read-only bind sources thực tế resolve đúng.
- `up --wait` thành công; inspect chọn lọc xác minh network membership, database `internal=true`, named volumes, port và read-only binds.
- Receiver bật nội bộ; storage `/prometheus`; Prometheus chuẩn hóa retention `7d`/`5GB` thành **`1w`/`5GiB`**, scrape/evaluation `30s`.
- Datasource UID `infrapulse-prometheus`: default, proxy, readOnly đúng. Anonymous API bị HTTP 401; authenticated `/api/ds/query` trả fresh `up=1`.
- PostgreSQL qua TCP: đúng credential trả `infrapulse|postgres`; password sai bị `password authentication failed`. Không dùng `pg_isready` làm bằng chứng xác thực.
- Logging thực tế cả ba container: `json-file`, `max-size=10m`, `max-file=3`; restart `unless-stopped`.

### Persistence và failure isolation

- Tạo SQL sentinel và saved dashboard tối thiểu qua API; sau down/up không xóa volume, **cả ba container ID đổi** nhưng cùng ba named volumes.
- Historical `up=1` tại sample timestamp **1793373173.766** vẫn truy vấn được sau recreate; không nhầm evaluation timestamp mới với sample cũ. Saved dashboard và SQL sentinel cũng giữ nguyên.
- Stop Prometheus: Grafana vẫn healthy nhưng fresh query trả HTTP 400/upstream failure; recovery trả lại fresh `up=1`, cùng datasource UID.
- Stop PostgreSQL: fresh metric query vẫn `up=1`; SQL/sentinel phục hồi sau start.
- File-provider test: file JSON tạm được provision, API save bị HTTP 400; xóa file tạm khiến dashboard provision biến mất, saved SQLite dashboard còn nguyên.
- Bootstrap-not-rotation: project/volume không publish port, fake password A → recreate cùng volume với env B; cả Grafana/PostgreSQL vẫn nhận A và từ chối B. Không thay credential/volume live.

### Backup/restore và cleanup

- `pg_dump -Fc` ghi file trong container rồi `docker cp` ra host; **copy ngược chính bản host** và `pg_restore` vào database mới `infrapulse_ci_restore`. Sentinel restore trùng; sentinel live vẫn nguyên. Không restore đè database live.
- Dừng Grafana/Prometheus trước cold archive; archive đã lưu trên host, extract vào **hai volume mới có label riêng**; kiểm tra DB/WAL file, numeric ownership và mode. **Không boot application từ archive**, không coi file listing là đã recovery application.
- Backup giữ tại [thư mục host được bảo vệ](<C:/MF/Backups/InfraPulse/20261030-221503-c07c64347baa4e6baf411ab3be6d696a/>): SQL dump và hai archive; SHA-256 đối chiếu lại ở final check. Đây là backup nghiệm thu thủ công, không phải lịch backup hay off-machine recovery.
- Đã dọn chỉ schema/DB thử, hai dump staging trong container, hai dashboard thử/file JSON tạm, volume restore mới và project bootstrap thuộc lần thử. Ba volume live, credential và backup host giữ nguyên. Source dashboards trở lại chỉ có placeholder.

## 4. Failure còn lại và workaround

### Native missing-bind trên Windows — CI-01 FAIL

Fixture chỉ chứa fake environment, dùng override chỉ định file TEMP không tồn tại cho destination `/etc/prometheus/prometheus.yml`, giữ `bind.create_host_path=false`. Docker từ chối start nhưng lỗi thực tế là:

```text
OCI runtime create failed: ... error mounting ... not a directory:
Are you trying to mount a directory onto a file (or vice-versa)?
Strict bind unexpectedly created host path; directory=True
```

Harness tái kiểm chứng riêng sự tồn tại/type của host source và xác nhận directory đã bị tạo. Đây không chỉ là khác chuỗi error dự kiến `bind source path does not exist`; phần **không tự tạo directory thực sự FAIL**. Fixture TEMP/failed one-off do lần thử tạo đã được dọn, không tác động source/volume live.

Đã thêm guard `Test-Path -PathType Leaf/Container` trước mọi lệnh Docker trong startup hướng dẫn. [Guard test](<../../.superpowers/sdd/2026-10-30-central-infrastructure/runtime-doc-guards.ps1>) PASS: hai tài liệu có cùng snippet, chấp nhận source thật và từ chối cả ba source thiếu cùng ba source sai loại trong TEMP trước khi gọi Docker; fixture đã dọn. Guard chỉ giảm lỗi vận hành và không chặn race giữa kiểm tra và mount; gọi Docker trực tiếp bỏ qua guard vẫn có rủi ro. Giữ nguyên CI-01 FAIL cho native engine contract; cần sửa/đổi tooling và tái chạy fixture hoặc phê duyệt thay đổi tiêu chí trước khi đóng mục này.

### UI chưa chạy

CI-07 cần đăng nhập Grafana và chạy Explore; CI-09 cần Import dashboard qua browser. API của cả hai đã PASS, nhưng chưa dùng thao tác browser. Dashboard API test đã được dọn; muốn kiểm chứng UI phải tạo lại fixture có chủ đích.

## 5. Bằng chứng máy và tái kiểm chứng

Các artifact sau là local ignored bookkeeping, không chứa credential thật và không thay thế versioned report này:

- [Successful subchecks JSONL](<../../.superpowers/sdd/2026-10-30-central-infrastructure/runtime-results.jsonl>) — **chỉ** các subcheck thành công; phải đọc kèm failure record.
- [Failure/limits record](<../../.superpowers/sdd/2026-10-30-central-infrastructure/runtime-known-deviations.json>).
- [Final inventory](<../../.superpowers/sdd/2026-10-30-central-infrastructure/runtime-final.json>) — thời điểm, versions/digests, trạng thái và các mục chưa đạt.
- [Backup manifest/checksums](<../../.superpowers/sdd/2026-10-30-central-infrastructure/runtime-backup-manifest.json>).
- [Missing-bind reproducer](<../../.superpowers/sdd/2026-10-30-central-infrastructure/runtime-negative.ps1>) — dự kiến vẫn exit nonzero trên host hiện tại; không đổi assertion để ghi PASS.
- [Final-state checker](<../../.superpowers/sdd/2026-10-30-central-infrastructure/runtime-final.ps1>) — đối chiếu trạng thái, artifact cleanup, checksum/ACL và kết quả, không khởi chạy lại toàn bộ test.

Stack được để chạy tại <http://127.0.0.1:3000>. Xem [runbook](<central-infrastructure.md>) trước lần stop/start, test hoặc restore tiếp theo. Không dùng kết quả này để tuyên bố production-ready.
