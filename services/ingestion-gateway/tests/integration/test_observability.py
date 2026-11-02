"""Observable metrics/log boundaries; transports never use the real network."""

import asyncio
import json
import logging
import threading
from uuid import UUID

import httpx
from prometheus_client import CollectorRegistry, generate_latest
from prometheus_client.parser import text_string_to_metric_families
import pytest

from app.config import Settings
from app.observability import Observability, configure_logging, log_event, new_request_id


PATH = "/api/v1/ingest/remote-write"
PREFIX = "infrapulse_ingest_"
RESULTS = {"accepted", "rejected", "too_large", "rate_limited", "unavailable", "timeout", "bad_status"}
REASONS = {
    "invalid_authorization", "invalid_identity", "identity_mismatch", "credential_verification_unavailable", "unsupported_media", "invalid_protocol_header",
    "invalid_content_length", "empty_body", "invalid_snappy", "invalid_protobuf", "unsupported_fields",
    "empty_write", "empty_series", "invalid_labels", "identity_conflict", "duplicate_series",
    "invalid_timestamp", "payload_too_large", "too_many_series", "too_many_samples", "body_timeout",
    "rate_limited", "concurrency_limited", "upstream_rejected", "upstream_too_large",
    "upstream_rate_limited", "upstream_unavailable", "upstream_timeout", "upstream_bad_status", "internal_error",
}


def samples(text):
    return [sample for family in text_string_to_metric_families(text) for sample in family.samples
            if sample.name.startswith(PREFIX)]


def value(text, name, **labels):
    return sum(sample.value for sample in samples(text)
               if sample.name == PREFIX + name and sample.labels == labels)


async def scrape(client):
    response = await client.get("/metrics")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    return response.text


def records(captured):
    # Inspect the actual streams, not a mock logger or caplog's pre-format records.
    assert not captured.err
    parsed = [json.loads(line) for line in captured.out.splitlines() if line.strip()]
    assert parsed
    for record in parsed:
        assert set(record) <= {
            "timestamp", "level", "event", "request_id", "route", "status", "duration_ms",
            "series_count", "sample_count", "upstream_status", "error_code",
        }
        assert "timestamp" in record and "level" in record and "event" in record
    return parsed


