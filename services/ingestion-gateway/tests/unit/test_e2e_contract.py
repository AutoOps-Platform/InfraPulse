"""Test-client contracts, not Gateway retry behavior; external I/O is replaced only at transport."""

import importlib.util
import os
from pathlib import Path
import subprocess
import sys

import cramjam
import httpx
import pytest

from app.proto.remote_write_pb2 import WriteRequest


MODULE = Path(__file__).parents[1] / "e2e" / "test_remote_write.py"


@pytest.fixture
def e2e():
    assert MODULE.is_file(), "Task 8 E2E client/helpers are missing"
    spec = importlib.util.spec_from_file_location("infrapulse_remote_write_e2e", MODULE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def clock(e2e, monkeypatch):
    class Clock:
        now = 0.0
        sleeps = None

        def __init__(self):
            self.sleeps = []

        async def sleep(self, seconds):
            assert seconds > 0
            self.sleeps.append(seconds)
            self.now += seconds

    fake = Clock()
    monkeypatch.setattr(e2e, "monotonic", lambda: fake.now)
    monkeypatch.setattr(e2e, "sleep", fake.sleep)
    monkeypatch.setattr(e2e, "uniform", lambda low, high: 0.125)
    return fake


def test_e2e_is_opt_in(tmp_path):
    # Break caught: import/collection or default execution sends live traffic.
    assert MODULE.is_file(), "Task 8 opt-in E2E module is missing"
    script = r'''
import httpx, runpy, socket, sys, pytest
calls = []
def forbidden(*args, **kwargs):
    calls.append(True)
    raise AssertionError("Network attempted without opt-in")
httpx.AsyncHTTPTransport.handle_async_request = forbidden
httpx.HTTPTransport.handle_request = forbidden
socket.socket.connect = forbidden
runpy.run_path(sys.argv[1], run_name="collection_probe")
class Results:
    skipped = 0
    passed = 0
    def pytest_runtest_logreport(self, report):
        self.skipped += int(report.skipped)
        self.passed += int(report.when == "call" and report.passed)
r = Results()
code = pytest.main([sys.argv[1], "-q", "-p", "no:cacheprovider", "--basetemp", sys.argv[2]], plugins=[r])
assert code == 0, code
assert r.skipped == 5 and r.passed == 0, (r.skipped, r.passed)
assert not calls, "E2E performed network I/O without opt-in"
'''
    environment = {k: v for k, v in os.environ.items() if k != "INFRAPULSE_RUN_E2E"}
    result = subprocess.run(
        [sys.executable, "-c", script, str(MODULE), str(tmp_path / "child-pytest")],
        env=environment, capture_output=True, text=True, encoding="utf-8", timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "5 skipped" in result.stdout


async def test_sender_retry_preserves_timestamp(e2e, clock):
    # Break caught: rebuild/re-time the payload on sender retry or exceed three calls.
    wire = bytes.fromhex((MODULE.parents[1] / "fixtures" / "remote_write_scalar.hex").read_text(encoding="utf-8"))
    payload = bytes(cramjam.snappy.compress_raw(wire))
    calls = []

    def upstream(request):
        calls.append((request.url.path, request.content, dict(request.headers)))
        return httpx.Response([503, 500, 204][len(calls) - 1])

    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream), base_url="http://gateway.test") as client:
        response = await e2e.send_with_retry(client, payload, {"X-Lab-Test": "fixed"})
    assert response.status_code == 204
    assert len(calls) == 3
    assert all(path == "/api/v1/ingest/remote-write" and body == payload and headers["x-lab-test"] == "fixed" for path, body, headers in calls)
    assert [WriteRequest.FromString(bytes(cramjam.snappy.decompress_raw(body))).timeseries[0].samples[0].timestamp for _, body, _ in calls] == [1000, 1000, 1000]
    assert clock.sleeps == [0.625, 1.125]


@pytest.mark.parametrize("status", [204, 400, 401, 408, 413, 415])
async def test_sender_does_not_retry_terminal_status(e2e, clock, status):
    calls = []

    def upstream(request):
        calls.append(request.content)
        return httpx.Response(status)

    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream), base_url="http://gateway.test") as client:
        assert (await e2e.send_with_retry(client, b"fixed", {})).status_code == status
    assert calls == [b"fixed"]
    assert not clock.sleeps


