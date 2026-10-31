# Bước 2 — FastAPI Ingestion Gateway: thiết kế

- Ngày: 2026-10-31.
- Trạng thái: người dùng đã duyệt tài liệu tổng hợp ngày 2026-10-31; được phép lập implementation plan, chưa được phép triển khai.
- Phạm vi hiện tại: thiết kế và kế hoạch; chưa viết product code, cài dependency, build image hoặc triển khai Gateway.
- Không stage, commit hoặc push tài liệu khi chưa được người dùng cho phép sau khi xem thay đổi.

## 1. Mục tiêu và thay đổi phạm vi đã thống nhất

Xây dựng luồng lab local:

```text
Remote Write Test Client
    → FastAPI Gateway
    → Prometheus Remote Write Receiver hiện có
    → Grafana datasource hiện có
```

Gateway đọc và kiểm tra Snappy/Protobuf, bổ sung định danh nhất quán, bảo vệ tài nguyên và chỉ trả thành công sau khi Prometheus xác nhận. Thiết kế phải dễ kiểm thử và dễ bổ sung xác thực sau này.

Yêu cầu ban đầu có xác thực API Key, ánh xạ credential và chống giả mạo server_id. Người dùng đã thay đổi phạm vi: Bước 2 chỉ yêu cầu Bearer token không rỗng và nhận hai ID qua header; chưa xác minh key. Các yêu cầu xác thực, hết hạn, thu hồi và chống giả mạo theo credential được hoãn, không được ghi nhận là đã hoàn thành.

### Đã chốt

- Python, FastAPI, uv, HTTPX; không Nginx.
- POST `/api/v1/ingest/remote-write`.
- `Authorization: Bearer <non-empty-token>`, `X-Server-ID`, `X-Agent-ID`.
- Hai ID do client tự khai báo, không phải danh tính đã xác thực.
- HTTP trong lab; publish Gateway trên host loopback, không nhận từ VM qua LAN trong bước này.
- Prometheus Remote Write 1.0 wire format, scalar samples; Snappy block/raw, không framed.
- Thiếu nhãn định danh thì bổ sung từ header; nhãn mâu thuẫn hoặc trùng tên thì từ chối toàn bộ request trước khi forward.
- Một lần forward/request, không retry nội bộ; sender quản lý retry.
- Dùng project `services/ingestion-gateway` và layout `app/` đã có, không tạo `apps/ingest` hoặc chuyển sang layout `src/`.
- Có unit tests, integration tests và E2E local đến Grafana.

### Ngoài phạm vi

- CredentialProvider/file danh bạ credential, ánh xạ key với máy, NestJS và quản trị credential.
- TLS/LAN ingress, Agent Installer, kiểm chứng Telegraf trên Windows/Linux VM thật.
- Native histograms, exemplars, metadata mở rộng, Remote Write 2.0, backfill quá cửa sổ thời gian quy định.
- RabbitMQ, durable queue, background ingestion, AIOps, Grafana Plugin, HA/multi-worker.
- Cam kết exactly-once hoặc transaction nguyên batch tại Prometheus.

## 2. Hiện trạng repository và đầu vào kế thừa

### Project Gateway hiện hữu

Đã kiểm tra trực tiếp:

- [pyproject.toml](<../../../services/ingestion-gateway/pyproject.toml>): project `ingestion-gateway`, version `0.1.0`, Python `>=3.12`, dependency `fastapi[standard]>=0.162.0`.
- [uv.lock](<../../../services/ingestion-gateway/uv.lock>) đã tồn tại; không tạo project hoặc lockfile thứ hai.
- [main.py](<../../../services/ingestion-gateway/app/main.py>) và [app/__init__.py](<../../../services/ingestion-gateway/app/__init__.py>) đang trống ở thời điểm khảo sát.
- Có `.venv` local; không đưa môi trường Windows này vào image Linux.
- Thư mục `services/` đang untracked khi kiểm tra; đây là dữ liệu workspace có trước tài liệu này, không tự xóa, stage hoặc khởi tạo lại.

Code Graph của `C-MF-VSCODE-InfraPulse` sẵn sàng nhưng generation `2026-10-30T13:49:57Z` chưa theo dõi các file Gateway. Vì vậy các nhận định trên dựa vào đọc source trực tiếp, không dựa vào kết quả graph rỗng.

### Hạ tầng Bước 1

| Đầu vào hiện có | Tái sử dụng trong Bước 2 |
|---|---|
| [compose.yaml](<../../../deploy/compose/compose.yaml>), project name `infrapulse` | Bổ sung service `ingest`, không tạo Compose project/Prometheus song song |
| Service `prometheus`, cờ `--web.enable-remote-write-receiver` | Forward đến `http://prometheus:9090/api/v1/write` |
| Network Compose key `monitoring` | Gateway và test client nội bộ dùng network này; không giả định tên Docker network tuyệt đối |
| Network `database`, internal | Gateway không tham gia, không dùng PostgreSQL |
| [prometheus.yml](<../../../observability/prometheus/prometheus.yml>), scrape interval 30s | Thêm job scrape `ingest:8000/metrics`, giữ job tự scrape hiện có |
| Grafana publish `127.0.0.1:3000:3000`, datasource hiện có | Dùng Grafana Explore, không tạo datasource trùng |
| [.env.example](<../../../.env.example>) và [.env local](<../../../.env>) ở root | Thêm cấu hình mẫu vào root template, không tạo env file cạnh Compose |
| `prometheus_data`, `grafana_data`, `postgres_data` | Giữ nguyên; không xóa, đổi tên hoặc dùng làm môi trường phá hủy khi test |

