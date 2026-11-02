"""HTTP/ASGI boundary tests; malformed lengths bypass HTTPX normalization."""

import asyncio
from dataclasses import FrozenInstanceError
import json
import threading

import cramjam
import httpx
import pytest

from app.config import Settings
from app.identity import parse_ingest_headers
from app.proto.remote_write_pb2 import WriteRequest


PATH = "/api/v1/ingest/remote-write"


async def raw_request(app, headers, chunks=(), *, receive=None):
    messages = []
    iterator = iter(chunks)

    async def chunk_receive():
        try:
            chunk = next(iterator)
        except StopIteration:
            return {"type": "http.request", "body": b"", "more_body": False}
        return {"type": "http.request", "body": chunk, "more_body": True}

    async def send(message):
        messages.append(message)

    await app({
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
        "method": "POST", "scheme": "http", "path": PATH, "raw_path": PATH.encode(),
        "query_string": b"", "root_path": "", "headers": headers,
        "server": ("gateway.test", 80), "client": ("test", 123),
    }, receive or chunk_receive, send)
    start = next(message for message in messages if message["type"] == "http.response.start")
    body = b"".join(message.get("body", b"") for message in messages if message["type"] == "http.response.body")
    return start["status"], dict(start["headers"]), json.loads(body) if body else None


def assert_error(response, status, code):
    assert response.status_code == status
    body = response.json()
    assert body["code"] == code
    assert body["message"]
    assert len(body["request_id"]) == 32
    assert response.headers["x-request-id"] == body["request_id"]


async def test_valid_request_returns_204_after_upstream(app_client, headers, make_write, pack_write):
    entered, release = asyncio.Event(), asyncio.Event()
    calls = []

    async def upstream(request):
        calls.append(request)
        entered.set()
        await release.wait()
        return httpx.Response(202)

    async with app_client(upstream_transport=httpx.MockTransport(upstream)) as (app, client):
        task = asyncio.create_task(client.post(PATH, headers=headers, content=pack_write(make_write())))
        try:
            await asyncio.wait_for(entered.wait(), 2)
            assert not task.done()
        finally:
            release.set()
        response = await task
        assert response.status_code == 204
        assert response.content == b""
        assert app.state.pipeline.admission.inflight == 0
    assert len(calls) == 1
    decoded = WriteRequest.FromString(bytes(cramjam.snappy.decompress_raw(calls[0].content)))
    assert [(label.name, label.value) for label in decoded.timeseries[0].labels] == [
        ("__name__", "infrapulse_unit_value"), ("agent_id", "00000000-0000-4000-8000-000000000003"), ("server_id", "00000000-0000-4000-8000-000000000002"),
    ]
    assert "authorization" not in calls[0].headers


async def test_invalid_batch_never_forwarded(app_client, headers, make_write, pack_write):
    calls = []
    message = make_write()
    bad = make_write(labels=[("__name__", "other_metric"), ("server_id", "wrong")])
    message.timeseries.add().CopyFrom(bad.timeseries[0])
    async with app_client(upstream_transport=httpx.MockTransport(
        lambda request: calls.append(request) or httpx.Response(204)
    )) as (_, client):
        response = await client.post(PATH, headers=headers, content=pack_write(message))
    assert_error(response, 400, "identity_conflict")
    assert calls == []


@pytest.mark.parametrize("remove,add,status,code", [
    (b"authorization", [], 401, "invalid_authorization"),
    (b"x-server-id", [(b'x-server-id', b'invalid/claim')], 400, "invalid_identity"),
    (b"user-agent", [(b"user-agent", b"")], 400, "invalid_protocol_header"),
    (b"content-encoding", [(b"content-encoding", b"gzip")], 415, "unsupported_media"),
    (b"content-type", [(b"content-type", b"application/json")], 415, "unsupported_media"),
    (None, [(b"Content-Type", b"application/x-protobuf")], 415, "unsupported_media"),
    (None, [(b"Authorization", b"Bearer second")], 401, "invalid_authorization"),
    (None, [(b"X-Server-ID", b"srv-lab")], 400, "invalid_identity"),
    (None, [(b"Content-Encoding", b"snappy")], 415, "unsupported_media"),
    (None, [(b"X-Prometheus-Remote-Write-Version", b"0.1.0")], 415, "unsupported_media"),
    (None, [(b"User-Agent", b"another")], 400, "invalid_protocol_header"),
])
async def test_header_errors(app_client, headers, make_write, pack_write, remove, add, status, code):
    calls = []
    raw_headers = [(key, value) for key, value in headers if key != remove] + add
    async with app_client(upstream_transport=httpx.MockTransport(
        lambda request: calls.append(request) or httpx.Response(204)
    )) as (app, _):
        result, response_headers, body = await raw_request(app, raw_headers, [pack_write(make_write())])
    assert result == status
    assert body["code"] == code
    assert body["message"]
    assert len(body["request_id"]) == 32
    if status == 401:
        assert response_headers[b"www-authenticate"] == b"Bearer"
    assert calls == []


