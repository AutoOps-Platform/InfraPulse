# Bước 5 — Checklist Grafana dashboards và alerting

**2026-11-02:** implementation ban đầu chỉ static JSON/YAML/PromQL checks. Sau khi được phép riêng, đã kiểm tra Grafana thật: hai dashboard provisioned/render được, Linux có metrics, Windows No data; [report và ảnh](<grafana-vm1-20261102.md>). Alerts/notifications chưa chạy, chưa có Windows Agent. Các checkbox chưa đánh dấu bên dưới là tiêu chí full qualification **chưa được xác minh đầy đủ**, kể cả khi một phần đã quan sát trong lab một host. Không tự động tạo tải hoặc gửi notification ngoài phạm vi được phép.

Nguồn và quyết định: [hướng dẫn deployment](<../deployment/grafana-monitoring.md>), [Linux JSON](<../../observability/grafana/dashboards/infrapulse/linux-host.json>), [Windows JSON](<../../observability/grafana/dashboards/infrapulse/windows-host.json>), [alert rules](<../../observability/grafana/provisioning/alerting/host-health.yml>).

## 1. Trước khi chạy

- [ ] Sao lưu Grafana DB/export tài nguyên tùy biến; xác nhận project/volumes/overrides hiện có, UID không xung đột. Không `down -v`.
- [ ] Grafana 13.3.0, Prometheus 3.13.5, datasource UID `infrapulse-prometheus` trỏ đúng nơi nhận Agent push; không trỏ một TSDB trống mới.
- [ ] Kiểm tra contact points, notification policy/default receiver/SMTP trước khi rules được nạp. Dùng receiver lab được phép, không gửi tới địa chỉ giả hoặc production ngoài ý muốn.
- [ ] Có ít nhất hai identity máy khác nhau để chứng minh isolation; Linux và Windows có Telegraf profile đúng, credential hợp lệ, TLS verified. Không gửi API Key/private PEM/env vào report.
- [ ] Đồng hồ Agent/central đồng bộ; xác định collection interval từng profile để chọn rate window ít nhất 4× interval. Nhóm metric tùy chọn không bị tắt ngoài chủ ý.

## 2. Provisioning và datasource

- [ ] Load Grafana với mounts hiện có, ghi nhận logs provisioning/migration không lỗi; chỉ hai dashboard curated trong folder InfraPulse, không nạp thêm originals.
- [x] Datasource query đúng Prometheus, không datasource placeholder/missing UID, không yêu cầu external panel plugin. Đã xác minh trong lab vm-1 ngày 2026-11-02.
- [ ] JSON legacy đã migrate/render đúng trên Grafana 13.3.0; stat/timeseries/text không vỡ layout/unit.
- [ ] Bốn rules trong group `infrapulse-host-health` org 1/folder InfraPulse, interval 1m; expression A/B/C không lỗi, labels giữ từng server/agent/volume.
- [ ] Sửa dashboard JSON tăng version, chờ poll 30s; sửa alert YAML rồi reload/restart có chủ đích. Restart/container recreation không tạo bản trùng hoặc mất tài nguyên operator.
- [ ] Trường hợp provider cũ từng nạp originals: xác nhận migration path/deletion chỉ ảnh hưởng tài nguyên provisioned mong muốn; giữ backup.

## 3. Identity, metrics và units

- [ ] `server_id` single-select; `agent_id` chỉ thuộc server đã chọn. Chuyển A→B không giữ Agent A hoặc hiển thị lẫn dữ liệu A/B; No data trong khi selection chưa hợp lệ.
- [ ] Chọn nhiều mount/volume/interface không vượt scope identity; thử giá trị có ký tự regex được escape; bỏ toàn bộ selection không gộp mọi host.
- [ ] Không có `job=windows`, hostname/exported_instance hoặc Prometheus `up` dùng thay identity Agent.
- [ ] Linux CPU `cpu_usage_active{cpu="cpu-total"}`, RAM `mem_used_percent`, disk `path` đối chiếu OS; metrics labels đúng server/agent/os. Load là giá trị tuyệt đối, uptime seconds.
- [ ] Windows PDH `_Total` CPU, `win_system_System_Up_Time`, `win_disk_Percent_Free_Space` / `win_disk_Free_Megabytes` có đúng tên và `instance` thực tế; Windows RAM/net từ native inputs.mem/net.
- [ ] Windows disk used = 100 − free%; free bytes = MiB × 1024²; C:/D:/volume mount thực tế không bị hardcode hoặc cộng chung. `_Total` không được tính thành volume.
- [ ] Linux disk panels/alerts loại read-only/pseudo theo chủ ý; mount production cần quan sát không vô tình bị exclusion.
- [ ] NIC counter tăng → rate bytes/s hợp lý; counter reset/reboot không tạo spike âm; không cộng virtual/physical NIC đếm trùng. Kiểm tra profile chậm 300s với Min step/rate window tương ứng.