Bước 1 có [báo cáo nghiệm thu](<../../deployment/2026-10-30-central-infrastructure-acceptance.md>); không suy diễn rằng mọi giới hạn native Windows/port isolation trong báo cáo đã được giải quyết. Việc thêm Gateway không tự sửa các vấn đề đó.

Đã tham khảo toàn bộ [INTRODUCT.md](<../../../INTRODUCT.md>) và [Gateway Go cũ](<C:/MF/VSCODE/Cloud & Data Center Observability and Operations Platform/apps/ingest>). Chỉ kế thừa ý tưởng tách handler/codec/validation/forwarder, không sao chép source hoặc mặc định chính sách cũ phù hợp.

## 3. Các lựa chọn và lý do

| Chủ đề | Lựa chọn | Lý do và đánh đổi |
|---|---|---|
| Định danh | Nhận token và ID tự khai báo | Ưu tiên thông luồng lab; chưa có bảo vệ quyền đại diện |
| Mâu thuẫn nhãn | Reject thay vì overwrite | Phát hiện cấu hình sai, không âm thầm đổi danh tính |
| Codec | `protobuf` + `cramjam` raw API | Wire-compatible, có kiểm tra độ dài và giải nén vào buffer cố định |
| Passthrough bytes | Không dùng | Không kiểm tra/bổ sung được nhãn và payload theo yêu cầu |
| Retry | Sender retry, Gateway forward một lần | Không tạo tầng retry chồng nhau; vẫn tồn tại kết quả không chắc chắn khi mất response |
| Tổ chức code | Một FastAPI app chia module trong project hiện có | Dễ kiểm thử hơn một endpoint chứa toàn bộ logic, không thêm microservices/queue |
| Credential storage | Chưa tạo | CredentialProvider tạm thời không cần thiết khi validation key đã hoãn |
| Triển khai | Một worker, local HTTP | Rate limit trong bộ nhớ có ý nghĩa trong phạm vi một process; không phù hợp HA |

## 4. Kiến trúc và ranh giới module

```text
services/ingestion-gateway/
├── pyproject.toml
├── uv.lock
├── Dockerfile
├── .dockerignore
├── app/
│   ├── __init__.py
│   ├── main.py
│   ├── config.py
│   ├── routes/
│   │   ├── __init__.py
│   │   ├── ingest.py
│   │   └── health.py
│   ├── identity.py
│   ├── codec.py
│   ├── validation.py
│   ├── pipeline.py
│   ├── forwarder.py
│   ├── observability.py
│   └── proto/
│       ├── __init__.py
│       ├── remote_write.proto
│       └── remote_write_pb2.py
└── tests/
    ├── conftest.py
    ├── unit/
    │   ├── test_identity.py
    │   ├── test_codec.py
    │   ├── test_validation.py
    │   ├── test_admission.py
    │   └── test_forwarder.py
    ├── integration/
    │   ├── test_ingestion.py
    │   ├── test_health.py
    │   └── test_observability.py
    └── e2e/
        └── test_remote_write.py
```

- [main.py](<../../../services/ingestion-gateway/app/main.py>): app factory, lifecycle, error handlers; Uvicorn entrypoint `app.main:app`.
- `config.py`: settings có prefix `INGEST_`, kiểm tra giới hạn/URL hợp lệ khi startup; cấu hình sai thì fail startup.
- `routes/ingest.py`: HTTP adapter; không chứa toàn bộ logic codec/validation/forwarding.
- `identity.py`: parse Bearer và hai ID, trả ngữ cảnh định danh tự khai báo. Không gọi DB, không lưu token hoặc tạo provider giả.
- `codec.py`: đọc/ghi Snappy raw và Protobuf; không biết FastAPI hoặc HTTPX.
- `validation.py`: kiểm tra toàn batch, bổ sung ID, chuẩn hóa thứ tự labels; nhận thời điểm kiểm tra để test bằng clock cố định.
- `pipeline.py`: admission/rate/concurrency và điều phối các bước; không giữ lịch sử series xuyên request.
- `forwarder.py`: gọi upstream đúng một lần bằng HTTPX, trả kết quả có kiểu/phân loại lỗi; không forward credentials của client.
- `observability.py`: JSON logging, request ID, registry metrics của từng app instance, các bộ đếm/histogram hữu hạn.
- `routes/health.py`: liveness/readiness. `/metrics` được đăng ký từ `observability.py`, không cần một service mới.