@pytest.mark.parametrize("lengths,chunks,cap,status", [
    ([b"1", b"1"], [b"x"], 8, 400),
    ([b"1", b"2"], [b"x"], 8, 400),
    ([b"+1"], [b"x"], 8, 400),
    ([b"-1"], [b"x"], 8, 400),
    ([b"1.0"], [b"x"], 8, 400),
    ([b"nope"], [b"x"], 8, 400),
    ([b""], [b"x"], 8, 400),
    ([b"1, 1"], [b"x"], 8, 400),
    ([b"9"], [], 8, 413),
    ([b"9" * 5000], [], 8, 413),
    ([], [b"1234", b"56789"], 8, 413),
    ([b"1"], [b"1234", b"56789"], 8, 413),
    ([b"1"], [b"12"], 8, 400),
    ([b"3"], [b"12"], 8, 400),
    ([b"0"], [b"x"], 8, 400),
])
async def test_stream_length_is_not_trusted(app_client, headers, lengths, chunks, cap, status):
    calls = []
    additions = [(b"Content-Length" if index else b"content-length", value) for index, value in enumerate(lengths)]
    async with app_client(Settings(max_compressed_bytes=cap), upstream_transport=httpx.MockTransport(
        lambda request: calls.append(request) or httpx.Response(204)
    )) as (app, _):
        result, _, body = await raw_request(app, headers + additions, chunks)
        assert app.state.pipeline.admission.inflight == 0
    assert result == status
    assert body["code"] == ("payload_too_large" if status == 413 else "invalid_content_length")
    assert calls == []


@pytest.mark.parametrize("length", [None, "actual", "leading_zeros"])
async def test_stream_accepts_valid_length_or_absent(app_client, headers, make_write, pack_write, length):
    payload = pack_write(make_write())
    extra = [] if length is None else [(b"content-length", (("0" * 5000 if length == "leading_zeros" else "") + str(len(payload))).encode())]
    async with app_client() as (app, _):
        status, _, body = await raw_request(app, headers + extra, [payload[:4], payload[4:]])
    assert (status, body) == (204, None)


async def test_body_total_timeout(app_client, headers):
    blocked = asyncio.Event()

    async def receive():
        await blocked.wait()
        raise AssertionError("body wait must be cancelled")

    async with app_client(Settings(body_read_timeout_seconds=0.02)) as (app, _):
        status, _, body = await asyncio.wait_for(raw_request(app, headers, receive=receive), 1)
        assert (status, body["code"]) == (408, "body_timeout")
        assert app.state.pipeline.admission.inflight == 0


async def test_body_deadline_is_total_not_per_chunk(app_client, headers):
    loop = asyncio.get_running_loop()
    started = loop.time()

    async def receive():
        future = loop.create_future()
        timer = loop.call_later(0.015, future.set_result, None)
        try:
            await future
        finally:
            timer.cancel()
        return {"type": "http.request", "body": b"x", "more_body": True}

    async with app_client(Settings(body_read_timeout_seconds=0.04)) as (app, _):
        status, _, body = await asyncio.wait_for(raw_request(app, headers, receive=receive), 1)
        assert (status, body["code"]) == (408, "body_timeout")
        assert loop.time() - started < 0.5
        assert app.state.pipeline.admission.inflight == 0