## 4. Dashboard freshness và khoảng trống

- [ ] Instant stats không hiện last historical value của time range khi current series hết lookback. Thiếu dữ liệu là No data, không 0/UP xanh.
- [ ] Dừng Agent lab được phép: age tăng theo timestamp gốc, không bị `last_over_time` làm mới; chart có gap, không nối liền giả.
- [ ] Restart Agent: xác nhận timestamp mới, uptime/reset có nghĩa đúng, age giảm. Không suy ra backend Online từ màu panel.
- [ ] Sample-age dùng cửa sổ subquery 24h cộng selector lookback (thường 5m), bước 1m: sau khi không còn sample được giữ thì No data; không hứa cutoff đúng 24h. Phân biệt với raw range 24h của alert. Identity chưa từng gửi là No data; menu history phụ thuộc time range. Kiểm tra clock skew và delayed samples trong giới hạn Gateway.

## 5. Alert thresholds, labels và No Data

- [ ] CPU >85%, RAM >90%, disk free <10% giữ đủ 5m mới Firing; dưới threshold thì không Firing. Dùng dữ liệu/tải lab có kiểm soát; không làm đầy disk production.
- [ ] CPU/RAM/disk riêng hai host: chỉ host bị vượt ngưỡng Firing, disk chỉ volume tương ứng; không mất server/agent/os/volume sau reduce/threshold.
- [ ] Stale query: host fresh =0, host đã thấy trong 24h nhưng không uptime 5m =1; sau pending 1m đúng instance Firing ngay cả khi host khác vẫn gửi đều.
- [ ] Khôi phục uptime: stale instance về Normal vì có sample, phân biệt với Normal(MissingSeries) do eviction.
- [ ] Toàn bộ query rỗng → DatasourceNoData; datasource lỗi → DatasourceError, không Normal giả. Kiểm tra pending/timing thực tế, labels thiếu server_id và notification templates tương ứng.
- [ ] Partial missing resource series → MissingSeries sau hai evaluations; xác nhận đó không được hiểu thành hồi phục host. Collector bị tắt chỉ có No data, không có per-resource absence rule riêng.
- [ ] Horizon hết 24h / Agent retired/replaced / server chưa từng gửi: ghi nhận giới hạn, silence identity cũ và đối chiếu inventory Management. Không tuyên bố rule là health/lifecycle authority.
- [ ] Annotation Go templates render labels/values và link dashboard theo đúng OS; `$1` trong disk label_replace tạo `volume` thật, không thành `$1` literal/chuỗi rỗng.

## 6. Notification và vận hành

- [ ] Route lab theo `infrapulse_scope=host`; nhận đúng Firing/Resolved/NoData/Error, kiểm tra grouping theo identity và không lộ credential.
- [ ] Dashboard selection/time range không làm đổi global alert evaluation; `__expr__` không nhầm thành datasource Prometheus mới.
- [ ] Restart Grafana giữ UID/rules; thay version không trùng resources. Manual import được kiểm tra trong môi trường khác, không xung đột provisioned UID.
- [ ] Đo chi phí query 24h/evaluation 1m với số host dự kiến trước production; chưa có performance claim.
- [ ] Report ghi phiên bản, OS/counter thực tế, selected IDs đã được phép, thời điểm và bước PASS/FAIL/NOT RUN; không ghi key, assertion, private PEM hoặc file env.