@pytest.mark.parametrize("outcome,status,result,reason", [
    (204, 204, "accepted", None),
    (400, 400, "rejected", "upstream_rejected"),
    (413, 413, "too_large", "upstream_too_large"),
    (429, 429, "rate_limited", "upstream_rate_limited"),
    (503, 503, "unavailable", "upstream_unavailable"),
    (307, 502, "bad_status", "upstream_bad_status"),
    ("timeout", 504, "timeout", "upstream_timeout"),
    ("network", 503, "unavailable", "upstream_unavailable"),
    ("unexpected", 500, "bad_status", "internal_error"),
])
async def test_metrics_have_finite_labels(app_client, headers, make_write, pack_write, outcome, status, result, reason):
    # Catches counting validation as forwarding, wrong result mappings, or client-derived labels.
    calls = []
    def upstream(request):
        calls.append(request)
        if outcome == "timeout":
            raise httpx.ReadTimeout("private timeout URL")
        if outcome == "network":
            raise httpx.ConnectError("private network URL")
        if outcome == "unexpected":
            raise RuntimeError("private exception")
        return httpx.Response(outcome, headers={"Location": "http://private.test:bad"})

    async with app_client(upstream_transport=httpx.MockTransport(upstream)) as (_, client):
        assert (await client.post(PATH, headers=headers, content=pack_write(make_write()))).status_code == status
        invalid = [(k, v) for k, v in headers if k != b"authorization"]
        assert (await client.post(PATH, headers=invalid, content=b"private payload")).status_code == 401
        text = await scrape(client)
    assert len(calls) == 1
    assert value(text, "requests_total", status=str(status)) == 1
    assert value(text, "requests_total", status="401") == 1 + (status == 401)
    assert value(text, "request_duration_seconds_count", status_class=f"{status // 100}xx") == 1 + (status // 100 == 4)
    assert value(text, "forward_attempts_total", result=result) == 1
    assert sum(s.value for s in samples(text) if s.name == PREFIX + "forward_attempts_total") == 1
    assert value(text, "upstream_duration_seconds_count", result=result) == 1
    assert value(text, "rejections_total", reason="invalid_authorization") == 1
    if reason:
        assert value(text, "rejections_total", reason=reason) == 1
    assert value(text, "inflight_requests") == 0
    for sample in samples(text):
        metric = sample.name.removeprefix(PREFIX)
        if metric.startswith("requests_"):
            assert set(sample.labels) == {"status"}
            assert sample.labels["status"] in {"204", "400", "401", "403", "408", "413", "415", "429", "500", "502", "503", "504"}
        elif metric.startswith("request_duration_"):
            assert set(sample.labels) <= {"status_class", "le"}
            assert sample.labels["status_class"] in {"2xx", "4xx", "5xx"}
        elif metric.startswith("rejections_"):
            assert set(sample.labels) == {"reason"} and sample.labels["reason"] in REASONS
        elif metric.startswith(("forward_attempts_", "upstream_duration_")):
            assert set(sample.labels) <= {"result", "le"} and sample.labels["result"] in RESULTS
        else:
            assert metric == "inflight_requests" and sample.labels == {}


async def test_metrics_do_not_count_scrapes(app_client, headers, make_write, pack_write):
    async with app_client() as (_, client):
        for _ in range(3):
            await scrape(client)
            assert (await client.get("/health/live")).status_code == 200
            assert (await client.get("/health/ready")).status_code == 200
            assert (await client.get(PATH)).status_code == 405
        text = await scrape(client)
        assert sum(s.value for s in samples(text) if s.name == PREFIX + "requests_total") == 0
        assert (await client.post(PATH, headers=headers, content=pack_write(make_write()))).status_code == 204
        text = await scrape(client)
        assert value(text, "requests_total", status="204") == 1


async def test_registry_per_app(app_client, headers, make_write, pack_write):
    async with app_client() as (first, a), app_client() as (second, b):
        assert first.state.observability.registry is not second.state.observability.registry
        await a.post(PATH, headers=headers, content=pack_write(make_write()))
        assert value(await scrape(a), "requests_total", status="204") == 1
        assert value(await scrape(b), "requests_total", status="204") == 0
    registry = CollectorRegistry()
    observer = Observability(registry)
    assert observer.registry is registry
    observer.record_request(status=999, duration_seconds=0.01, reason="private-label")
    observer.record_forward(result="private-result", duration_seconds=0.01)
    text = generate_latest(registry).decode()
    assert "private-" not in text
    assert value(text, "requests_total", status="500") == 1
    assert value(text, "rejections_total", reason="internal_error") == 1
    assert value(text, "forward_attempts_total", result="bad_status") == 1


@pytest.mark.parametrize("worker_error", [False, True])
async def test_observability_when_limited(app_client, headers, make_write, pack_write, monkeypatch, worker_error):
    # Releasing the gauge at cancellation instead of actual worker join must fail.
    import app.pipeline as pipeline
    original = pipeline.decode_write
    release, entered = threading.Event(), asyncio.Event()
    loop = asyncio.get_running_loop()
    lock = threading.Lock()
    started = []
    def blocked(*args):
        with lock:
            started.append(True)
            if len(started) == 2:
                loop.call_soon_threadsafe(entered.set)
        assert release.wait(5)
        return original(b"bad" if worker_error else args[0], args[1])
    monkeypatch.setattr(pipeline, "decode_write", blocked)
    async with app_client() as (app, client):
        payload = pack_write(make_write())
        tasks = [asyncio.create_task(client.post(PATH, headers=headers, content=payload)) for _ in range(2)]
        try:
            await asyncio.wait_for(entered.wait(), 2)
            assert value(await scrape(client), "inflight_requests") == 2
            for _ in range(2):
                tasks[0].cancel()
                await asyncio.sleep(0)  # event-loop barrier; never waits for wall time
                assert not tasks[0].done()
                assert value(await scrape(client), "inflight_requests") == 2
            assert (await client.post(PATH, headers=headers, content=payload)).status_code == 429
            assert (await client.get("/health/live")).status_code == 200
        finally:
            release.set()
            results = await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), 3)
        assert isinstance(results[0], asyncio.CancelledError)
        assert results[1].status_code == (400 if worker_error else 204)
        text = await scrape(client)
        assert value(text, "inflight_requests") == app.state.pipeline.admission.inflight == 0
        assert value(text, "forward_attempts_total", result="accepted") == (0 if worker_error else 1)
        assert value(text, "rejections_total", reason="concurrency_limited") == 1


