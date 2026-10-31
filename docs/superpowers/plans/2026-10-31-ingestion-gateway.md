# Bước 2 — FastAPI Ingestion Gateway: implementation plan

> **Dành cho Agent thực hiện:** dùng `subagent-driven-development` (khuyến nghị) hoặc `executing-plans` để thực hiện từng task; theo dõi các bước bằng checkbox. Đọc cả kế hoạch và thiết kế trước khi làm.

**Mục tiêu:** tiếp nhận Remote Write scalar samples trong lab local, kiểm tra/chuẩn hóa định danh tự khai báo rồi forward một lần đến Prometheus hiện có, có bằng chứng kiểm thử đến Grafana.

**Kiến trúc:** mở rộng project FastAPI `services/ingestion-gateway`, giữ layout `app/`; tách header/codec/validation/admission/forwarder/observability. Một worker, hai slot ingestion, HTTPX client dùng lại trong lifespan; Compose thêm service `ingest` trên network `monitoring`, không thêm queue, DB hoặc proxy.

**Stack:** Python 3.12, FastAPI, uv, HTTPX, protobuf, cramjam, pydantic-settings, prometheus-client; pytest/pytest-asyncio và grpcio-tools ở nhóm dev.

**Thiết kế:** [2026-10-31-ingestion-gateway-design.md](<../specs/2026-10-31-ingestion-gateway-design.md>), đã được người dùng duyệt ngày 2026-10-31.

**Trạng thái:** kế hoạch chờ duyệt; các lệnh bên dưới là chỉ dẫn cho giai đoạn thực hiện, không phải bằng chứng đã chạy. Chưa được phép implement/install/build/deploy chỉ vì tài liệu này tồn tại.

## Global constraints

- Endpoint `POST /api/v1/ingest/remote-write`; token Bearer chỉ kiểm tra hình thức/không rỗng. `X-Server-ID`/`X-Agent-ID` tự khai báo, chưa xác minh quyền đại diện; không tạo CredentialProvider hoặc fake validator.
- Chỉ HTTP lab local; publish `127.0.0.1:${INGEST_HOST_PORT:-8000}:8000`. Không mở LAN, không key production, không Nginx, TLS, HA/multi-worker, Agent Installer hoặc kiểm thử VM thật.
- Chỉ Remote Write 1.0 scalar subset, version header `0.1.0`, Snappy raw/block; reject framed, unknown fields recursive, metadata/exemplars/native histograms và WriteRequest rỗng. Không silent-drop extensions.
- Thiếu identity labels thì inject; conflict/duplicate labels/canonical series thì reject toàn request trước forward. Không overwrite IDs, sửa timestamp hoặc ép float thành finite.
- Mỗi request đã qua validation chỉ thử upstream một lần. Upstream 2xx mới trả 204; không retry/background delivery, durable queue, rollback TSDB hoặc exactly-once.
- Defaults bắt buộc: compressed `1048576`, decompressed `8388608`, series `5000`, samples `20000`, labels/series sau inject `64`, inflight `2`, rate/s `10`, burst `20`, age seconds `3600`, future skew `120`, body deadline seconds `5`.
- Timeouts seconds: connect `2`, read `10`, write `10`, pool `1`, upstream total `12`, readiness total `1`. Số đếm/thời gian dương và hữu hạn; chỉ future skew được bằng `0`.
- IDs: 1–128 ASCII bytes, `[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}`; token tối đa 4096 bytes; User-Agent không rỗng, tối đa 256 bytes. Metric name tối đa 256 UTF-8 bytes; label name 128; label value không rỗng, tối đa 1024.
- Giữ project Compose `infrapulse`, các services/volumes Bước 1, cờ receiver và datasource hiện hữu. Không `down -v`, reset DB, admin-delete TSDB hoặc mở host ports Prometheus/PostgreSQL.
- Chỉ chỉnh file trong phạm vi kế hoạch; không ghi dưới `infra/`, không sửa Gateway Go tham khảo hoặc dữ liệu workspace không liên quan. Không sửa `.env` local trong giai đoạn lập kế hoạch.
- Không `git add`, `git commit` hoặc push khi chưa được người dùng duyệt thay đổi và cho phép rõ ràng. Bước cuối mỗi task là checkpoint review, không tự commit.
- Khi thực hiện: dùng skill TDD, verification-before-completion, codebase-memory cho structural exploration; dùng browser-use khi kiểm tra Grafana. Nếu implementation gặp sai khác cần đổi contract, dừng để thống nhất thay vì tự mở rộng scope.

## Review Focus

1. Env `NaN`/`Infinity`, số âm/0 hoặc upstream URL chứa userinfo/fragment phải fail startup, không biến limits thành vô hạn — Task 1 `test_settings_reject_nonfinite_and_unsafe_urls`.
2. Duplicate/mixed-case protocol headers, encoding chains, Content-Length sai/mâu thuẫn và body chunks vượt declared length phải bị từ chối an toàn trước upstream; không chỉ tin header hoặc header map đã gộp — Tasks 1/5 `test_duplicate_protocol_headers`, `test_stream_length_is_not_trusted`.
3. Client ngắt kết nối/hủy task trong lúc codec thread đang chạy không được trả slot sớm; request thứ ba vẫn phải nhận 429 đến khi thread thực sự kết thúc — Task 5 `test_cancel_during_codec_keeps_slot`.
4. Dữ liệu nhạy cảm trong query string/unknown path, upstream exception/status body hoặc incoming request ID không được lọt qua Uvicorn/HTTPX/error logging — Task 6 `test_untrusted_paths_and_errors_are_redacted`.
5. Hết hai slot/pool upstream, hoặc chỉ thu thập test khi Docker chưa chạy, không được làm health/metrics treo hoặc tự gửi traffic E2E — Tasks 5/8 `test_health_bypasses_saturated_ingestion`, `test_e2e_is_opt_in`.

## File map và quy ước thực hiện

| Task | File chịu trách nhiệm |
|---|---|
| 1 | Chỉnh [pyproject.toml](<../../../services/ingestion-gateway/pyproject.toml>), [uv.lock](<../../../services/ingestion-gateway/uv.lock>), [.gitignore](<../../../.gitignore>); tạo `app/config.py`, `app/identity.py`, `app/errors.py`, `tests/conftest.py`, `tests/unit/test_config.py`, `tests/unit/test_identity.py` dưới `services/ingestion-gateway/` |
| 2 | Tạo `services/ingestion-gateway/app/proto/{__init__.py,remote_write.proto,remote_write_pb2.py}`, `app/codec.py`, `tests/unit/test_codec.py`, `tests/fixtures/remote_write_scalar.hex`; bổ sung fixtures vào `tests/conftest.py` |
| 3 | Tạo `services/ingestion-gateway/app/validation.py`, `tests/unit/test_validation.py` |
| 4 | Tạo `services/ingestion-gateway/app/forwarder.py`, `tests/unit/test_forwarder.py` |
| 5 | Chỉnh [main.py](<../../../services/ingestion-gateway/app/main.py>), [app/__init__.py](<../../../services/ingestion-gateway/app/__init__.py>); tạo `app/pipeline.py`, `app/routes/{__init__.py,ingest.py,health.py}`, `tests/unit/test_admission.py`, `tests/integration/{test_ingestion.py,test_health.py}`; bổ sung app fixtures |
| 6 | Tạo `services/ingestion-gateway/app/observability.py`, `tests/integration/test_observability.py`; nối hooks vào main/pipeline/forwarder |
| 7 | Tạo `services/ingestion-gateway/{Dockerfile,.dockerignore}`, `tests/integration/test_deployment_config.py`; chỉnh [compose.yaml](<../../../deploy/compose/compose.yaml>), [.env.example](<../../../.env.example>), [prometheus.yml](<../../../observability/prometheus/prometheus.yml>) |
| 8 | Tạo `services/ingestion-gateway/tests/e2e/test_remote_write.py`, `tests/unit/test_e2e_contract.py`, `docs/deployment/ingestion-gateway.md`, `docs/deployment/ingestion-gateway-acceptance.md`; chỉnh [README.md](<../../../README.md>), [runbook Bước 1](<../../deployment/central-infrastructure.md>) |