Dependencies production bổ sung phải khai báo trực tiếp: HTTPX, protobuf, cramjam, pydantic-settings, prometheus-client. Giữ FastAPI hiện hữu, chỉ thay version khi có lý do tương thích được ghi nhận. pytest/pytest-asyncio và công cụ generate Protobuf thuộc nhóm dev; dùng HTTPX MockTransport, không cần thêm proxy hoặc mock server production.

Codegen dùng protoc qua công cụ dev được pin tương thích với protobuf runtime. Commit schema và generated Python vào source khi người dùng cho phép Git; generated file không sửa tay. Runbook ghi lệnh regenerate và kiểm tra generate không tạo diff. Công cụ protoc không biến Gateway thành dịch vụ gRPC.

## 5. Hợp đồng HTTP đầu vào

### Headers

| Header | Quy tắc |
|---|---|
| `Authorization` | Một header duy nhất, Bearer token không rỗng; thiếu hoặc sai cú pháp trả 401 |
| `X-Server-ID`, `X-Agent-ID` | Mỗi loại đúng một header; thiếu, rỗng, duplicate hoặc không hợp lệ trả 400 |
| `Content-Encoding` | Snappy raw/block qua token `snappy`; không chấp nhận gzip, framed hoặc chuỗi nhiều encoding |
| `Content-Type` | `application/x-protobuf`; chỉ hỗ trợ schema WriteRequest 1.0; tham số `proto=prometheus.WriteRequest` nếu có được chấp nhận |
| `X-Prometheus-Remote-Write-Version` | `0.1.0`; yêu cầu version khác không thuộc contract lab này |
| `User-Agent` | Sender có tên/version; kiểm tra có giá trị và giới hạn độ dài, không dùng làm metric label |

Header names không phân biệt hoa/thường. Không coi chuỗi token khác giá trị test là key sai: mọi token hợp lệ về cú pháp và không rỗng đều được nhận ở giai đoạn này.

Hai ID dài 1–128 ASCII bytes, dùng tập `[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}`. Token giới hạn 4 KiB; User-Agent tối đa 256 bytes. Đây là kiểm tra hình thức/kích thước, không phải xác thực credential.

HTTP status 415 dành cho Content-Type, Content-Encoding, schema/version không hỗ trợ. Các header định danh sai trả 400; token thiếu/sai cú pháp là ngoại lệ trả 401 và `WWW-Authenticate: Bearer`.

### Error response

JSON chỉ chứa mã lỗi hữu hạn, thông báo an toàn và request ID do Gateway tạo. Không echo token, ID không hợp lệ, raw payload, URL có credential, response upstream hoặc traceback. Thành công trả 204, body rỗng.

## 6. Codec và validation payload

### Luồng xử lý

1. Tạo request ID nội bộ, kiểm tra headers.
2. Áp dụng rate limit và lấy slot concurrency bằng thao tác không chờ xếp hàng dài.
3. Đọc body theo stream có giới hạn; có thể từ chối sớm theo Content-Length nhưng vẫn đếm bytes thực nhận.
4. Kiểm tra độ dài giải nén bằng `cramjam.snappy.decompress_raw_len`.
5. Chỉ cấp buffer khi độ dài hợp lệ, giải nén bằng `decompress_raw_into`; xác minh số bytes thực tế phù hợp. Không dựa vào tham số `output_len` của `decompress_raw` làm security boundary.
6. Parse Protobuf, kiểm tra nội dung và toàn bộ series/samples/labels.
7. Bổ sung ID, sắp xếp labels theo tên; không thay giá trị hoặc timestamp.
8. Serialize Protobuf và `compress_raw`; kiểm tra cả kích thước output sau chuẩn hóa trước khi forward.
9. Gọi Prometheus một lần, ánh xạ kết quả; trả slot trong mọi nhánh kết thúc.

Các thao tác codec/validation CPU-bound chạy qua threadpool có capacity hữu hạn, bị chặn bởi hai slot ingestion; không tạo số lượng background tasks không giới hạn. Khi request bị hủy, không thả slot trong khi vẫn còn công việc codec chạy không được kiểm soát.

### Schema và giới hạn tính năng

Schema tối thiểu wire-compatible Remote Write 1.0 gồm:

- `WriteRequest.timeseries`, field 1.
- `TimeSeries.labels`, field 1; `TimeSeries.samples`, field 2.
- `Label.name`/`value`, fields 1/2, string.
- `Sample.value`, field 1, double; `Sample.timestamp`, field 2, int64 milliseconds UTC Unix epoch.

Bước này là scalar-sample subset, không tuyên bố hỗ trợ mọi extension/phiên bản Remote Write. Unknown fields, bao gồm metadata/exemplars/native histograms, bị từ chối trước khi forward. Kiểm tra unknown fields phải recursive; có thể so sánh ByteSize bản gốc và bản sao sau `DiscardUnknownFields`, không xóa field rồi tiếp tục nhận request. Không lặng lẽ drop dữ liệu ngoài phạm vi.