@pytest.mark.parametrize("upstream,status,code,retry", [
    (400, 400, "upstream_rejected", None),
    (413, 413, "upstream_too_large", None),
    (429, 429, "upstream_rate_limited", "7"),
    (500, 503, "upstream_unavailable", None),
    (302, 502, "upstream_bad_status", None),
    (401, 502, "upstream_bad_status", None),
])
async def test_forward_mapping(app_client, headers, make_write, pack_write, upstream, status, code, retry):
    calls = []
    async with app_client(upstream_transport=httpx.MockTransport(
        lambda request: calls.append(request) or httpx.Response(
            upstream, headers={"Retry-After": "7", "Location": "http://[invalid"}, content=b"private-upstream-body"
        )
    )) as (app, client):
        response = await client.post(PATH, headers=headers, content=pack_write(make_write()))
        assert app.state.pipeline.admission.inflight == 0
    assert_error(response, status, code)
    assert response.headers.get("retry-after") == retry
    assert "private-upstream" not in response.text
    assert len(calls) == 1


async def test_rate_limit_is_persistent(app_client, headers, make_write, pack_write):
    async with app_client(Settings(rate_burst=1, rate_per_second=0.0001)) as (_, client):
        payload = pack_write(make_write())
        assert (await client.post(PATH, headers=headers, content=payload)).status_code == 204
        response = await client.post(PATH, headers=headers, content=payload)
        assert_error(response, 429, "rate_limited")
        assert response.headers["retry-after"] == "1"


@pytest.mark.parametrize("failure,status,code", [
    ("decode", 400, "invalid_snappy"),
    ("empty_body", 400, "empty_body"),
    ("validation", 400, "invalid_labels"),
    ("forward", 503, "upstream_unavailable"),
    ("unexpected", 500, "internal_error"),
    ("disconnect", 500, "internal_error"),
])
async def test_release_on_all_failures(app_client, headers, make_write, pack_write, failure, status, code):
    calls = []

    def upstream(request):
        calls.append(request)
        if failure == "unexpected":
            raise RuntimeError("private-sentinel-error")
        raise httpx.ConnectError("private-sentinel-url")

    async def disconnected():
        return {"type": "http.disconnect"}

    payload = b"bad" if failure == "decode" else b"" if failure == "empty_body" else pack_write(make_write(
        labels=[] if failure == "validation" else None
    ))
    async with app_client(upstream_transport=httpx.MockTransport(upstream)) as (app, _):
        result, _, body = await raw_request(
            app, headers, [payload], receive=disconnected if failure == "disconnect" else None,
        )
        assert app.state.pipeline.admission.inflight == 0
        assert result == status
        assert body["code"] == code
        assert "private-sentinel" not in json.dumps(body)
    assert len(calls) == (1 if failure in {"forward", "unexpected"} else 0)


async def test_unexpected_ingestion_boundary_is_sanitized(app_client, headers, monkeypatch, capsys):
    async with app_client() as (app, _):
        async def fail(*args, **kwargs):
            raise RuntimeError("private-boundary-sentinel")
        monkeypatch.setattr(app.state.pipeline, "handle", fail)
        status, _, body = await raw_request(app, headers)
    assert (status, body["code"]) == (500, "internal_error")
    assert "private-boundary-sentinel" not in json.dumps(body) + capsys.readouterr().err


async def test_one_frozen_receive_clock(app_client, headers, make_write, pack_write, monkeypatch, received_at_ms):
    reads = []
    def clock():
        reads.append(True)
        return received_at_ms if len(reads) == 1 else 0
    async with app_client() as (_, client):
        monkeypatch.setattr("app.routes.ingest.utc_now_ms", clock)
        response = await client.post(PATH, headers=headers, content=pack_write(make_write()))
    assert response.status_code == 204
    assert len(reads) == 1


@pytest.mark.parametrize("limit", ["decompressed", "compressed"])
async def test_size_rechecked_after_injection(app_client, headers, make_write, pack_write, limit):
    message = make_write()
    calls = []
    settings = Settings(**{f"max_{limit}_bytes": message.ByteSize() if limit == "decompressed" else len(pack_write(message))})
    async with app_client(settings, upstream_transport=httpx.MockTransport(
        lambda request: calls.append(request) or httpx.Response(204)
    )) as (_, client):
        response = await client.post(PATH, headers=headers, content=pack_write(message))
    assert_error(response, 413, "payload_too_large")
    assert calls == []