@pytest.mark.parametrize("stage", ["body", "forward"])
async def test_cancelled_noncodec_lease_and_attempt(app_client, headers, make_write, pack_write, stage):
    entered, release = asyncio.Event(), asyncio.Event()
    async def upstream(request):
        entered.set()
        await release.wait()
        return httpx.Response(204)
    async def body():
        entered.set()
        await release.wait()
        yield b"unused"
    async with app_client(upstream_transport=httpx.MockTransport(upstream)) as (app, client):
        task = asyncio.create_task(client.post(PATH, headers=headers,
            content=body() if stage == "body" else pack_write(make_write())))
        try:
            await asyncio.wait_for(entered.wait(), 2)
            assert value(await scrape(client), "inflight_requests") == 1
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            text = await scrape(client)
            assert value(text, "inflight_requests") == app.state.pipeline.admission.inflight == 0
            assert sum(s.value for s in samples(text) if s.name == PREFIX + "forward_attempts_total") == (stage == "forward")
        finally:
            release.set()
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)


async def test_untrusted_paths_and_errors_are_redacted(app_client, headers, make_write, pack_write, capsys, monkeypatch, active_proof):
    secrets = ["token-SENTINEL", "identity-SENTINEL", "payload-SENTINEL", "body-SENTINEL",
               "exception-SENTINEL", "query-SENTINEL", "path-SENTINEL", "client-secret-id", "location-SENTINEL"]
    common = [(k, b"Bearer token-SENTINEL" if k == b"authorization" else v) for k, v in headers]
    common.append((b"x-request-id", b"client-secret-id"))
    payload = pack_write(make_write())
    outcomes = iter([307, 503, "timeout", "network", "unexpected"])
    def upstream(request):
        outcome = next(outcomes)
        if outcome == "timeout":
            raise httpx.ReadTimeout("http://exception-SENTINEL/?token=token-SENTINEL")
        if outcome == "network":
            raise httpx.ConnectError("http://exception-SENTINEL")
        if outcome == "unexpected":
            raise RuntimeError("exception-SENTINEL")
        return httpx.Response(outcome, content=b"body-SENTINEL",
                              headers={"Location": "http://location-SENTINEL:bad"})
    responses = []
    def credential_service(request):
        assert json.loads(request.content) == {'api_key': 'token-SENTINEL'}
        return httpx.Response(200, json=active_proof)
    async with app_client(upstream_transport=httpx.MockTransport(upstream),
            management_transport=httpx.MockTransport(credential_service)) as (app, client):
        responses.append(await client.post(PATH + "?secret=query-SENTINEL", headers=[
            (k, b"token-SENTINEL" if k == b"authorization" else v) for k, v in common], content=payload))
        responses.append(await client.post(PATH, headers=[
            (k, b"identity-SENTINEL/" if k == b"x-server-id" else v) for k, v in common], content=payload))
        responses.append(await client.post(PATH, headers=common, content=b"payload-SENTINEL"))
        responses.append(await client.post(PATH, headers=common + [(b"content-length", b"9999999")], content=payload))
        for _ in range(5):
            responses.append(await client.post(PATH + "?secret=query-SENTINEL", headers=common, content=payload))
        responses.append(await client.get("/path-SENTINEL?secret=query-SENTINEL", headers=common))
        # A fault outside the ingestion route exercises the ASGI fallback rather than Task 5's catch.
        @app.get("/test-fault")
        async def fail():
            raise RuntimeError("exception-SENTINEL")
        responses.append(await client.get("/test-fault?secret=query-SENTINEL"))
        original = app.state.pipeline.handle
        async def unexpected(*args, **kwargs):
            raise RuntimeError("exception-SENTINEL")
        monkeypatch.setattr(app.state.pipeline, "handle", unexpected)
        responses.append(await client.post(PATH, headers=common, content=payload))
        monkeypatch.setattr(app.state.pipeline, "handle", original)
    async with app_client(Settings(rate_burst=1, rate_per_second=0.0001),
            management_transport=httpx.MockTransport(credential_service)) as (_, client):
        await client.post(PATH, headers=common, content=payload)
        responses.append(await client.post(PATH, headers=common, content=payload))
    assert [r.status_code for r in responses] == [401, 400, 400, 413, 502, 503, 504, 503, 500, 404, 500, 500, 429]
    captured = capsys.readouterr()
    combined = captured.out + captured.err + "".join(r.text + str(r.headers) for r in responses)
    for secret in secrets:
        assert secret not in combined
    parsed = records(captured)
    assert not any(r['event'] == 'identity_unverified' for r in parsed)
    assert any(r["event"] == "lab_only" and r["level"] == "WARNING" for r in parsed)
    completions = [r for r in parsed if r["event"] == "request_completed"]
    for response in responses:
        request_id = response.headers["x-request-id"]
        assert UUID(request_id).version == 4
        matching = [r for r in completions if r["request_id"] == request_id]
        assert len(matching) == 1
        record = matching[0]
        assert {"timestamp", "level", "event", "request_id", "route", "status", "duration_ms"} <= record.keys()
        assert record["status"] == response.status_code
        assert record["duration_ms"] >= 0
        assert record["route"] in {PATH, "unmatched"}
        if response.status_code in {502, 503, 504} or response is responses[8]:
            assert (record["series_count"], record["sample_count"]) == (1, 1)
        else:
            assert "series_count" not in record and "sample_count" not in record
    assert next(r for r in completions if r["request_id"] == responses[4].headers["x-request-id"])["upstream_status"] == 307
    assert "Traceback" not in combined