Body nén rỗng, WriteRequest rỗng, series không có samples, Snappy lỗi và Protobuf lỗi đều trả 400. Không triển khai version negotiation bằng empty WriteRequest trong lab này.

### Labels và định danh

- Mỗi series phải có đúng một `__name__` hợp lệ.
- Metric name theo `[a-zA-Z_:][a-zA-Z0-9_:]*`, tối đa 256 UTF-8 bytes.
- Label name theo `[a-zA-Z_][a-zA-Z0-9_]*`, tối đa 128 UTF-8 bytes; không tên rỗng hoặc trùng.
- Label value không rỗng, tối đa 1 KiB UTF-8 bytes; `server_id`/`agent_id` còn phải khớp header theo quy tắc ID.
- Thiếu `server_id` hoặc `agent_id`: thêm từ header; đã có và khớp: giữ; khác: reject cả request.
- Đếm số labels sau khi thêm hai ID. Hai series trở thành cùng bộ nhãn sau chuẩn hóa trong một request bị từ chối, không âm thầm merge/deduplicate.
- Sắp xếp labels theo tên trước khi serialize; không dùng nhãn `host` làm nguồn danh tính thay cho hai header.

Các kiểm tra này bảo đảm dữ liệu nhất quán, không chứng minh ID thuộc về người giữ token.

### Samples và timestamps

- Giá trị giữ nguyên float64, kể cả signed zero, infinities và NaN/stale markers hợp lệ; không ép thành 0, không lọc bằng điều kiện chỉ nhận finite numbers.
- Trong một series, timestamp phải tăng nghiêm ngặt, không lặp timestamp trong cùng request.
- Dùng một thời điểm nhận request cố định để kiểm tra cửa sổ, không đọc wall clock lại cho từng sample.
- Timestamp nằm trong đoạn đóng `[received_at - 1 giờ, received_at + 2 phút]` theo mặc định.
- Không chỉnh timestamp cho vừa cửa sổ; ngoài cửa sổ trả 400.
- Không có history/cache ordering xuyên request; Prometheus quyết định duplicate/out-of-order giữa các request.

### Giới hạn mặc định

| Settings | Mặc định | Cách áp dụng |
|---|---:|---|
| `INGEST_MAX_COMPRESSED_BYTES` | 1048576 (1 MiB) | Body nhận và body nén lại trước forward |
| `INGEST_MAX_DECOMPRESSED_BYTES` | 8388608 (8 MiB) | Trước cấp buffer giải nén và sau serialize chuẩn hóa |
| `INGEST_MAX_SERIES` | 5000 | Cả request |
| `INGEST_MAX_SAMPLES` | 20000 | Tổng samples cả request |
| `INGEST_MAX_LABELS_PER_SERIES` | 64 | Sau bổ sung ID |
| `INGEST_MAX_INFLIGHT` | 2 | Từ trước đọc body đến kết thúc forward |
| `INGEST_RATE_PER_SECOND` | 10 | Token bucket toàn process |
| `INGEST_RATE_BURST` | 20 | Bucket ban đầu đầy, nạp theo monotonic clock |
| `INGEST_MAX_SAMPLE_AGE_SECONDS` | 3600 | So với received_at |
| `INGEST_MAX_FUTURE_SKEW_SECONDS` | 120 | So với received_at |
| `INGEST_BODY_READ_TIMEOUT_SECONDS` | 5 | Tổng thời gian đọc body; quá hạn trả 408 |

Vượt byte/series/sample resource limits trả 413; labels hoặc nội dung sai trả 400. Mọi giới hạn phải dương, trừ future skew được phép bằng 0. Không cho env vô hiệu hóa giới hạn bằng số âm hoặc 0 ngoài ngoại lệ đã nêu. Thời gian và số đếm có thể điều chỉnh bằng env; giới hạn hình thức header/name/value là contract cố định.

Byte limits không tương đương tổng memory của Python objects; concurrency hữu hạn, threadpool hữu hạn và memory limit container là các lớp bảo vệ bổ sung. Không chỉ đọc toàn body rồi mới kiểm tra kích thước.

## 7. Forwarding, timeout và retry

Một `HTTPX AsyncClient` được tạo trong lifespan, dùng lại connection pool, đóng khi shutdown. Không tạo client cho từng request; không dùng proxy từ environment ngoài ý muốn (`trust_env=False`) và không follow redirects.

URL upstream do cấu hình server quyết định, không nhận từ request. Chỉ chấp nhận HTTP/HTTPS, không userinfo hoặc fragment. Không forward Authorization, các header client tùy ý hoặc raw request ID do client cung cấp.

Headers upstream do Gateway đặt lại: Content-Type application/x-protobuf, Content-Encoding snappy, version 0.1.0 và User-Agent của Gateway có version.

| Settings | Mặc định |
|---|---:|
| `INGEST_CONNECT_TIMEOUT_SECONDS` | 2 |
| `INGEST_READ_TIMEOUT_SECONDS` | 10 |
| `INGEST_WRITE_TIMEOUT_SECONDS` | 10 |
| `INGEST_POOL_TIMEOUT_SECONDS` | 1 |
| `INGEST_UPSTREAM_DEADLINE_SECONDS` | 12, tổng thời gian forward |