@pytest.mark.parametrize("worker_error", [False, True])
async def test_cancel_during_codec_keeps_slot(app_client, headers, make_write, pack_write, monkeypatch, worker_error):
    import app.pipeline as pipeline

    original = pipeline.decode_write
    release = threading.Event()
    entered = asyncio.Event()
    loop = asyncio.get_running_loop()
    lock = threading.Lock()
    started, finished, thread_ids = [], [], []
    calls = []

    def block_decode(*args):
        with lock:
            started.append(True)
            thread_ids.append(threading.get_ident())
            if len(started) == 2:
                loop.call_soon_threadsafe(entered.set)
        try:
            assert release.wait(5), "test must unblock workers"
            if worker_error:
                return original(b"bad", args[1])
            return original(*args)
        finally:
            with lock:
                finished.append(True)

    monkeypatch.setattr(pipeline, "decode_write", block_decode)
    async with app_client(upstream_transport=httpx.MockTransport(
        lambda request: calls.append(request) or httpx.Response(204)
    )) as (app, client):
        payload = pack_write(make_write())
        tasks = [asyncio.create_task(client.post(PATH, headers=headers, content=payload)) for _ in range(2)]
        try:
            await asyncio.wait_for(entered.wait(), 2)
            assert all(ident != threading.get_ident() for ident in thread_ids)
            tasks[0].cancel()  # Direct asyncio cancellation, NOT just an AnyIO cancel scope.
            # Loop barrier: let cancellation propagate without releasing the worker.
            barrier = loop.create_future()
            loop.call_soon(barrier.set_result, None)
            await barrier
            response = await client.post(PATH, headers=headers, content=payload)
            assert_error(response, 429, "concurrency_limited")
            assert not tasks[0].done()
            assert finished == []
            assert app.state.pipeline.admission.inflight == 2
            tasks[0].cancel()  # Repeated cancellation must not pierce the join.
        finally:
            release.set()
            results = await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), 3)
        assert isinstance(results[0], asyncio.CancelledError)
        assert results[1].status_code == (400 if worker_error else 204)
        # The await joins both worker completions before release is observable.
        assert len(finished) == 2
        assert app.state.pipeline.admission.inflight == 0
        assert len(calls) == (0 if worker_error else 1)  # no forwarding after cancellation
        monkeypatch.setattr(pipeline, "decode_write", original)
        assert (await client.post(PATH, headers=headers, content=payload)).status_code == 204


async def test_pipeline_counts_and_single_offload(app_client, make_write, pack_write, headers, received_at_ms, monkeypatch):
    import app.pipeline as pipeline

    phases = []
    for name in ("decode_write", "validate_and_normalize", "encode_write"):
        original = getattr(pipeline, name)
        def tracked(*args, _original=original, _name=name, **kwargs):
            phases.append((_name, threading.get_ident()))
            return _original(*args, **kwargs)
        monkeypatch.setattr(pipeline, name, tracked)

    async def stream():
        message = make_write(samples=[(1.0, received_at_ms - 1), (2.0, received_at_ms)])
        message.timeseries.add().CopyFrom(make_write(labels=[("__name__", "other_metric")]).timeseries[0])
        yield pack_write(message)

    async with app_client() as (app, _):
        limiter = app.state.pipeline.codec_limiter
        for _ in range(2):
            result = await app.state.pipeline.handle(stream(), parse_ingest_headers(headers), received_at_ms=received_at_ms)
            assert (result.forward.status_code, result.series_count, result.sample_count) == (204, 2, 3)
            with pytest.raises(FrozenInstanceError):
                result.series_count = 99
            assert app.state.pipeline.codec_limiter is limiter
        assert app.state.pipeline.admission.inflight == 0
    for offset in (0, 3):
        assert [name for name, _ in phases[offset:offset + 3]] == ["decode_write", "validate_and_normalize", "encode_write"]
        threads = {ident for _, ident in phases[offset:offset + 3]}
        assert len(threads) == 1
        assert threading.get_ident() not in threads


@pytest.mark.parametrize("stage", ["body", "forward"])
async def test_cancel_elsewhere_releases_slot(app_client, headers, make_write, pack_write, stage):
    entered, block = asyncio.Event(), asyncio.Event()

    async def receive():
        entered.set()
        await block.wait()
        return {"type": "http.request", "body": b"", "more_body": False}

    async def upstream(request):
        entered.set()
        await block.wait()
        return httpx.Response(204)

    async with app_client(upstream_transport=httpx.MockTransport(upstream)) as (app, _):
        task = asyncio.create_task(raw_request(app, headers, [pack_write(make_write())],
            receive=receive if stage == "body" else None))
        try:
            await asyncio.wait_for(entered.wait(), 2)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert app.state.pipeline.admission.inflight == 0
        finally:
            block.set()
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