async def test_request_preparation_is_not_an_upstream_attempt(app_client, headers, make_write, pack_write, monkeypatch):
    # Catch moving the attempt boundary above explicit Request construction.
    async with app_client() as (_, client):
        # Warm the real provider first: Request is shared by both HTTP boundaries.
        assert (await client.post(PATH, headers=headers, content=pack_write(make_write()))).status_code == 204
        def fail_request(*args, **kwargs):
            raise RuntimeError("preparation-SENTINEL")
        monkeypatch.setattr("app.forwarder.httpx.Request", fail_request)
        response = await client.post(PATH, headers=headers, content=pack_write(make_write()))
        assert response.status_code == 500 and "preparation-SENTINEL" not in response.text
        text = await scrape(client)
        assert sum(s.value for s in samples(text) if s.name == PREFIX + "forward_attempts_total") == 1
        assert value(text, "inflight_requests") == 0


async def test_logging_is_idempotent_and_sanitizes_runtime_loggers(app_client, capsys):
    async with app_client(), app_client():
        configure_logging("DEBUG")
        configure_logging("INFO")
        request_id = new_request_id()
        assert UUID(request_id).version == 4
        log_event("request_completed", request_id=request_id, route=PATH, status=204, duration_ms=1.5,
                  series_count=1, sample_count=2)
        # HTTP client info messages (which contain full URLs) must be suppressed.
        for name in ("httpx", "httpcore", "httpcore.connection"):
            assert logging.getLogger(name).getEffectiveLevel() >= logging.WARNING
            logging.getLogger(name).info("info-SENTINEL http://private-SENTINEL")
        try:
            raise RuntimeError("exception-SENTINEL")
        except RuntimeError:
            for name in ("httpx", "httpcore.connection", "uvicorn.error", "uvicorn.access"):
                logging.getLogger(name).warning("runtime-SENTINEL %r", {"token": "token-SENTINEL"}, exc_info=True)
        log_event("event-SENTINEL", request_id="client-secret-id", route="/path-SENTINEL", error_code="error-SENTINEL")
    captured = capsys.readouterr()
    assert "SENTINEL" not in captured.out + captured.err and "client-secret-id" not in captured.out
    parsed = records(captured)
    assert len([r for r in parsed if r.get("request_id") == request_id]) == 1
    assert not any(r['event'] == 'identity_unverified' for r in parsed)
    assert len([r for r in parsed if r['event'] == 'lab_only']) == 2
    assert "Traceback" not in captured.out