Deadline tổng tránh hiểu nhầm read timeout của HTTPX là deadline toàn request. Không đọc body upstream không giới hạn; chỉ cần status/headers để phân loại, đóng streaming response trong mọi nhánh. Không đưa nguyên response upstream vào log hoặc response client.

### Ánh xạ kết quả

| Kết quả | HTTP Gateway | Retry nội bộ |
|---|---:|---|
| Upstream 2xx | 204 | Không |
| Upstream 400 từ chối samples | 400 | Không |
| Upstream 413 | 413 | Không |
| Upstream 429 | 429, Retry-After an toàn | Không |
| Upstream 5xx | 503 | Không |
| DNS/network/connection failure | 503 | Không |
| Connect/read/write/pool timeout hoặc deadline | 504 | Không |
| Upstream redirect hoặc status khác ngoài contract, gồm 401/403/404 | 502 | Không |
| Lỗi nội bộ không dự kiến | 500, thông báo an toàn | Không |

Prometheus có thể ghi một phần samples trước khi trả 400; Gateway không rollback được. Gateway chỉ bảo đảm không forward request đã fail validation của chính Gateway, không bảo đảm atomic batch trong TSDB.

Sender retry 5xx với exponential backoff có jitter; có thể retry 429 theo Retry-After; không retry 2xx hoặc các 4xx còn lại. Khi timeout/mất response, kết quả ghi có thể không chắc chắn; sender giữ nguyên timestamps khi gửi lại. Không tuyên bố exactly-once hoặc tự tạo timestamp mới khi retry.

## 8. Admission control

- Một Uvicorn worker; token bucket global theo monotonic clock, không phân biệt token/ID chưa xác thực.
- Bucket 10 requests/giây, burst 20; restart reset bucket là giới hạn chấp nhận được của lab.
- Tối đa hai ingestion requests đang xử lý, không tạo queue vô hạn.
- Hết token hoặc slot trả 429 và `Retry-After: 1`.
- Rate/concurrency limits chỉ áp dụng POST ingestion, không áp dụng health hoặc metrics.
- Header rejection không tiêu thụ slot decode/forward; request không hợp lệ vẫn được đếm theo nhóm nguyên nhân hữu hạn.
- Với upstream 429, chỉ nhận Retry-After dạng số giây hợp lệ trong 1–60; thiếu/khác định dạng dùng 1, không chuyển nguyên giá trị tùy ý.
- Không đưa nhiều workers vào Compose vì limiter này không chia sẻ state. Multi-worker/HA cần thiết kế admission control khác ở bước sau.

## 9. Health, metrics và logging

### Health

- `/health/live`: 200 khi process phục vụ được HTTP, không gọi Prometheus hoặc DB.
- `/health/ready`: 200 khi app init hoàn tất và `http://prometheus:9090/-/ready` trả 200; lỗi/timeout trả 503.
- Readiness có deadline tổng riêng, mặc định 1 giây, bao gồm connect và đọc response; không retry và không dùng timeout forward 10 giây cho health.
- Prometheus outage không làm liveness fail. Docker health trạng thái unhealthy không tự động restart chỉ vì upstream hỏng.
- Readiness chỉ chứng minh upstream ready, không chứng minh Remote Write endpoint được bật hoặc ghi thành công; E2E kiểm chứng điều đó.

### Metrics

Prometheus scrape `/metrics`; prefix các metrics nghiệp vụ là `infrapulse_ingest_`.

| Metric | Kiểu | Labels hữu hạn |
|---|---|---|
| `infrapulse_ingest_requests_total` | Counter | status |
| `infrapulse_ingest_request_duration_seconds` | Histogram | status_class |
| `infrapulse_ingest_inflight_requests` | Gauge | Không |
| `infrapulse_ingest_rejections_total` | Counter | reason enum |
| `infrapulse_ingest_forward_attempts_total` | Counter | result enum |
| `infrapulse_ingest_upstream_duration_seconds` | Histogram | result enum |

Reason/result labels được khai báo hữu hạn trong source, không lấy nguyên exception string. Chỉ đo ingestion trong các metrics nghiệp vụ, không tự tính scrape của `/metrics` thành traffic ingestion. Counter forward tăng một lần mỗi lần thật sự thử gọi upstream; validation rejection không tăng counter này. Registry theo app instance để tránh duplicate metric registration khi chạy tests.

Không dùng API Key, ID client, metric name từ payload, request ID, raw path/query hoặc error text làm label. Có thể giữ process/Python metrics chuẩn của prometheus-client nhưng không thêm exporter service.

### Logs và error response