@pytest.mark.parametrize(("retry_after", "delay"), [("0", 1.0), ("2", 2.0), ("999", 60.0), ("invalid", 0.625)])
async def test_retry_after_clamp_and_remaining_deadline(e2e, clock, retry_after, delay):
    calls = []

    def upstream(request):
        calls.append(request.content)
        return httpx.Response(429 if len(calls) == 1 else 204, headers={"Retry-After": retry_after})

    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream), base_url="http://gateway.test") as client:
        result = await e2e.send_with_retry(client, b"fixed", {}, deadline_seconds=3)
    if delay >= 3:
        assert result.status_code == 429
        assert calls == [b"fixed"]
        assert clock.now <= 3
    else:
        assert result.status_code == 204
        assert clock.sleeps == [delay]
        assert calls == [b"fixed", b"fixed"]


@pytest.mark.parametrize("error_type", [httpx.ConnectError, httpx.ReadTimeout])
async def test_sender_network_failure_is_bounded(e2e, clock, error_type):
    calls = []

    def upstream(request):
        calls.append(request.content)
        raise error_type("synthetic transport failure", request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream), base_url="http://gateway.test") as client:
        with pytest.raises(error_type):
            await e2e.send_with_retry(client, b"fixed", {}, max_attempts=99)
    assert calls == [b"fixed"] * 3
    assert clock.sleeps == [0.625, 1.125]


async def test_sender_total_deadline_stops_before_another_attempt(e2e, clock):
    calls = []

    def upstream(request):
        calls.append(request.content)
        clock.now += 0.6
        return httpx.Response(503)

    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream), base_url="http://gateway.test") as client:
        result = await e2e.send_with_retry(client, b"fixed", {}, deadline_seconds=1)
    assert result.status_code == 503
    assert calls == [b"fixed"]
    assert clock.now <= 1


async def test_query_absence_observes_entire_deadline(e2e, clock):
    times = []

    def prometheus(request):
        assert request.url.path == "/api/v1/query"
        assert request.url.params["query"] == 'infrapulse_e2e_value{run_id="unique"}'
        times.append(clock.now)
        return httpx.Response(200, json={"status": "success", "data": {"resultType": "vector", "result": []}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(prometheus), base_url="http://prom.test") as client:
        assert await e2e.query_until(client, 'infrapulse_e2e_value{run_id="unique"}', deadline_seconds=2, expect_present=False) == []
    assert times == [0, 0.5, 1, 1.5]
    assert clock.now == 2


async def test_query_absence_fails_on_late_series(e2e, clock):
    def prometheus(request):
        result = [] if clock.now < 1 else [{"metric": {"run_id": "unique"}, "value": [1800000000, "99"]}]
        return httpx.Response(200, json={"status": "success", "data": {"resultType": "vector", "result": result}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(prometheus), base_url="http://prom.test") as client:
        with pytest.raises(AssertionError):
            await e2e.query_until(client, "metric", deadline_seconds=2, expect_present=False)
    assert clock.now == 1


async def test_query_present_polls_and_times_out(e2e, clock):
    def prometheus(request):
        return httpx.Response(200, json={"status": "success", "data": {"resultType": "vector", "result": []}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(prometheus), base_url="http://prom.test") as client:
        with pytest.raises(AssertionError):
            await e2e.query_until(client, "metric", deadline_seconds=1)
    assert clock.now == 1


async def test_query_returns_actual_vector(e2e, clock):
    vector = [{"metric": {"server_id": "srv-e2e"}, "value": [1800000000, "42.25"]}]

    def prometheus(request):
        return httpx.Response(200, json={"status": "success", "data": {"resultType": "vector", "result": vector if clock.now >= 0.5 else []}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(prometheus), base_url="http://prom.test") as client:
        assert await e2e.query_until(client, "metric") == vector
    assert clock.sleeps == [0.5]


@pytest.mark.parametrize("response", [
    httpx.Response(503),
    httpx.Response(200, json={"status": "error", "error": "synthetic"}),
    httpx.Response(200, json={"status": "success", "data": {"resultType": "matrix", "result": []}}),
])
async def test_query_errors_never_prove_absence(e2e, clock, response):
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: response), base_url="http://prom.test") as client:
        with pytest.raises((AssertionError, httpx.HTTPStatusError)):
            await e2e.query_until(client, "metric", deadline_seconds=1, expect_present=False)
    assert clock.now == 0
