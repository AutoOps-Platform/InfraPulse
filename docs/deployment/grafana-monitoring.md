# Bước 5 — Grafana dashboards và basic alerting

## Trạng thái và phạm vi

Đã triển khai cấu hình **hai dashboard** và **bốn Grafana-managed alert rules** cho stack hiện có: Grafana 13.3.0, Prometheus 3.13.5 và Telegraf 1.38.2. Lần implementation ban đầu chỉ kiểm tra tĩnh, không chạy E2E hoặc thay VM.

**Cập nhật kiểm thử 2026-11-02, sau khi được phép riêng:** đã thêm Grafana vào lab hiện hữu, đăng nhập và quan sát hai dashboard provisioned; Linux có dữ liệu thật, Windows render No data. Cả 16 target Linux query qua Grafana thành công. **Không nạp alert rules/không thử notifications, chưa có Windows Agent.** Xem [report và ảnh bằng chứng](<../testing/grafana-vm1-20261102.md>); không coi đây là full qualification.

Không thêm Custom App Plugin, exporter, InfluxDB, AIOps, recording-rule pipeline hoặc contact point. Không sửa Gateway, Backend, monitoring profiles, datasource hay Compose: các mounts hiện có đã đủ cho provisioning mới.

## 1. Dashboard public được chọn