- JSON stdout, request ID do Gateway tạo; không tin/bắt buộc echo request ID do client gửi.
- Trường ổn định: timestamp, level, event, request_id, route, status, duration_ms, series_count/sample_count nếu parse thành công, upstream_status và error_code khi liên quan.
- Không log Authorization/API Key, header dump, raw payload, raw response upstream hoặc ID không hợp lệ.
- Không bật HTTPX/httpcore wire debug chứa headers. Exception handling phải dùng thông điệp an toàn, không dump request/response object.
- Startup log nêu rõ identity chưa xác thực và chỉ dành cho lab, không chứa token.
- Không thêm tracing backend, DB logging hoặc một service observability mới.

## 10. Docker Compose và cấu hình

### Service `ingest`

- Build context `../../services/ingestion-gateway` tính từ file Compose hiện có.
- Container chạy một worker Uvicorn, bind `0.0.0.0:8000` bên trong container; host publish bắt buộc `127.0.0.1:${INGEST_HOST_PORT:-8000}:8000`.
- Chỉ network `monitoring`, không network `database`.
- `depends_on` Prometheus healthy cho thứ tự khởi động; readiness vẫn kiểm tra khi đang chạy, không coi dependency startup là bảo đảm lâu dài.
- Healthcheck gọi `/health/ready` bằng Python stdlib, không giả định image có curl/wget.
- Non-root user, cap_drop ALL, no-new-privileges, read-only root filesystem và tmpfs `/tmp`; memory limit 512 MiB, pids limit 128. Các điều kiện này phải được kiểm thử thực tế trong implementation.
- Dùng logging rotation hiện có: json-file, max-size 10m, max-file 3; restart unless-stopped.
- Không mount source để hot reload trong cấu hình nghiệm thu; không mount Docker socket, secrets Bước 1 hoặc volumes DB.
- Image Python 3.12 slim và uv được pin version; dependency cài theo lockfile frozen, không dùng latest. Không chọn/nâng phiên bản FastAPI tùy tiện chỉ vì viết Dockerfile.

### Cấu hình root

Bổ sung vào [.env.example](<../../../.env.example>):

- `INGEST_HOST_PORT=8000`.
- `INGEST_PROMETHEUS_WRITE_URL=http://prometheus:9090/api/v1/write`.
- `INGEST_PROMETHEUS_READY_URL=http://prometheus:9090/-/ready`.
- Các giới hạn và timeouts trong mục 6–7, `INGEST_READY_TIMEOUT_SECONDS=1`, `INGEST_LOG_LEVEL=INFO`.

Compose truyền có chọn lọc biến Gateway; không dùng env_file để nạp toàn bộ [.env local](<../../../.env>) vào container, tránh cấp nhầm password Grafana/PostgreSQL. Không tạo biến credential store hoặc key validator giả. Token test không đưa vào root env mẫu; sender tự cấp token giả cho lab, không log hoặc hard-code key thật.

Docker ignore loại `.venv`, caches, local env/secrets, test artifacts, Git metadata và các dữ liệu không cần cho runtime. Root Git ignore cần bảo vệ `.venv`, Python caches và artifacts kiểm thử, nhưng vẫn theo dõi uv.lock/schema/generated Protobuf/test source.

### Scrape

Thêm job `ingestion-gateway` với target `ingest:8000` và path `/metrics`, giữ job `prometheus` và global interval 30s. Dùng DNS service trên network hiện có, không publish cổng Prometheus hoặc PostgreSQL ra host để tiện test.

Loopback publish là cấu hình dự kiến, không phải bằng chứng cách ly thực tế trên Docker Desktop. Khi được phép chạy tests, kiểm tra host loopback thành công và địa chỉ native host không truy cập được cổng Gateway. Nếu kiểm tra thực tế thất bại, báo FAIL và xử lý trước khi coi lab ingress được cách ly; không mở rộng sang LAN hoặc tự tuyên bố đã an toàn.

## 11. Danh sách file dự kiến tạo/chỉnh sửa

### Chỉnh sửa

- [pyproject.toml](<../../../services/ingestion-gateway/pyproject.toml>): dependencies trực tiếp, nhóm dev, config tests và codegen.
- [uv.lock](<../../../services/ingestion-gateway/uv.lock>): cập nhật bằng uv, không sửa tay hoặc tạo lockfile trùng.
- [main.py](<../../../services/ingestion-gateway/app/main.py>), [app/__init__.py](<../../../services/ingestion-gateway/app/__init__.py>): dùng scaffold hiện hữu.
- [compose.yaml](<../../../deploy/compose/compose.yaml>): thêm service `ingest`, không thay storage/service names Bước 1.
- [.env.example](<../../../.env.example>): thêm nhóm INGEST_ không chứa key thật.
- [.gitignore](<../../../.gitignore>): bổ sung Python/local test artifact ignores.
- [prometheus.yml](<../../../observability/prometheus/prometheus.yml>): thêm scrape job Gateway.
- [README.md](<../../../README.md>): hướng dẫn Bước 2 và link runbook, nêu auth deferred/lab-only.
- [Runbook Bước 1](<../../deployment/central-infrastructure.md>): ghi chú stack có Gateway và link runbook Bước 2; giữ phân biệt baseline Bước 1 với kết quả nghiệm thu mới.

### Tạo mới