Paths viết gọn trong một hàng của bảng trên đều nằm trong project Gateway ở đầu hàng. `app/errors.py` là chi tiết tổ chức bổ sung: chứa lỗi có kiểu dùng chung, tránh codec/forwarder phải import HTTP routes hoặc tạo vòng import; không thêm service/behavior mới. Fixtures/test helpers chỉ nằm trong tests; không thêm module runtime chỉ phục vụ mock.

- Root lệnh: `C:\MF\VSCODE\InfraPulse`; lệnh `uv`/pytest/codegen ghi dưới đây chạy tại `C:\MF\VSCODE\InfraPulse\services\ingestion-gateway`, trừ khi ghi rõ root. PowerShell: dùng tham số workdir của tool, không dựa vào trạng thái `cd` của call trước.
- Snapshot ban đầu: thiết kế mới và `services/` untracked; [main.py](<../../../services/ingestion-gateway/app/main.py>) và [app/__init__.py](<../../../services/ingestion-gateway/app/__init__.py>) rỗng. Đọc lại trước edit, giữ phần người dùng có thể đã cập nhật. Graph generation khảo sát `2026-10-30T13:49:57Z` chưa track Gateway; refresh/check coverage và dùng source fallback, không kết luận từ graph rỗng.
- Dependency pins đã đối chiếu metadata chính thức ngày 2026-10-31: `fastapi[standard]==0.162.0` và `uvicorn==0.54.0` giữ phiên bản đang lock; thêm `httpx==0.28.1`, `protobuf==7.36.2`, `cramjam==2.14.0`, `pydantic-settings==2.16.2`, `prometheus-client==0.26.0`, `anyio==4.15.1`. Dev: `pytest==9.2.0`, `pytest-asyncio==1.4.1`, `grpcio-tools==1.85.1`, `pyyaml==6.0.3` (chỉ đọc config ở test). Pin uv `0.13.6`; không nâng FastAPI theo tiện tay.
- `grpcio-tools==1.85.1` yêu cầu `protobuf>=7.35.1,<8.0.0`, tương thích runtime chọn trên; cramjam/grpcio-tools có CPython 3.12 wheels cho Windows amd64 và Linux x86_64. Tạo lock bằng uv, không sửa tay; nếu resolver/khả năng install mâu thuẫn, báo lỗi và chọn lại có lý do, không bỏ frozen hoặc bỏ test.
- Đặt pytest `asyncio_mode="auto"`, `testpaths=["tests/unit", "tests/integration"]`, marker `e2e` được khai báo; E2E chỉ chạy khi opt-in. Dùng lifespan fixture async context manager của app + `httpx.ASGITransport`; ASGITransport tự nó không chạy lifespan.
- Fixtures Task 1: `headers` là list tuples bytes đúng protocol, token giả không bí mật và IDs `srv-lab`/`agent-lab`; `settings` trả `Settings()` sau khi fixture autouse tạm clear các `INGEST_` env của process test (fixture này bỏ qua cases marker `e2e`); `identity` trả `Identity("srv-lab", "agent-lab")`; `received_at_ms=1800000000000`. Không clear env khi chạy app/E2E thật.
- Helpers Task 2 trong conftest: fixture `make_write` trả callable `(labels: list[tuple[str, str]] | None = None, samples: list[tuple[float, int]] | None = None) -> WriteRequest`, mặc định một series `__name__=infrapulse_unit_value`, sample `(1.0, received_at_ms)`; `pack_write(message: WriteRequest) -> bytes` là callable fixture dùng serialize + cramjam raw. Không dùng production decoder làm oracle cho mọi fixture.
- Fixture Task 5 `app_client` trả async-context-manager factory `(settings: Settings | None = None, upstream_transport: httpx.AsyncBaseTransport | None = None, ready_transport: httpx.AsyncBaseTransport | None = None)` yield `(app: FastAPI, client: httpx.AsyncClient)` sau khi enter app lifespan; monkeypatch `app.routes.ingest.utc_now_ms` trả `received_at_ms` cho integration fixtures (không patch app/E2E thật); teardown đóng client/lifespan. Forwarder tests tự dựng `calls: list[httpx.Request]` và async transport closure trong từng test, không dùng biến global.

---

### Task 1 — Settings và header identity có kiểm thử