| OS | Public dashboard / revision | Lý do chọn và điều chỉnh |
| --- | --- | --- |
| Linux | [14396 — System Metrics for the Linux Hosts, revision 1](https://grafana.com/grafana/dashboards/14396-system-metrics-for-the-linux-hosts/) của wasteland | Dùng Telegraf + Prometheus, phù hợp CPU/RAM/disk/network/uptime/load. Bản cũ khai báo Grafana 7.1.1, còn giả định `up`/`instance`, panel legacy và nhóm metrics ngoài profile. Chỉ giữ nhóm tài nguyên cơ bản, đổi sang stat/timeseries/text built-in và identity của InfraPulse. |
| Windows | [3563 — Windows Host Overview, revision 1](https://grafana.com/grafana/dashboards/3563-windows-host-overview/) của rogerw | Cũng dùng Telegraf + Prometheus. Bản cũ khai báo Grafana 4.4.1, phụ thuộc nhiều PDH counter không được thu thập, giả định job/hostname/exported_instance và cấu trúc graph/singlestat cũ. Thay bằng các counter thực sự được cấu hình và `inputs.mem`/`inputs.net` của Bước 4. |

Đã mở trực tiếp hai trang catalog và tải JSON revision 1 từ các link chính thức [Linux](https://grafana.com/api/dashboards/14396/revisions/1/download), [Windows](https://grafana.com/api/dashboards/3563/revisions/1/download). JSON public đối chiếu **bằng nội dung JSON** với hai bản bạn tải; không sửa bản gốc:

- [Linux nguyên bản](<../../observability/grafana/dashboards/system-metrics-for-the-linux-hosts_rev1.json>), SHA-256 tại thời điểm khảo sát: `334077fd9894fc0c902a877ce6f8fe7c63e9d889412c947e3c59ed1a31cc5da0`.
- [Windows nguyên bản](<../../observability/grafana/dashboards/windows-host-overview_rev1.json>), SHA-256: `2718750a3fdefbd6f1288922ac12e734fdb6bb4558e5b47dd7704d3ef2dd0c5b`.

Bản thích nghi nằm trong thư mục con riêng; provider **không tự import hai bản gốc**. Đây là nâng cấp/thu gọn hai dashboard public, không phải thêm dashboard chính thứ ba. Các phiên bản Grafana trên chỉ là provenance: không có tuyên bố rằng JSON legacy import nguyên trạng vào Grafana 13 sẽ hoạt động.

## 2. Files được sử dụng

- [Linux Host](<../../observability/grafana/dashboards/infrapulse/linux-host.json>): UID `infrapulse-linux-host`, 12 panels cơ bản.
- [Windows Host](<../../observability/grafana/dashboards/infrapulse/windows-host.json>): UID `infrapulse-windows-host`, 11 panels cơ bản.
- [Dashboard provider](<../../observability/grafana/provisioning/dashboards/providers.yml>): org 1, folder `InfraPulse`, chỉ quét `/etc/grafana/dashboards/infrapulse`, chu kỳ 30s, không cho UI ghi đè source.
- [Host alert rules](<../../observability/grafana/provisioning/alerting/host-health.yml>): một evaluation group `infrapulse-host-health`, folder `InfraPulse`, đánh giá mỗi 1m.
- [Datasource hiện có](<../../observability/grafana/provisioning/datasources/prometheus.yml>): UID cố định `infrapulse-prometheus`, proxy nội bộ `http://prometheus:9090`; không có import placeholder `${DS_PROMETHEUS}`.
- [Compose hiện có](<../../deploy/compose/compose.yaml>): mounts cả provisioning và dashboards read-only; Grafana chỉ bind `127.0.0.1:3000`. Không cần build image Grafana riêng.

Hai dashboard dùng classic JSON schema 39 với panel built-in; Grafana vẫn có thể thực hiện migration khi load. Migration/rendering trên phiên bản thực tế là bước kiểm thử còn thiếu, không được chứng minh chỉ bằng JSON parse.

## 3. Hợp đồng metrics và truy vấn

Nguồn cấu hình là [templates Linux](<../../agents/telegraf/templates/linux/system.toml>), [templates Windows](<../../agents/telegraf/templates/windows/system.toml>), [agent global tags](<../../agents/telegraf/templates/agent.toml.tpl>) và [Prometheus Remote Write output](<../../agents/telegraf/templates/output-http.toml.tpl>). Tham khảo [bằng chứng Linux lab Bước 4](<../testing/evidence/telegraf-agent-vm1-20261102.json>) để đối chiếu tên đã từng quan sát; đó **không phải bằng chứng dashboard Bước 5 đã hiển thị**. Tên Windows hiện chỉ được đối chiếu với template, chưa xác minh trên Windows.

| Chỉ số | Linux | Windows | Ý nghĩa/query |
| --- | --- | --- | --- |
| CPU | `cpu_usage_active{cpu="cpu-total"}` | `win_cpu_Percent_Processor_Time{instance="_Total"}` | Gauge %, 0–100. Không dùng `rate()` cho PDH percent; không cộng các core. |
| RAM % | `mem_used_percent` | `mem_used_percent` | Cả hai dùng `inputs.mem`; không giả định `win_mem_*`. |
| RAM capacity | `mem_used`, `mem_available`, `mem_total` | `mem_used_percent` trên chart Windows | Linux chart là bytes; Windows chart là %. Không đồng nhất available với free. |
| Disk used/free | `disk_used_percent`, `disk_free`, label `path` | `win_disk_Percent_Free_Space`, `win_disk_Free_Megabytes`, label `instance` | Windows used = 100 − free%; free bytes = Free Megabytes × 1024². Không gộp nhiều volume thành một disk. |
| Network | `net_bytes_recv`, `net_bytes_sent`, label `interface` | Cùng tên từ `inputs.net` | `rate(counter[$__rate_interval])`, bytes/s, tách từng NIC. Không cộng bridge/virtual/physical dễ đếm trùng. |
| Uptime | `system_uptime` | `win_system_System_Up_Time` | Seconds, query hiện tại; không dùng `up` của Prometheus để đại diện Agent push. |
| Load | `system_load1`, `system_load5`, `system_load15` | Không có panel | Load tuyệt đối, không phải %. |

### Identity và variables

- Mỗi dashboard cố định `os="linux"` hoặc `os="windows"`.
- Chọn **một `server_id`**, rồi **một `agent_id`** được lọc theo server; không có All/multi cho identity, không lưu UUID máy lab trong source.
- Mọi data query đều lọc hai identity bằng `${server_id:regex}` / `${agent_id:regex}` và yêu cầu label không rỗng. Mount/volume/interface là multi/All nhưng luôn nằm trong identity đã chọn.
- Gateway ràng buộc `server_id`/`agent_id` với credential. `os`, `host` là tag khai báo bởi Agent, **không phải OS/inventory đã được Backend chứng thực**. Variables không phải RBAC/tenant isolation; quyền truy cập Grafana và datasource vẫn do operator quản lý.
- Linux loại filesystem pseudo và mount read-only khỏi disk panels/alerts; Windows loại instance `_Total`. Đây là lọc query, không sửa collection profile. Kiểm tra lại exclusions nếu cần giám sát container overlay, tmpfs hoặc read-only volume.
- Profile base thu thập 15s; datasource hiện có minimum interval 30s, dashboard refresh 30s. Network dùng `$__rate_interval`, không biến gauge thành counter. Với profile tùy chỉnh chậm hơn, phải tăng query **Min step** (cả hai target RX/TX) hoặc datasource interval cho phù hợp; rate window nên ít nhất 4 lần collection interval. Không coi collector bị tắt trong profile là giá trị 0.

### No Data trên dashboard

Overview stat dùng **instant-only query**, tránh lấy last value của cả time range và tô xanh dữ liệu cũ nhiều giờ. Tuy nhiên instant selector vẫn chịu lookback mặc định của Prometheus (thường 5m): nó không chứng minh sample vừa được nhận. Chart giữ gap (`spanNulls=false`); thiếu dữ liệu hiển thị `No data`, không được `or vector(0)` thành khỏe mạnh.

Panel sample-age tính từ **timestamp gốc** của uptime trong cửa sổ subquery 24h, bước 1m. Mỗi instant selector bên trong còn dùng lookback Prometheus (thường 5m), nên sample gốc có thể còn hiển thị tới khoảng 24h+5m, với độ xấp xỉ bước 1m. Đây không phải cutoff timestamp gốc đúng 24h; khác với cửa sổ raw range 24h của Metrics Stale. Không dùng `timestamp(last_over_time(...))` vì sẽ làm timestamp cũ thành mới. Mốc màu age 90/300s chỉ giúp đọc sample age; **không đồng nhất với Online/Stale/Offline của Management**, vốn dựa receipt từ Gateway và độ tin cậy telemetry. Clock skew, sample cũ được chấp nhận, ingestion delay hoặc hết lịch sử 24h đều ảnh hưởng kết quả.

## 4. Basic alert rules

Các rule query trực tiếp datasource, **không dùng dashboard variables**, giữ labels `(server_id, agent_id, os)`; disk thêm `volume`. A = Prometheus instant query, B = reduce last, C = threshold, không dùng Classic condition làm mất identity.

| Rule / UID | Điều kiện | Pending |
| --- | --- | --- |
| CPU High / `infrapulse-cpu-high` | Linux total hoặc Windows `_Total` >85% | 5m |
| Memory High / `infrapulse-memory-high` | `mem_used_percent` >90% | 5m |
| Disk Space Low / `infrapulse-disk-space-low` | Free <10% trên mỗi volume; Linux = 100 − used% | 5m |
| Metrics Stale / `infrapulse-metrics-stale` | Identity đã có uptime trong 24h nhưng không có sample trong 5m | 1m |

Đây là starting defaults, chưa benchmark production. Màu stat CPU 85/95, RAM 90/95, disk used 80/90 (Windows free 10/20) là visual thresholds, **không tạo thêm critical alert rule**. Tần suất 1m và pending khiến thời gian phát hiện không chính xác bằng một đồng hồ deadline.

### No Data, Error và MissingSeries

- Mỗi rule: `noDataState: NoData`, `execErrState: Error`; không chuyển thiếu data/lỗi datasource thành Normal. Grafana tạo `DatasourceNoData`/`DatasourceError` riêng; labels của chúng không nhất thiết có server/agent. Receiver/notification templates phải xử lý loại này, không bắt buộc `server_id` cho mọi notification. NoData cũng có pending theo cơ chế Grafana, không hứa báo ngay.
- Nếu chỉ **một phần series biến mất**, rule resource vẫn có thể có dữ liệu từ host khác. Grafana evict instance thiếu sau `missing_series_evals_to_resolve: 2`; trạng thái Normal với lý do `MissingSeries` **không phải bằng chứng máy hồi phục**. Metrics Stale giữ lại identity đã quan sát để giảm blind spot này.
- Stale: gọi K là identity có uptime trong 24h, F là identity có uptime trong 5m; `(K unless F) or (0*K)` trả 1 cho stale, 0 cho fresh. Khi K rỗng, query vẫn rỗng → NoData, không tạo số 0 giả. Dùng uptime vì template luôn thu thập system, kể cả khi nhóm CPU/disk/network bị tắt.
- **Giới hạn cố ý:** không phát hiện server chưa từng gửi metrics; sau 24h không còn identity và alert có thể bị evict/NoData, không có nghĩa đã phục hồi. Agent retired/replaced có thể bị stale tới hết cửa sổ lịch sử; operator cần silence identity cũ và đối chiếu inventory Management. Rule không biết lifecycle/maintenance, không chứng minh máy tắt, không thay thế Backend status. Nhóm metrics tùy chọn bị tắt/thiếu riêng lẻ không có per-host absence alert riêng trong phạm vi này.
- Cửa sổ 24h có chi phí range scan, lặp theo evaluation; chưa load-test số lượng Agent lớn. Khi chỉnh horizon/interval, sửa query, mô tả và checklist đồng bộ.

### Notification không tự cấu hình

Không tạo/sửa contact points, notification policies, SMTP, webhook hoặc secret. Rules có labels `severity=warning`, `infrapulse_scope=host`, `signal=...` để operator route bằng cấu hình hiện có. **Rules sẽ dùng policy hiện hữu**, kể cả default receiver; hãy kiểm tra receiver/policy trước khi enable/restart trên môi trường thật để tránh gửi ngoài ý muốn. Không có cam kết email/Slack đã gửi được. Có thể dùng route con `infrapulse_scope=host` mà không ghi đè toàn bộ policy tree. Không tự động remediation.

Tham khảo [Grafana file provisioning](https://grafana.com/docs/grafana/latest/alerting/set-up/provision-alerting-resources/file-provisioning/), [schema đúng tag 13.3.0](https://github.com/grafana/grafana/blob/v13.3.0/pkg/services/provisioning/alerting/rules_types.go), [MissingSeries](https://github.com/grafana/grafana/blob/v13.3.0/docs/sources/alerting/fundamentals/alert-rule-evaluation/stale-alert-instances.md). Các query models và annotations được loại khỏi env interpolation của provisioning; giữ `$1` trong `label_replace` và `$labels`/`$values` trong Go templates, không thay bằng `$$1`.

## 5. Nạp tự động, import thủ công và cập nhật

**Các lệnh sau là hướng dẫn cho lần triển khai được phép sau này; không được chạy trong Bước 5.** Từ repository root, sau khi đã chuẩn bị env/secrets và stack theo [hướng dẫn Management](<management-backend.md>) và [Agent](<telegraf-agent.md>):

```sh
# Dùng cùng -p / --env-file và các -f override của deployment hiện có.
docker compose --env-file .env -f deploy/compose/compose.yaml up -d prometheus grafana
# Nếu Grafana đã chạy: restart để đọc provider path và alert provisioning mới.
docker compose --env-file .env -f deploy/compose/compose.yaml restart grafana
```

Không copy lệnh sang VM lab với project khác mà bỏ `-p`/override: sẽ tạo stack/volumes khác. Không `down -v`, không xóa database Grafana. Không cần publish Prometheus/Grafana ra Internet; giữ loopback, truy cập qua SSH tunnel/reverse proxy được quản lý. Datasource phải trỏ đúng Prometheus đang nhận Remote Write, không phải một Prometheus trống mới.

Sau load, folder `InfraPulse` có **Linux Host** và **Windows Host**. Alerting có group `infrapulse-host-health`. Những điều này cần xác minh thực tế theo [checklist](<../testing/grafana-monitoring-checklist.md>), chưa được quan sát trong lần implementation.

**Import thủ công (môi trường không dùng provisioning):** tạo Prometheus datasource với UID `infrapulse-prometheus` hoặc sửa toàn bộ datasource refs sang UID thật, sau đó import một trong hai JSON đã thích nghi qua Grafana Dashboards → New → Import. Không import original nếu muốn hợp đồng InfraPulse. Không vừa manual-import vừa provision cùng UID; sẽ xung đột/quyền chỉnh sửa bị provisioning quản lý. Manual import dashboard **không** import alert rules; rule file cần file provisioning hoặc luồng import alert được operator quản lý riêng.

**Cập nhật:** sửa JSON/query trong repo, giữ UID ổn định, tăng `version`; provider poll 30s cập nhật dashboard. Thay provider YAML hoặc alert YAML cần restart Grafana (hoặc Admin provisioning reload API có quyền thích hợp); alert files không được dashboard poll reload. Không chỉnh dashboard provisioned trong UI rồi kỳ vọng source thay đổi. Không copy API Key/private CA key vào JSON/YAML. Khi đổi datasource UID, cập nhật đồng thời provider datasource, dashboard, variables và tất cả alert query refs.

**Nâng cấp từ provider cũ:** provider trước đây quét cả thư mục gốc. Nếu original 14396/3563 từng được provision, `disableDeletion=false` có thể loại bản provisioned cũ khi path đổi. Sao lưu/export dashboard tùy biến trước; không xóa thủ công dashboard/alert của operator. Existing resource có UID trùng phải được kiểm tra trước khi restart. Hai original vẫn được lưu để đối chiếu; chỉ hai bản curated được nạp mới.

## 6. Kiểm tra tĩnh đã thực hiện và phần chưa xác minh

- Parse hai dashboard JSON, các YAML provisioning; kiểm tra datasource UID, unique panel IDs/layout, identity scope, đơn vị, biến, instant/range, null/gaps và labels của alert.
- So sánh JSON download chính thức với hai original, xác nhận không sửa original.
- `promtool check rules` từ image Prometheus đã pin, chạy **offline** với network disabled và mount read-only; chỉ parse PromQL được trích xuất, thay Grafana macros bằng giá trị giả. Đây không phải Prometheus/Grafana server, không query metrics, không evaluate alert.
- Dù parser thành công, chưa chứng minh Grafana load/migrate/render, variable menus có dữ liệu, Windows counter names thực tế, threshold/no-data transitions, contact point delivery hay khả năng scale.

Xem [checklist kiểm thử sau](<../testing/grafana-monitoring-checklist.md>). Không suy diễn từ kết quả Linux Agent lab Bước 4 sang dashboard/alerting đã chạy thành công.