- Dockerfile, .dockerignore, các modules và tests có đường dẫn đầy đủ theo cây ở mục 4, đều nằm dưới `services/ingestion-gateway`.
- `docs/deployment/ingestion-gateway.md`: cài dev bằng uv, codegen, cấu hình sender, startup/health, lỗi/retry, E2E và giới hạn bảo mật.
- `docs/deployment/ingestion-gateway-acceptance.md`: ghi kết quả thực thi sau khi người dùng cho phép triển khai/test, không điền PASS theo dự kiến thiết kế.
- Sau khi tài liệu thiết kế này được duyệt: `docs/superpowers/plans/2026-10-31-ingestion-gateway.md` là tên dự kiến cho implementation plan; nếu ngày lập kế hoạch thay đổi thì dùng ngày lập thực tế.

Không tạo file dưới `infra/`, không sửa Gateway Go tham khảo, không sửa [.env local](<../../../.env>) trong giai đoạn thiết kế, không reset hoặc ghi đè phần người dùng đang làm.

## 12. Chiến lược kiểm thử

### Unit

- Codec raw round-trip; framed/truncated/corrupt input; Protobuf lỗi; unknown fields recursive; empty messages; preserve float64/stale marker bits.
- Oversize body/declared decompressed length phải reject trước allocation/decode lớn; output lớn thêm sau inject cũng reject.
- Header syntax/duplicates, arbitrary non-empty key, IDs hợp lệ/không hợp lệ.
- Labels thiếu/khớp/mâu thuẫn/trùng tên, invalid name/value, sort ổn định, canonical series trùng, counts sau injection.
- Timestamp boundaries với clock cố định: đúng hai biên chấp nhận, lệch ngoài biên từ chối; ordering/duplicate timestamp.
- Token bucket/refill bằng fake monotonic clock, slot release khi exception/cancel, không kiểm thử bằng sleep dài.
- Forwarder đúng bytes/headers, một call, timeout/status mapping, không follow redirect, không leak client headers.

### Integration

FastAPI app factory/lifespan với HTTPX MockTransport làm upstream; không cần dừng Prometheus hiện hữu để giả lập lỗi.

- HTTP route → codec/validation → forwarder thực trong app; valid request 204.
- Validation fail không gọi upstream; label conflict có một series lỗi làm reject cả request.
- Missing/malformed Bearer 401; arbitrary key không rỗng được nhận. Wrong/revoked/expired key validation chưa thuộc pass criteria.
- Timeout, 5xx, 429, redirect, unexpected status, response body lớn/nhạy cảm; không trả thành công sai hoặc lộ dữ liệu.
- Health live vẫn 200 khi ready 503; timeouts health tách biệt; `/metrics` không bị ingestion limiter chặn.
- Metrics có result/count đúng và label sets hữu hạn; log/error không chứa sentinel token hoặc payload bí mật trong mọi nhánh lỗi.
- Không tự khởi tạo background delivery sau khi đã response.

### E2E local

`services/ingestion-gateway/tests/e2e/test_remote_write.py` là Remote Write Test Client, dùng cùng schema nhưng có fixture wire bytes được kiểm chứng độc lập để tránh chỉ kiểm tra cùng một lỗi encoder/decoder.

- Client chạy container dùng network `monitoring` được resolve từ Compose, gọi Gateway service DNS và query Prometheus bằng DNS nội bộ. Không cần thêm permanent test service hoặc expose Prometheus ra host.
- Gửi một metric cố định `infrapulse_e2e_value` với run_id riêng cho lần kiểm thử, timestamps hiện tại và giá trị biết trước; retry của test không đổi timestamps.
- Poll query API với deadline hữu hạn để chứng minh sample/value/server_id/agent_id/run_id đúng; không coi HTTP 204 là đủ.
- Kiểm tra cases missing identity labels và matching labels; label conflict phải không tạo series của fixture lỗi. Dùng run_id khác nhau để không nhầm dữ liệu cũ.
- Query `up{job="ingestion-gateway"}` sau tối đa 90 giây để kiểm tra scrape, không thay interval toàn stack chỉ để test nhanh.
- Mở Grafana Explore tại host port 3000, chọn datasource hiện hữu, query đúng metric/run_id và xác nhận giá trị/nhãn. Nếu UI chưa được kiểm tra thì đánh dấu chưa chạy/PARTIAL, không tự suy ra PASS từ datasource API.
- Kiểm tra host Gateway loopback và native-host isolation thực tế. Không coi container namespace probe là bằng chứng host isolation.
- Test Client không dừng/xóa production volumes hoặc reset DB. Samples fixture ở lại theo retention thông thường; không bật TSDB admin-delete API để dọn tests.

E2E này chưa chứng minh Telegraf Windows/Linux VM hoặc TLS/LAN hoạt động. Runbook có mẫu outputs.http với data_format prometheusremotewrite và headers cần thiết, nhưng thử nghiệm VM thật thuộc bước sau.

## 13. Tiêu chí nghiệm thu