**Files:** các file Task 1 trong bảng trên. Phần hiện hữu cần chỉnh: [pyproject.toml:1–7](<../../../services/ingestion-gateway/pyproject.toml#L1-L7>), [uv.lock](<../../../services/ingestion-gateway/uv.lock>), [.gitignore](<../../../.gitignore>).

**Interfaces**
- `config.Settings(BaseSettings)`: `env_prefix="INGEST_"`; thuộc tính snake_case tương ứng toàn bộ env/defaults ở thiết kế mục 6–7/10; thêm `prometheus_write_url`, `prometheus_ready_url`, `ready_timeout_seconds=1`, `log_level="INFO"`. Không tự đọc root env trong app; Compose inject có chọn lọc, local dev truyền env rõ ràng.
- `errors.GatewayError(Exception)` với constructor `GatewayError(status_code: int, code: str, *, retry_after: int | None = None)`. Code chỉ từ enum hằng `ERROR_CODES`; thông báo công khai lấy từ map cố định `ERROR_MESSAGES`, không nhận arbitrary exception message.
- Error codes hữu hạn: `invalid_authorization`, `invalid_identity`, `unsupported_media`, `invalid_protocol_header`, `invalid_content_length`, `empty_body`, `invalid_snappy`, `invalid_protobuf`, `unsupported_fields`, `empty_write`, `empty_series`, `invalid_labels`, `identity_conflict`, `duplicate_series`, `invalid_timestamp`, `payload_too_large`, `too_many_series`, `too_many_samples`, `body_timeout`, `rate_limited`, `concurrency_limited`, `upstream_rejected`, `upstream_too_large`, `upstream_rate_limited`, `upstream_unavailable`, `upstream_timeout`, `upstream_bad_status`, `internal_error`. `invalid_content_length`/`invalid_protocol_header` là 400; labels overflow là 400, không 413.
- `identity.Identity` là frozen dataclass `(server_id: str, agent_id: str)`; không giữ token.
- `identity.parse_ingest_headers(raw_headers: list[tuple[bytes, bytes]]) -> Identity`: dùng raw ASGI headers để phát hiện duplicate case-insensitive; không dùng dict đã mất duplicate.

- [ ] **1. Viết tests đỏ:** khởi tạo pytest config, conftest tối thiểu và các tests sau, chưa viết production modules.

```python
# test_identity.py — headers fixture được dựng tại test, chưa import codec.
def test_nonempty_arbitrary_token_is_not_authenticated(headers):
    identity = parse_ingest_headers(headers)
    assert (identity.server_id, identity.agent_id) == ("srv-lab", "agent-lab")
    assert not hasattr(identity, "token")

# test_config.py
@pytest.mark.parametrize("name,value", [
    ("rate_per_second", "NaN"), ("read_timeout_seconds", "Infinity"),
    ("max_inflight", 0), ("max_samples", -1),
    ("prometheus_write_url", "http://user:pass@prometheus:9090/api/v1/write"),
    ("prometheus_ready_url", "http://prometheus:9090/-/ready#fragment"),
])
def test_settings_reject_nonfinite_and_unsafe_urls(name, value):
    with pytest.raises(ValueError):
        Settings(**{name: value})
```

Bổ sung parametrized cases có assertions: `test_default_limits` đối chiếu **tất cả** defaults ở Global constraints; `test_id_boundaries` nhận 1/128 ASCII bytes, reject 0/129/Unicode/space; `test_authorization_contract` nhận arbitrary nonempty token, reject thiếu/empty/malformed/duplicate/>4096, `status_code==401`; `test_duplicate_protocol_headers` thêm duplicate mixed-case cho từng required header, `code in ERROR_CODES` và không được accept; `test_media_contract` nhận đúng content-type và `proto=prometheus.WriteRequest`, reject schema v2/unknown parameters/encoding chain/gzip/wrong version bằng 415; `test_user_agent_bounds` reject thiếu/rỗng/257 bytes bằng 400. Whitespace OWS quanh giá trị được strip; Bearer scheme không phân biệt hoa/thường, token là một chuỗi không whitespace/control, token bytes giới hạn sau parse. Required media/version/UA mỗi loại một header; duplicate media/version trả 415, duplicate/missing UA trả 400. Duplicate Authorization là 401; duplicate ID là 400.

- [ ] **2. Bootstrap dependency/test runner:** chỉnh pins/groups/pytest config, `uv lock`, `uv sync --frozen --group dev --python 3.12`; run `uv run --frozen pytest tests/unit/test_config.py tests/unit/test_identity.py -q`. Mong đợi RED do `app.config`/`app.identity` chưa có; lỗi resolver/interpreter không phải RED hợp lệ.
- [ ] **3. Implement interfaces:** settings fail-fast với positive finite numeric constraints, future skew `>=0`; URLs HTTP/HTTPS có host, không userinfo/fragment, không lấy từ request. Giới hạn log level theo enum chuẩn. Header regex/bytes đúng contract; không log giá trị input. Thêm `.venv/`, `__pycache__/`, `*.py[cod]`, `.pytest_cache/`, `.coverage*`, `htmlcov/` vào Git ignore nhưng không ignore lock/schema/tests.
- [ ] **4. Green:** chạy lại hai file tests, yêu cầu tất cả PASS; `uv lock --check` và `git check-ignore services/ingestion-gateway/.venv/pyvenv.cfg` từ root phải xác nhận env bị ignore. `git check-ignore --no-index services/ingestion-gateway/uv.lock` từ root phải không match (exit 1 mong đợi, không hiểu là failure công việc).
- [ ] **5. Checkpoint:** xem diff chỉ Task 1, ghi kết quả thực; chưa stage/commit. Không kết luận có auth hoặc chống spoof.

### Task 2 — Codec raw Snappy/Protobuf, bounded allocation và codegen

**Files:** file Task 2; `tests/conftest.py` thêm `make_write`/`pack_write`. Không sửa tay generated Python.

**Interfaces**
- Tiêu thụ `Settings`, `GatewayError` của Task 1.
- `codec.decode_write(compressed: bytes, settings: Settings) -> remote_write_pb2.WriteRequest`.
- `codec.encode_write(message: remote_write_pb2.WriteRequest, settings: Settings) -> bytes`.
- Schema proto3, package `prometheus`: `WriteRequest { repeated TimeSeries timeseries = 1; }`; `TimeSeries { repeated Label labels = 1; repeated Sample samples = 2; }`; `Label { string name = 1; string value = 2; }`; `Sample { double value = 1; int64 timestamp = 2; }`. Không thêm field hỗ trợ extensions chỉ để làm test pass.

- [ ] **1. Viết tests đỏ và independent wire fixture.** Fixture hex một WriteRequest chứa `up=1.0` tại timestamp `1000`: `0a1e0a0e0a085f5f6e616d655f5f12027570120c09000000000000f03f10e807`. Đối chiếu field tags/length/IEEE754 thủ công theo schema chuẩn, không xuất fixture bằng chính generated encoder. Test `test_independent_wire_fixture` assert metric `up`, value `1.0`, timestamp `1000` sau raw-compress/decode.

`test_float_bits_round_trip` được parametrized bằng `0x0000000000000000`, `0x8000000000000000`, `0x7ff0000000000000`, `0xfff0000000000000`, `0x7ff8000000000001`, `0x7ff0000000000002` (Prometheus stale marker). Dựng fixed64 Sample.value từ `struct.pack('<Q', bits)` độc lập với float equality; sau decode→encode→decode, lấy sample đầu tiên:

```python
assert struct.pack('<d', round_tripped.timeseries[0].samples[0].value) == struct.pack('<Q', bits)
```

Không dùng `NaN == NaN` hoặc float arithmetic làm oracle. Proto3 được phép bỏ field +0 mặc định khi serialize; test so sample bits sau decode, không đòi mọi output đều bắt đầu bằng wire tag0x09. Các tests khác: `test_raw_not_framed`, `test_truncated_corrupt_and_empty` assert 400; `test_recursive_unknown_fields` chèn unknown field ở WriteRequest/TimeSeries/Label/Sample, assert `unsupported_fields`; `test_declared_output_too_large_before_allocation` monkeypatch `decompress_raw_len` trả `8388609`, spy `decompress_raw_into` không được gọi, assert 413; `test_output_limits` set limits nhỏ, assert serialize vượt cap hoặc compressed output vượt cap đều 413. Với invalid Protobuf vẫn raw Snappy hợp lệ thì `invalid_protobuf`, không `invalid_snappy`.

- [ ] **2. Generate rồi xác nhận RED:** `uv run --frozen python -m grpc_tools.protoc -I app/proto --python_out=app/proto app/proto/remote_write.proto`; run `uv run --frozen pytest tests/unit/test_codec.py -q`, RED do codec chưa có/behavior thiếu, không do schema generate hỏng.
- [ ] **3. Implement codec:** kiểm tra input compressed cap/rỗng; gọi `cramjam.snappy.decompress_raw_len`, cap trước `bytearray`; giải nén bằng `decompress_raw_into`, xác nhận số bytes đúng declared length. Parse Protobuf, copy + `DiscardUnknownFields()` recursive rồi so `ByteSize` để reject, không tiếp tục với bản đã mất fields. Reject empty WriteRequest/empty raw bằng safe errors. Encode kiểm tra `ByteSize` trước serialize và length sau serialize/compress; không dùng framed API hoặc `decompress_raw(output_len=...)` làm boundary.
- [ ] **4. Green và reproducibility:** `uv run --frozen pytest tests/unit/test_codec.py -q` PASS; lấy SHA256 generated file, chạy lại đúng lệnh protoc và so SHA256 không đổi. Record grpcio-tools/protobuf pins; không cần stage để kiểm tra codegen. Runtime import generated code phải chạy dưới protobuf lock đã chọn.
- [ ] **5. Checkpoint:** review codec không import FastAPI/HTTPX, thêm nguồn fixture và lệnh codegen vào ghi chú bàn giao Task 8; chưa commit.

### Task 3 — Whole-batch validation và normalization giữ nguyên sample bits

**Files:** `services/ingestion-gateway/app/validation.py`, `services/ingestion-gateway/tests/unit/test_validation.py`.

**Interfaces**
- Tiêu thụ `Identity`, `Settings`, `GatewayError`, `remote_write_pb2.WriteRequest` và fixtures Task 2.
- `validation.NormalizedBatch` frozen dataclass `(message: WriteRequest, series_count: int, sample_count: int)`.
- `validation.validate_and_normalize(message: WriteRequest, identity: Identity, settings: Settings, *, received_at_ms: int) -> NormalizedBatch`. Input không bị mutate; output copy giữ sample fields bằng Protobuf copy, không tái tính float/timestamp.

- [ ] **1. Viết tests đỏ.** `test_inject_missing_and_keep_matching_ids`: assert hai ID đúng, labels sorted, input thiếu IDs vẫn không bị mutate. `test_conflict_rejects_whole_batch`: batch hai series, series thứ hai conflict, assert error `identity_conflict` và không có partial output. `test_labels_after_injection`: 62 labels trước inject được 64; 63 trước inject bị 400. `test_duplicate_canonical_series`: một series thiếu IDs/một có matching IDs trở thành cùng bộ nhãn, assert 400 `duplicate_series`.

```python
@pytest.mark.parametrize("delta,accepted", [(-3600000, True),
    (120000, True), (-3600001, False), (120001, False)])
def test_timestamp_window_boundaries(delta, accepted, make_write, identity, settings):
    now = 1800000000000
    message = make_write(samples=[(1.0, now + delta)])
    if accepted:
        out = validate_and_normalize(message, identity, settings, received_at_ms=now)
        assert out.message.timeseries[0].samples[0].timestamp == now + delta
    else:
        with pytest.raises(GatewayError) as exc:
            validate_and_normalize(message, identity, settings, received_at_ms=now)
        assert exc.value.code == "invalid_timestamp"
```

Thêm parametrized `test_label_and_metric_contract`: đúng một `__name__`, metric/name regex, empty values, duplicate names, UTF-8 byte limits khác character count; assert 400. `test_strict_timestamp_order` reject equal/decreasing nhưng không giữ history qua calls. `test_resource_counts`: 5000 series/20000 samples đúng biên được nhận, +1 trả 413; dùng labels riêng để không bị duplicate-series mask lỗi. `test_empty_series` 400. `test_sample_bits_unchanged` assert các fixed64 bits Task 2 và timestamp không đổi sau normalize. Unknown fields vẫn do codec reject trước validation.

- [ ] **2. RED:** `uv run --frozen pytest tests/unit/test_validation.py -q`; xác nhận lỗi implementation thiếu.
- [ ] **3. Implement signature:** kiểm tra toàn batch trước trả kết quả; metric name regex `[a-zA-Z_:][a-zA-Z0-9_:]*`, label name regex `[a-zA-Z_][a-zA-Z0-9_]*`; canonical key là tuple labels sorted sau inject, không merge/dedup. Một `received_at_ms` cho cả request, cửa sổ đóng; counts cả batch. Không dùng `host` thay header, không filter nonfinite floats, không cache series ordering.
- [ ] **4. Green:** `uv run --frozen pytest tests/unit/test_codec.py tests/unit/test_validation.py -q` PASS, bao gồm boundary và bit assertions.
- [ ] **5. Checkpoint:** review không có IO/async/forward trong validation, không thay thông số thiết kế; chưa commit.

### Task 4 — Forward một lần, streaming response và status mapping

**Files:** `services/ingestion-gateway/app/forwarder.py`, `services/ingestion-gateway/tests/unit/test_forwarder.py`.

**Interfaces**
- Tiêu thụ `Settings`, lỗi codes Task 1; nhận compressed bytes Task 2, không nhận client headers/Identity.
- `forwarder.ForwardResult` frozen dataclass `(status_code: int, result: str, upstream_status: int | None = None, error_code: str | None = None, retry_after: int | None = None)`.
- `FORWARD_RESULTS = {"accepted", "rejected", "too_large", "rate_limited", "unavailable", "timeout", "bad_status"}` hữu hạn.
- `forwarder.Forwarder(client: httpx.AsyncClient, settings: Settings)`; `async forward(payload: bytes) -> ForwardResult`. Client được truyền từ lifespan, không tự tạo/đóng trong forwarder. Không raise raw HTTPX exception ra route.

- [ ] **1. Viết tests đỏ với MockTransport.** `test_headers_bytes_and_one_attempt`: capture request, assert body bytes đúng input; chỉ upstream protocol headers do Gateway đặt (`User-Agent: infrapulse-ingestion-gateway/0.1.0`), không Authorization/X-Server-ID/X-Agent-ID/incoming request ID. HTTPX Host/Content-Length tự sinh được phép. `test_status_mapping` parametrized: 200/202/204→204; 400→400; 413→413; 429→429; 500/503→503; 301/307/401/403/404→502. Mỗi case assert `len(calls)==1`, code/result đúng enum, không theo redirect.

```python
@pytest.mark.parametrize("value,expected", [("1", 1), ("60", 60),
    ("0", 1), ("61", 1), ("-1", 1), ("garbage", 1),
    ("Wed, 21 Oct 2026 07:28:00 GMT", 1)])
async def test_retry_after_is_bounded(value, expected, settings):
    calls = []
    async def upstream(request):
        calls.append(request)
        return httpx.Response(429, headers={"Retry-After": value})
    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream),
                                trust_env=False, follow_redirects=False) as client:
        result = await Forwarder(client, settings).forward(b"test-raw-snappy")
    assert result.status_code == 429
    assert result.retry_after == expected
    assert len(calls) == 1
```

Các test cases dùng client/transport closure riêng như ví dụ trên, không biến global dùng chung. Thêm `test_timeout_and_network_mapping`: Connect/Read/Write/PoolTimeout→504, NetworkError→503; `test_total_deadline`: transport bị block bằng Event, settings deadline nhỏ, response 504 trong deadline hữu hạn, không sleep dài; `test_upstream_body_not_read`: custom `httpx.AsyncByteStream` raise nếu iterate, 2xx/4xx/5xx đều chỉ đọc status, `aclose` được gọi. Không nhận body bí mật để tạo message lỗi.

- [ ] **2. RED:** `uv run --frozen pytest tests/unit/test_forwarder.py -q` lỗi forwarder chưa có.
- [ ] **3. Implement:** `asyncio.timeout(settings.upstream_deadline_seconds)` bao toàn attempt; HTTPX granular timeouts đúng defaults; `client.stream('POST', ...)` và close response mọi nhánh, không `response.aread()`/`.text`. 2xx không trả body upstream. Retry-After chỉ digit seconds 1–60, còn lại 1; không parse HTTP date hoặc echo input. Redirect disabled ở client và không gọi lại ở forwarder.
- [ ] **4. Green:** chạy test file PASS; assert một attempt cả khi timeout/network, không retry/backoff nội bộ. Không coi mock bypass DNS là kiểm tra DNS runtime.
- [ ] **5. Checkpoint:** review safe error classifications không chứa URL/response/exception text; chưa commit.

### Task 5 — Admission, streaming pipeline, HTTP app và health lifecycle

**Files:** Task 5 trong file map; `tests/conftest.py` thêm `app_client` fixture chạy lifespan và MockTransport, không gọi Docker/network thật.

**Interfaces**
- Tiêu thụ interfaces Tasks 1–4.
- `pipeline.AdmissionController(settings: Settings, *, monotonic: Callable[[], float])`; đồng bộ `acquire() -> AdmissionLease` hoặc raise GatewayError 429; `AdmissionLease.release() -> None` idempotent. Đọc/ghi limiter chỉ trên app event loop, không await giữa kiểm tra và cập nhật; không queue. Slot đầy không consume token; lúc cả hai đủ mới consume một token và slot.
- `pipeline.PipelineResult` frozen dataclass `(forward: ForwardResult, series_count: int, sample_count: int)`.
- `pipeline.IngestionPipeline(settings: Settings, admission: AdmissionController, forwarder: Forwarder)`; `async handle(stream: AsyncIterator[bytes], identity: Identity, *, received_at_ms: int) -> PipelineResult`.
- `main.create_app(settings: Settings | None = None, *, upstream_transport: httpx.AsyncBaseTransport | None = None, ready_transport: httpx.AsyncBaseTransport | None = None) -> FastAPI`; module export `app = create_app()`, IO chỉ trong lifespan, import không mở connection/background delivery.
- `routes/ingest.py`: `router = APIRouter()`, `utc_now_ms() -> int` đọc wall clock milliseconds, async handler `ingest_remote_write(request: Request) -> Response` gọi clock đúng một lần cho endpoint đã chốt. `routes/health.py`: router + `async live() -> Response`, `async ready(request: Request) -> Response`.
- App state `pipeline`, `ready_client`, `settings`, `initialized`; lifespan tạo forward HTTPX client và readiness HTTPX client riêng, đóng cả hai. Readiness pool riêng tránh hết pool ingestion làm health chờ 10 giây. `trust_env=False`, `follow_redirects=False`; forward pool max connections/max keepalive bằng `max_inflight`, ready pool 2.

- [ ] **1. Viết admission tests đỏ:** `test_token_bucket_refill` fake monotonic ban đầu 0, acquire/release 20 lần được, lần 21 bị 429/retry1; clock +0.1 giây thì một request được. `test_max_inflight` giữ hai lease, thứ ba 429, release rồi nhận; `test_release_idempotent` không làm counter âm. Bucket reset chỉ khi tạo controller, không per request.
- [ ] **2. Viết integration tests đỏ:** `test_valid_request_returns_204_after_upstream`: request hợp lệ inject IDs, upstream Event chưa release thì request chưa done, sau 2xx trả 204 body rỗng; decode captured upstream để assert normalized labels. `test_invalid_batch_never_forwarded`: conflict ở series thứ hai, assert zero upstream calls. Parametrize 401/missing headers/415/400/413/429 và mapping Task 4; 401 có `WWW-Authenticate: Bearer`, mọi lỗi JSON có `code`, safe `message`, Gateway `request_id`.

`test_stream_length_is_not_trusted`: dùng ASGI scope/receive trực tiếp để kiểm soát duplicate Content-Length, signed/non-numeric/negative values, declared vượt cap, không có header hoặc body chunks vượt cap; malformed/duplicate Content-Length trả 400, cap vượt trả 413 và upstream không được gọi. Nếu actual length khác declared, reject 400 sau giới hạn cap; transport test phải bypass HTTPX auto-correct header. `test_body_total_timeout`: receive block bằng Event, settings body deadline nhỏ, assert 408 `body_timeout`, slot được trả.

`test_cancel_during_codec_keeps_slot`: monkeypatch worker function bị block bằng threading.Event; hai requests chiếm slots, hủy một task sau khi thread đã start; request thứ ba vẫn 429. Chỉ sau khi unblock/join worker mới acquire lại; assert inflight trở 0. `test_release_on_all_failures`: decode/validation/forward error, client disconnect và cancellation đều không leak slot; không tạo retry/background send.

`test_health_bypasses_saturated_ingestion`: block hai forwards; live 200, metrics ở Task 6 vẫn phục vụ, ready upstream 200 thì ready200 qua pool riêng. `test_health_mapping_and_deadline`: upstream ready200→200, 500/redirect/network/timeout→503 trong deadline1, live luôn200; timeout dùng override nhỏ và Event, không sleep1 giây lặp lại. `test_lifespan_closes_clients`: mọi clients close ở shutdown, startup sai config fail, import không tạo IO.

- [ ] **3. RED:** `uv run --frozen pytest tests/unit/test_admission.py tests/integration/test_ingestion.py tests/integration/test_health.py -q`, lỗi do interfaces/lifecycle chưa implement.
- [ ] **4. Implement admission/pipeline/routes/lifespan:** route tạo thời điểm nhận một lần trước đọc body; parse headers rồi acquire. Route kiểm tra raw Content-Length không duplicate/malformed, bọc stream để đối chiếu actual length khi EOF; pipeline vẫn đếm chunks/cap độc lập để không tin header. Timeout tổng read5; không gọi `request.body()` trước cap. Gộp decode→validate→encode thành một sync worker chạy `anyio.to_thread.run_sync(..., abandon_on_cancel=False, limiter=codec_limiter)` với `codec_limiter=CapacityLimiter(max_inflight)` tạo một lần cho pipeline; cancellation shield chờ worker kết thúc trước release slot, không abandon thread. Slot giữ từ trước body đến forward kết thúc, finally release; không dùng executor queue không giới hạn. Serialize recheck size sau inject trước forward.

Error handler GatewayError dùng map cố định, status/retry headers đúng; catch unexpected `Exception` ở ingestion boundary để trả 500 `internal_error` đã sanitize, không re-raise qua Starlette ServerErrorMiddleware làm Uvicorn dump raw exception/request. Không bắt/nuốt `CancelledError` thành success. Nếu `settings=None`, resolve Settings trong lifespan; ValidationError startup được đổi thành RuntimeError thông điệp cố định với `from None`, không log repr/input có URL credentials. Test startup phải assert không leak sentinel ở stderr. Ready gọi configured ready URL một lần bằng streaming client với total timeout1, close response, status đúng200 mới ready200; không dùng DB và không restart khi upstream outage. `/health/live` không IO. Chưa thêm metrics giả để làm health test pass; metrics assertion chạy sau Task 6.

- [ ] **5. Green:** chạy lại ba test files PASS và `uv run --frozen pytest tests/unit tests/integration -q` PASS; test client không phụ thuộc Prometheus/ports local thật.
- [ ] **6. Checkpoint:** review cancellation/shield với thread Event đã join, không còn pending task; chỉ một worker được hỗ trợ; chưa commit.

### Task 6 — Metrics registry và JSON logs không rò dữ liệu

**Files:** Task 6 trong bảng; chỉ sửa main/pipeline/forwarder để nối hooks, không đổi public signatures Tasks 1–5. Gắn `observability` qua app state và optional attribute `observer` trên pipeline/forwarder sau khi tạo; mặc định `None` để unit tests thuần không cần registry.

**Interfaces**
- `observability.Observability(registry: CollectorRegistry | None = None)` sở hữu registry riêng mỗi instance, counters/histograms/gauge theo thiết kế mục 9.
- Module function `new_request_id() -> str` tạo UUID nội bộ. Methods trên observer: `record_request(*, status: int, duration_seconds: float, reason: str | None) -> None`, `record_forward(*, result: str, duration_seconds: float) -> None`, `inflight(delta: int) -> None`.
- `configure_logging(level: str) -> None` tạo JSON stdout format có allowlist fields, không add handler trùng mỗi create_app; `log_event(event: str, *, request_id: str | None = None, route: str, status: int | None = None, duration_ms: float | None = None, series_count: int | None = None, sample_count: int | None = None, upstream_status: int | None = None, error_code: str | None = None) -> None`. Fields timestamp/level tự formatter tạo.
- `install_observability(app: FastAPI, observer: Observability) -> None` đăng ký `/metrics`, instrument đúng POST ingestion. Route logs là route template hằng hoặc `unmatched`, không raw URL/query; incoming request ID bị bỏ qua.

- [ ] **1. Viết tests đỏ:** `test_metrics_have_finite_labels`: 204 tăng requests `status="204"`, latency `status_class="2xx"`; reject tăng enum reason nhưng zero forward; timeout/network/success tăng forward đúng một lần/result; inflight 0 sau kết thúc. Parse exposition bằng prometheus_client parser, assert label names/values đúng allowlist, không chỉ tìm substring.

`test_metrics_do_not_count_scrapes`: GET metrics/health 3 lần không tăng ingestion counter; `test_registry_per_app` tạo hai apps không duplicate registration hoặc dùng chung state. `test_observability_when_limited`: hai requests block, metrics vẫn200, gauge2; kết thúc/hủy an toàn gauge0.

`test_untrusted_paths_and_errors_are_redacted`: token, invalid ID, raw payload, upstream body/exception URL và query/path mang sentinel riêng; gửi cả 401/400/413/429/502/503/504/500/404. Assert mọi response lỗi, captured stdout/stderr và JSON records không chứa các sentinels. Request ID client `client-secret-id` không được echo/log; ID do Gateway tạo là UUID. Parse từng dòng log JSON, assert ổn định `timestamp,level,event,request_id,route,status,duration_ms` khi hoàn tất ingestion; count fields chỉ khi parse thành công, không traceback. Test startup warning có `identity_unverified`, không token.

- [ ] **2. RED:** `uv run --frozen pytest tests/integration/test_observability.py -q` lỗi observer chưa có.
- [ ] **3. Implement:** metrics prefix/types đúng thiết kế, reason dùng ERROR_CODES, result dùng FORWARD_RESULTS, không tạo label từ dữ liệu client/metric name/exception. Counter attempt tăng khi thật sự bước vào forward, không validation fail; duration đo monotonic; gauge theo admission lease thực tế cả khi cancellation. Không instrument mọi path bằng raw labels.

Đặt HTTPX/httpcore log level WARNING trở lên và không log raw exception; không dùng `logger.exception` chứa secrets cho fallback. Disable Uvicorn access log trong runtime command; lifecycle/error handler dùng JSON logger đã sanitize, expected exceptions không dump traceback. Không thể dựa vào sanitizer che regex token sau khi đã log object; chỉ log allowlist ngay từ đầu.

- [ ] **4. Green:** `uv run --frozen pytest tests/unit tests/integration -q` PASS; startup/log tests đọc stdout/stderr thực và verify JSON, không chỉ mock `log_event`.
- [ ] **5. Checkpoint:** review metric cardinality và fallback500; chưa kết luận runtime log đã an toàn nếu chỉ unit tests PASS; Task 8 còn kiểm tra container logs.

### Task 7 — Frozen runtime image và Compose integration giữ hạ tầng cũ

**Files:** Task 7 trong bảng; [compose.yaml:1–118](<../../../deploy/compose/compose.yaml#L1-L118>), [.env.example](<../../../.env.example>), [prometheus.yml](<../../../observability/prometheus/prometheus.yml>). Không chỉnh `.env` local hoặc reports Bước 1 để che failure cũ.

**Interfaces/config**
- Image base `python:3.12.16-slim-bookworm@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337`; uv source `ghcr.io/astral-sh/uv:0.13.6`, verify manifest trước build, không fallback latest. Root build context là project Gateway; không copy Windows `.venv`.
- Dockerfile có stages `build`, `test`, `runtime` (runtime cuối cùng/default). Build chạy `uv sync --frozen --no-dev --no-install-project`; runtime chỉ copy Linux env + `app/`, `PATH=/app/.venv/bin:$PATH`, `PYTHONDONTWRITEBYTECODE=1`, nonroot UID/GID10001, working dir `/app`. Runtime không cần uv/protoc/compiler/test dependencies; `CMD ["uvicorn","app.main:app","--host","0.0.0.0","--port","8000","--workers","1","--no-access-log"]`.
- Stage `test` kế thừa build, chạy `uv sync --frozen --group dev --no-install-project`, copy `app/` và `tests/`, `PYTHONPATH=/app`, entrypoint `/app/.venv/bin/python -m` và CMD pytest. Không dùng stage này cho service ingest; không cần root repo/Compose/env trong image. Linux test command bỏ riêng config-file test đã chạy tại root Windows; phần application unit/integration và E2E vẫn bắt buộc chạy Linux.
- Service `ingest`: build context `../../services/ingestion-gateway`, host loopback port8000 default, only monitoring network, depends_on prometheus service_healthy; `restart: unless-stopped`, `read_only: true`, `tmpfs: [/tmp]`, cap_drop ALL, no-new-privileges, mem_limit512m, pids_limit128, existing log rotation10m/3. Healthcheck Python urllib ready timeout2, interval10s, timeout3s, retries3, start_period10s.
- Environment map chọn lọc toàn bộ INGEST_ settings từ thiết kế, explicit defaults và `INGEST_HOST_PORT` chỉ dùng publish, không truyền PostgreSQL/Grafana credentials. Không `env_file`, source mount, DB network/volume hoặc Docker socket. Scrape thêm `ingestion-gateway` target `ingest:8000`, `/metrics`, giữ global30s/self scrape.

- [ ] **1. Viết config tests đỏ:** `tests/integration/test_deployment_config.py` dùng PyYAML dev đọc Compose/scrape/template từ repo root resolve theo `Path(__file__).resolve().parents[4]` (file tests/integration → project → services → root). Assert service ingest/settings/scrape trên; baseline service keys/volume keys/networks/receiver flag/ports vẫn giữ; `.dockerignore` loại `.venv`, `.env*`, caches/Git/tests artifacts, không loại lock/app/proto. Không cần Docker cho các tests này; container labels/security thực phải kiểm tra sau build.
- [ ] **2. RED:** `uv run --frozen pytest tests/integration/test_deployment_config.py -q` fail vì service/Dockerfile chưa có, không phải parser/fixture lỗi.
- [ ] **3. Implement Dockerfile/ignore/Compose/env/scrape** theo interfaces. Docker ignore loại secrets/caches/artifacts nhưng **không loại test source/fixtures** vì stage `test` cần COPY; runtime stage chỉ COPY app và production env, không COPY tests/dev tools. Không bake secrets hoặc bind root env. Không thay `name`, named volumes hoặc publish ports của các service cũ. Template ghi lab-only/unverified identity, không thêm token/key store. Nếu local root `.env` chưa có INGEST_ thì Compose defaults đủ để chạy, không cần tự sửa secrets file.
- [ ] **4. Green static:** chạy config tests và suite unit/integration PASS; từ root chạy `docker compose --project-directory . --env-file .env -f deploy/compose/compose.yaml config --quiet` PASS (không in config expanded có secrets).
- [ ] **5. Build và kiểm chứng runtime khi được phép:** root chạy `docker manifest inspect ghcr.io/astral-sh/uv:0.13.6` (chỉ giữ platform/version cần thiết); `docker compose --project-directory . --env-file .env -f deploy/compose/compose.yaml build ingest`; `docker compose --project-directory . --env-file .env -f deploy/compose/compose.yaml up -d --wait ingest`. Chạy unit/integration cũng trong Linux image qua one-off container của Task 8; image import protobuf/cramjam phải thành công, không bỏ native wheel failure.
- [ ] **6. Kiểm tra Docker inspect theo allowlist:** root dùng service ID từ `docker compose --project-directory . --env-file .env -f deploy/compose/compose.yaml ps -q ingest`; chỉ đọc User/ReadonlyRootfs/CapDrop/SecurityOpt/Memory/PidsLimit/Ports/Mounts/Networks/Health, không dump `.Config.Env`. Expected UID10001, read-only,512MiB,128pids, chỉ monitoring, port HostIp127.0.0.1, không DB volumes; curl/Invoke-WebRequest live/ready200. `docker compose --project-directory . --env-file .env -f deploy/compose/compose.yaml exec -T prometheus promtool check config /etc/prometheus/prometheus.yml` PASS; restart chỉ Prometheus để nạp scrape mới bằng `docker compose --project-directory . --env-file .env -f deploy/compose/compose.yaml restart prometheus`, không restart/delete storage. Nếu runtime hardening fail, ghi FAIL và sửa trước acceptance.
- [ ] **7. Checkpoint:** ghi bằng chứng thật, không claim host isolation dựa trên inspect, không commit; giới hạn Windows từ Bước 1 còn nguyên đến khi Task 8 đo thực tế.

### Task 8 — E2E đến Prometheus/Grafana, runbook và acceptance trung thực

**Files:** Task 8 trong bảng. Runtime evidence không chứa token/secret hoặc expanded env; giữ test artifacts ở đường dẫn được Git ignore, acceptance chỉ summary đã sanitize.

**Interfaces/test client**
- `tests/e2e/test_remote_write.py` dùng pytest marker `e2e`; module không IO lúc import/collection. Fixture skip trừ khi `INFRAPULSE_RUN_E2E=1`; endpoints `E2E_GATEWAY_URL=http://ingest:8000`, `E2E_PROMETHEUS_URL=http://prometheus:9090`; token giả cấp từ fixture trong memory, không CLI/URL/key thật.
- Metric `infrapulse_e2e_value`; labels server_id=`srv-e2e`, agent_id=`agent-e2e`, run_id UUID mỗi case. Samples fixed values `42.25` (missing IDs), `43.25` (matching IDs), conflict `99.0` không được ghi; mỗi case có run_id riêng, timestamps hiện tại giữ nguyên nếu sender retry.
- Test helpers trong chính E2E module: `async send_with_retry(client: httpx.AsyncClient, payload: bytes, headers: dict[str, str], *, max_attempts: int = 3, deadline_seconds: float = 20.0) -> httpx.Response` gửi vào base_url client + ingestion path; `async query_until(client: httpx.AsyncClient, promql: str, *, deadline_seconds: float = 30.0, expect_present: bool = True) -> list[dict[str, object]]` query Prometheus `/api/v1/query`. Không helper nào IO lúc import.
- Sender chỉ retry transient5xx/429 với exponential backoff0.5s nhân2 và jitter uniform0–0.25s, tối đa3 attempts/total20s; 429 dùng Retry-After đã clamp1–60, không vượt remaining deadline. Không retry 204 hoặc 4xx khác429; timeout/network được xem transient trong sender, không trong Gateway. Tests monkeypatch monotonic/sleep/jitter, assert byte/timestamp giữ nguyên. Query poll interval0.5s; expect_present=False phải quan sát cả deadline30s không có series, không PASS chỉ từ một query rỗng; scrape dùng deadline90s.

- [ ] **1. Viết tests đỏ:** `tests/unit/test_e2e_contract.py::test_e2e_is_opt_in` import/collect E2E dưới transport fail-if-called và không flag, assert không network/calls và cases skip; `test_sender_retry_preserves_timestamp` fake clock/transport assert bytes không đổi, attempts<=3, 204/400 không retry. Các helper sender nằm trong E2E test module, không đưa retry vào production.

E2E `test_scalar_fixture_is_wire_compatible` đọc hex fixture Task 2 và assert field values độc lập trước gửi fixture hiện tại. `test_missing_identity_labels_visible` gửi204 rồi query đúng `run_id`, assert giá trị42.25 và cả hai IDs; `test_matching_labels_visible` assert43.25/IDs; `test_conflict_is_not_written` gửi400, query đúng run_id tối đa30s vẫn empty. `test_gateway_scrape_up` query `up{job="ingestion-gateway"}` trong90s, assert1; thiếu scrape không được che bằng ingress204. E2E không tự start/stop Compose, không delete samples.

- [ ] **2. RED:** chạy unit contract `uv run --frozen pytest tests/unit/test_e2e_contract.py -q` trước helpers, xác nhận fail do behavior thiếu; chạy E2E không opt-in phải SKIPPED, không cố kết nối port.
- [ ] **3. Implement E2E/helpers và docs:** runbook gồm prerequisites/uv pins/sync/codegen/full Compose commands, headers và example Telegraf `outputs.http` (`data_format="prometheusremotewrite"`, method POST, raw-snappy content/version headers và hai IDs), dummy token rõ lab-only; lỗi/status/retry matrix, liveness/readiness khác nhau, metrics/logging, bảo toàn data, rollback Gateway không `down -v`, auth/TLS/LAN/VM/extensions deferred. Không ghi rằng ví dụ Telegraf đã được test VM. Link runbook từ README và ghi chú runbook Bước1, giữ baseline acceptance cũ.
- [ ] **4. Green local tests/codegen:** `uv run --frozen pytest tests/unit tests/integration -q` PASS, `uv lock --check`; regenerate protoc bằng đúng lệnh Task2/hash check PASS. E2E skip mặc định. Không lấy số test dự kiến làm số test đã chạy.
- [ ] **5. Chạy Linux unit/integration và E2E bằng container tạm khi được phép.** Root PowerShell resolve network thực từ container Prometheus, kiểm tra alias `prometheus`, không hardcode `infrapulse_monitoring`. Build đúng target `test` Task7, cùng Python/uv pins và dev deps; không thêm image/tag khác hoặc permanent test service. Root config-file test đã chạy Windows, được loại riêng khỏi Linux command vì không copy Compose/env repo vào test image. Từ root:

```powershell
$composeArgs = @('--project-directory', '.', '--env-file', '.env', '-f', 'deploy/compose/compose.yaml')
$promId = docker compose @composeArgs ps -q prometheus
if ($LASTEXITCODE -ne 0 -or -not $promId) { throw 'Prometheus service is not running' }
$nets = docker inspect --format '{{json .NetworkSettings.Networks}}' $promId | ConvertFrom-Json
$monitor = @($nets.PSObject.Properties | Where-Object { $_.Value.Aliases -contains 'prometheus' })
if ($monitor.Count -ne 1) { throw 'Resolve one monitoring network; do not guess' }
$network = $monitor[0].Name
docker build --target test -t infrapulse-ingest-test:local services/ingestion-gateway
if ($LASTEXITCODE -ne 0) { throw 'Test image build failed' }
docker run --rm --network $network infrapulse-ingest-test:local pytest tests/unit tests/integration --ignore=tests/integration/test_deployment_config.py -q
if ($LASTEXITCODE -ne 0) { throw 'Linux unit/integration tests failed' }
docker run --rm --network $network -e INFRAPULSE_RUN_E2E=1 infrapulse-ingest-test:local pytest tests/e2e/test_remote_write.py -m e2e -q
if ($LASTEXITCODE -ne 0) { throw 'Remote Write E2E failed' }
```

Không chạy song song hai E2E vượt rate mặc định. Docker test target copy source/tests từ build context, không bind root `.env`, không secret args hoặc root repo context. Linux command bỏ đúng `test_deployment_config.py`, không skip codec/admission/HTTP app tests; acceptance ghi rõ config tests chạy trên host, application tests chạy cả host/Linux.

- [ ] **6. Grafana UI có bằng chứng:** dùng browser đến `http://127.0.0.1:3000`, đăng nhập qua cơ chế credential an toàn/nhờ user, không log password; chọn datasource hiện hữu trong Explore, query `infrapulse_e2e_value{run_id="<run-id-thực>"}`, xác nhận value và IDs. Ghi run_id/query/thời điểm/screenshot đã loại dữ liệu nhạy cảm. UI chưa chạy thì GW-13 NOT RUN/PARTIAL, datasource API thành công không thay thế UI.
- [ ] **7. Native-host port isolation:** `Invoke-WebRequest http://127.0.0.1:8000/health/live` phải200 (hoặc port thực cấu hình); lấy native IPv4 interface đang dùng, thử `http://<native-ip>:<port>/health/live` với proxy disabled/timeout hữu hạn từ native host, phải không kết nối. Không dùng container namespace thay cho host test; container inspect HostIp không là bằng chứng đủ. Nếu native IP truy cập được, ghi GW-14 FAIL, không tự đổi firewall/LAN exposure hoặc tuyên bố lab đã cách ly; báo người dùng để thống nhất remediation. Kiểm tra volumes/services Bước1 còn nguyên, không dừng Prometheus để thử outage (MockTransport đã bao phủ).
- [ ] **8. Runtime logs và acceptance:** đọc có chọn lọc `docker compose --project-directory . --env-file .env -f deploy/compose/compose.yaml logs --no-color --tail 100 ingest`, sanitize trước report; assert không token sentinel/header/raw body và JSON ingestion records. Acceptance có bảng GW-01–GW-15 dưới đây, command/time/exit/outcome thực tế, failure/limits/remediation; không tự ghi PASS khi chưa chạy. Ghi key validation/Telegraf VM/TLS/LAN ngoài phạm vi, receiver partial-write/timeout-uncertainty còn tồn tại. Dọn chỉ one-off test containers do task tạo, không volumes/samples; không xóa code/test artifacts người dùng có trước.
- [ ] **9. Final checkpoint:** review diff toàn phạm vi, tests/results/thay đổi ngoài kế hoạch; yêu cầu fresh reviewer sau implementation theo execution mode, sửa findings rồi rerun tests liên quan. Bàn giao code và trạng thái test thật, chưa stage/commit/push nếu chưa có lệnh riêng sau review.

## Acceptance coverage

| ID | Implementation + bằng chứng bắt buộc |
|---|---|
| GW-01 | Tasks1/2/7: existing project, frozen lock, reproducible codegen/import Windows và Linux |
| GW-02 | Task7: config tests + runtime network/ports/volumes allowlist inspect |
| GW-03 | Task1 header tests + Task5 HTTP401/400/415; auth deferred được ghi rõ |
| GW-04 | Task2 codec/input/output/allocation/extensions tests + Task5 streaming cap |
| GW-05 | Task3 normalization/conflict + Task5 zero-forward invalid batch |
| GW-06 | Task3 counts/names/time boundaries/order/bit-preservation tests |
| GW-07 | Task4 mapping/stream-close/one-attempt + Task5 lifespan và no-early204 |
| GW-08 | Task5 fake-clock admission/cancellation + Task6 metrics khi saturated |
| GW-09 | Task5 live/ready/outage/deadline + Task7 Docker health thực tế |
| GW-10 | Task6 registry/cardinality/redaction tests + Task8 runtime logs |
| GW-11 | Tasks1–8 Windows/Linux test runs thật, số pass/skip/fail và exit code |
| GW-12 | Task8 query sample/value/IDs/run_id và scrape up, không chỉ204 |
| GW-13 | Task8 Grafana Explore UI/query/screenshot thực tế |
| GW-14 | Tasks7/8 constraints/host loopback/native-IP isolation và data Bước1 còn nguyên |
| GW-15 | Task8 runbook + acceptance theo bằng chứng, nêu deferred/out-of-scope |

## Self-check và bàn giao kế hoạch

- Đối chiếu lại thiết kế mục1–15 với task map/acceptance; không mở rộng auth, queue, LAN, feature extensions hoặc Git permissions.
- Kiểm tra signatures/types/error codes/fixture names xuyên task; mọi helper không production đều nằm trong tests và do task sở hữu khai báo.
- Bảo đảm năm Review Focus có tests cụ thể; RED vì implementation thiếu, GREEN bằng commands thật; E2E/network chỉ chạy ở giai đoạn đã được phép.
- Kế hoạch mô tả decisions/interfaces/tests, không phải source implementation; không thay thế việc đọc spec hoặc kiểm chứng runtime.
- Sau khi người dùng review kế hoạch: chọn subagent-driven hoặc native/executing-plans. Khuyến nghị subagent-driven vì codec/cancellation/resource limits cần review độc lập trước khi integration; không chạy code chỉ vì user đã đồng ý thiết kế.

## Nguồn pin khảo sát (metadata, chưa cài/chạy)

- [PyPI HTTPX](https://pypi.org/pypi/httpx/json), [protobuf](https://pypi.org/pypi/protobuf/json), [cramjam](https://pypi.org/pypi/cramjam/json), [pydantic-settings](https://pypi.org/pypi/pydantic-settings/json), [prometheus-client](https://pypi.org/pypi/prometheus-client/json).
- [PyPI pytest](https://pypi.org/pypi/pytest/json), [pytest-asyncio](https://pypi.org/pypi/pytest-asyncio/json), [grpcio-tools](https://pypi.org/pypi/grpcio-tools/json), [uv](https://pypi.org/pypi/uv/json), [AnyIO 4.15.1](https://pypi.org/pypi/anyio/4.15.1/json), [PyYAML 6.0.3](https://pypi.org/pypi/PyYAML/6.0.3/json).
- [Docker Hub Python tags](https://hub.docker.com/v2/repositories/library/python/tags?page_size=20&name=3.12.) xác nhận base3.12.16/digest; uv OCI manifest phải xác minh ở bước build, không coi PyPI release là bằng chứng OCI tag đã tồn tại.