| ID | Điều kiện đạt |
|---|---|
| GW-01 | Mở rộng đúng project/layout hiện có; uv lock/dependencies và codegen tái lập được |
| GW-02 | Service `ingest` trên network hiện có, không mở thêm Prometheus/Postgres, giữ nguyên volumes |
| GW-03 | Header contract và giới hạn hình thức đúng; key validation được ghi rõ là deferred |
| GW-04 | Snappy raw/Protobuf hợp lệ, bảo vệ allocation/body/output limits, reject unsupported extensions |
| GW-05 | Bổ sung/kiểm tra định danh đúng; request invalid không forward; không tuyên bố chống spoof |
| GW-06 | Validation labels/samples/timestamps và limits đúng, có boundary tests |
| GW-07 | Một forward/request, HTTPX lifecycle đúng; 204 chỉ sau upstream 2xx, status/timeout mapping đúng |
| GW-08 | Rate/concurrency limits hoạt động; health/metrics không bị chặn, không queue không giới hạn |
| GW-09 | Live/ready đúng khi upstream tốt/xấu; không restart loop do upstream outage |
| GW-10 | Metrics/logs an toàn, labels hữu hạn, sentinel credentials không xuất hiện |
| GW-11 | Unit và integration tests chạy thành công, không chỉ ghi file test |
| GW-12 | E2E xác nhận sample và nhãn trong Prometheus, Gateway scrape up |
| GW-13 | Grafana Explore hiển thị đúng fixture; kiểm tra UI có bằng chứng thực tế |
| GW-14 | Host loopback có thể dùng, native-host isolation được kiểm tra; không làm mất dữ liệu Bước 1 |
| GW-15 | Runbook/acceptance phản ánh kết quả thực, nêu rõ auth/LAN/VM/unsupported-feature limits |

Mỗi điều kiện báo PASS/FAIL/PARTIAL/NOT RUN theo bằng chứng thực thi. Thiết kế, cấu hình đã viết hoặc test case tồn tại không đồng nghĩa đã PASS. Không sửa báo cáo nghiệm thu Bước 1 để che giới hạn cũ.

## 14. Rủi ro và bước tiếp theo

- API Key chưa được xác thực: người có thể truy cập Gateway có thể tự khai báo cả token và ID. Đây là giới hạn chủ đích của lab, không phải authentication đã hoàn thiện.
- Local HTTP chỉ chấp nhận trong phạm vi đã chốt; không nhận key thật có giá trị production và không mở LAN trước khi có thiết kế TLS/auth phù hợp.
- Remote Write có thể có partial writes hoặc kết quả không chắc chắn; không có transaction/exactly-once.
- Token bucket không phân tán; không tăng workers mà không đổi admission control.
- Windows `.venv` không tái sử dụng được trong image Linux; uv phải resolve/install tương thích runtime được pin, không copy môi trường local.
- Byte limits chưa đủ để suy ra memory; phải nghiệm thu concurrency và container constraints.
- Bổ sung validate key sau này sẽ thay nguồn định danh trong `identity.py`/pipeline: credential hợp lệ quyết định IDs, không tiếp tục tin header làm nguồn quyền đại diện. Thay đổi đó cần thiết kế và tests riêng.

Tài liệu này đã được người dùng duyệt ngày 2026-10-31. Bước tiếp theo là dùng writing-plans để lập task order, dependencies, lệnh kiểm tra và tiêu chí nghiệm thu chi tiết, rồi gửi người dùng duyệt kế hoạch và chọn cách thực hiện. Không suy diễn duyệt tài liệu thành cho phép code/build/deploy hoặc Git operations.

## 15. Tài liệu đối chiếu

- [Định hướng dự án](<../../../INTRODUCT.md>).
- [Thiết kế Bước 1](<2026-10-30-central-infrastructure-design.md>).
- [Runbook Bước 1](<../../deployment/central-infrastructure.md>).
- [Nghiệm thu Bước 1](<../../deployment/2026-10-30-central-infrastructure-acceptance.md>).
- [Prometheus Remote Write 1.0](https://prometheus.io/docs/specs/prw/remote_write_spec/): schema, Snappy block, headers, timestamp milliseconds, retries và giới hạn partial writes.
- [Nguồn chuẩn giao thức](https://github.com/prometheus/docs/blob/main/docs/specs/prw/remote_write_spec.md), đã đọc qua GitHub API.
- [Telegraf HTTP output](https://github.com/influxdata/telegraf/blob/master/plugins/outputs/http/README.md), đã đọc qua GitHub API.
- [Telegraf Remote Write serializer](https://github.com/influxdata/telegraf/blob/master/plugins/serializers/prometheusremotewrite/prometheusremotewrite.go), đã đọc qua GitHub API: dùng snappy.Encode và timestamps milliseconds.
- [Cramjam Snappy source](https://github.com/milesgranger/cramjam/blob/HEAD/src/snappy.rs), đã đọc qua GitHub API: raw_len/raw_into và raw API khác framed API. Upstream HEAD chỉ là nguồn khảo sát; implementation phải pin và kiểm thử đúng version thư viện được lock.
