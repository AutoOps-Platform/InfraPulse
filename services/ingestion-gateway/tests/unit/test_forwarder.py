"""Status-only forwarding with real HTTPX request/stream lifecycle behavior."""

import asyncio
from dataclasses import FrozenInstanceError

import httpx
import pytest

from app.errors import ERROR_CODES, GatewayError
from app.forwarder import FORWARD_RESULTS, Forwarder, ForwardResult


class UnreadableStream(httpx.AsyncByteStream):
    """Catch accidental response buffering and missing response cleanup."""

    def __init__(self):
        self.iterated = False
        self.close_calls = 0

    async def __aiter__(self):
        self.iterated = True
        raise AssertionError("upstream-private-body must not be read")
        yield b""  # Make this an async iterator, without ever exposing content.

    async def aclose(self):
        self.close_calls += 1


async def test_headers_bytes_and_one_attempt(settings):
    # Catch payload changes, leaked client defaults/credentials and auth retries.
    calls = []
    payload = b"\x00\xffraw-snappy\x80\x00"
    settings = settings.model_copy(update={
        "prometheus_write_url": "http://upstream.example/custom/write?server-owned=1",
    })

    async def upstream(request):
        calls.append(request)
        return httpx.Response(204)

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(upstream),
        trust_env=False,
        follow_redirects=True,
        headers={
            "Authorization": "Bearer client-private-token",
            "X-Server-ID": "caller-server",
            "X-Agent-ID": "caller-agent",
            "X-Request-ID": "caller-request",
            "X-Arbitrary": "caller-private-value",
            "Content-Type": "text/plain",
            "User-Agent": "caller-agent/1",
        },
        auth=("private-user", "private-password"),
        cookies={"private-cookie": "private-value"},
        params={"caller-query": "private-value"},
    ) as client:
        result = await Forwarder(client, settings).forward(payload)
        assert not client.is_closed
        # Forwarder must not mutate shared client defaults either.
        assert client.headers["X-Server-ID"] == "caller-server"
        assert client.cookies["private-cookie"] == "private-value"

    assert result == ForwardResult(204, "accepted", upstream_status=204)
    assert len(calls) == 1
    request = calls[0]
    assert request.method == "POST"
    assert str(request.url) == "http://upstream.example/custom/write?server-owned=1"
    assert request.content == payload
    assert dict(request.headers) == {
        "host": "upstream.example",
        "content-length": str(len(payload)),
        "content-type": "application/x-protobuf",
        "content-encoding": "snappy",
        "x-prometheus-remote-write-version": "0.1.0",
        "user-agent": "infrapulse-ingestion-gateway/0.1.0",
    }


@pytest.mark.parametrize("configured,expected", [
    ({}, {"connect": 2, "read": 10, "write": 10, "pool": 1}),
    ({"connect_timeout_seconds": 0.2, "read_timeout_seconds": 0.3,
      "write_timeout_seconds": 0.4, "pool_timeout_seconds": 0.1},
     {"connect": 0.2, "read": 0.3, "write": 0.4, "pool": 0.1}),
])
async def test_granular_timeouts_override_shared_client(settings, configured, expected):
    # Catch missing per-attempt timeouts or use of stale client defaults.
    calls = []

    async def upstream(request):
        calls.append(request)
        return httpx.Response(204)

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(upstream), trust_env=False, timeout=99,
    ) as client:
        result = await Forwarder(client, settings.model_copy(update=configured)).forward(b"raw")
    assert result.status_code == 204
    assert len(calls) == 1
    assert calls[0].extensions["timeout"] == expected


@pytest.mark.parametrize("upstream_status,status,result,error", [
    (199, 502, "bad_status", "upstream_bad_status"),
    (200, 204, "accepted", None),
    (202, 204, "accepted", None),
    (204, 204, "accepted", None),
    (206, 204, "accepted", None),
    (299, 204, "accepted", None),
    (300, 502, "bad_status", "upstream_bad_status"),
    (301, 502, "bad_status", "upstream_bad_status"),
    (302, 502, "bad_status", "upstream_bad_status"),
    (307, 502, "bad_status", "upstream_bad_status"),
    (308, 502, "bad_status", "upstream_bad_status"),
    (400, 400, "rejected", "upstream_rejected"),
    (401, 502, "bad_status", "upstream_bad_status"),
    (403, 502, "bad_status", "upstream_bad_status"),
    (404, 502, "bad_status", "upstream_bad_status"),
    (408, 502, "bad_status", "upstream_bad_status"),
    (413, 413, "too_large", "upstream_too_large"),
    (422, 502, "bad_status", "upstream_bad_status"),
    (429, 429, "rate_limited", "upstream_rate_limited"),
    (499, 502, "bad_status", "upstream_bad_status"),
    (500, 503, "unavailable", "upstream_unavailable"),
    (503, 503, "unavailable", "upstream_unavailable"),
    (599, 503, "unavailable", "upstream_unavailable"),
    (600, 502, "bad_status", "upstream_bad_status"),
])
async def test_status_mapping(settings, upstream_status, status, result, error):
    # Catch wrong status ranges, internal retries and following Location.
    calls = []
    body = UnreadableStream()

    async def upstream(request):
        calls.append(request)
        return httpx.Response(
            upstream_status, stream=body,
            headers={"Location": "http://redirect.example/private", "Retry-After": "30"},
        )

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(upstream), trust_env=False, follow_redirects=True,
    ) as client:
        actual = await Forwarder(client, settings).forward(b"test-raw-snappy")
        assert not client.is_closed
    assert actual == ForwardResult(status, result, upstream_status, error,
                                   30 if upstream_status == 429 else None)
    assert actual.result in FORWARD_RESULTS
    assert error is None or error in ERROR_CODES
    assert len(calls) == 1
    assert not body.iterated
    assert body.close_calls == 1


@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
@pytest.mark.parametrize("location", [
    "http://upstream.example:invalid/private?token=private-location-value",
    "http://[::gg]/private?token=private-location-value",
])
async def test_malformed_redirect_is_bad_status(settings, status, location):
    # HTTPX prepares next_request even with redirects disabled; retain status.
    calls = []
    responses = []
    body = UnreadableStream()

    async def upstream(request):
        calls.append(request)
        response = httpx.Response(status, headers={"Location": location}, stream=body)
        responses.append(response)
        return response

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(upstream), trust_env=False, follow_redirects=True,
    ) as client:
        actual = await Forwarder(client, settings).forward(b"raw")
        assert not client.is_closed
    assert len(calls) == 1
    assert not body.iterated
    assert body.close_calls == 1
    assert responses[0].is_closed
    assert "private" not in repr(actual)
    assert actual == ForwardResult(502, "bad_status", status, "upstream_bad_status")


async def test_scoped_redirect_hook_is_registered_once_and_concurrency_safe(settings):
    # Catch duplicate/global/per-call hook mutations and interference with peers.
    calls = []
    responses = []
    request_hook_calls = []
    response_hook_calls = []
    all_entered = asyncio.Event()
    private_location = "http://upstream.example:invalid/private?token=not-a-secret"

    async def existing_request_hook(request):
        request_hook_calls.append(request)

    async def existing_response_hook(response):
        response_hook_calls.append((response.status_code, response.headers.get("Location")))

    async def upstream(request):
        calls.append(request)
        if len(calls) == 3:
            all_entered.set()
        await asyncio.wait_for(all_entered.wait(), 1)
        if request.url.path == "/unmarked":
            status, location = 301, "http://upstream.example/target"
        elif request.content == b"redirect":
            status, location = 307, private_location
        else:
            status, location = 200, private_location
        body = UnreadableStream()
        response = httpx.Response(
            status, headers={"Location": location, "X-Upstream-Other": "unchanged"}, stream=body,
        )
        responses.append((status, response, body))
        return response

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(upstream), trust_env=False, follow_redirects=False,
        event_hooks={"request": [existing_request_hook], "response": [existing_response_hook]},
    ) as client:
        first = Forwarder(client, settings)
        registered = tuple(client.event_hooks["response"])
        assert len(registered) == 2  # Existing hook plus one permanent scoped hook.
        assert registered[0] is existing_response_hook
        second = Forwarder(client, settings)
        assert tuple(client.event_hooks["response"]) == registered
        assert client.event_hooks["request"] == [existing_request_hook]

        rejected, accepted, unmarked = await asyncio.wait_for(asyncio.gather(
            first.forward(b"redirect"),
            second.forward(b"accepted"),
            client.send(httpx.Request("GET", "http://upstream.example/unmarked"),
                        stream=True, follow_redirects=False),
        ), 2)
        try:
            assert rejected == ForwardResult(502, "bad_status", 307, "upstream_bad_status")
            assert accepted == ForwardResult(204, "accepted", 200)
            assert unmarked.status_code == 301
            assert unmarked.headers["Location"] == "http://upstream.example/target"
            assert unmarked.next_request.url == httpx.URL("http://upstream.example/target")
            assert tuple(client.event_hooks["response"]) == registered
            assert client.event_hooks["request"] == [existing_request_hook]
            assert not client.is_closed
        finally:
            await unmarked.aclose()

    assert len(calls) == len(request_hook_calls) == len(response_hook_calls) == 3
    assert set(response_hook_calls) == {
        (301, "http://upstream.example/target"), (307, private_location), (200, private_location),
    }
    for status, response, body in responses:
        assert response.headers["X-Upstream-Other"] == "unchanged"
        if status == 307:
            assert "Location" not in response.headers
        elif status == 200:
            assert response.headers["Location"] == private_location
        assert response.is_closed
        assert not body.iterated
        assert body.close_calls == 1


@pytest.mark.parametrize("value,expected", [
    (None, 1), ("1", 1), ("2", 2), ("60", 60), ("0", 1), ("61", 1),
    ("-1", 1), ("+2", 1), ("garbage", 1), ("", 1), ("1.0", 1),
    ("1e1", 1), (" 2", 1), ("2 ", 1), ("2, 3", 1),
    ("Wed, 21 Oct 2026 07:28:00 GMT", 1),
    ("01", 1), ("060", 60), ("9" * 5000, 1),
    (b"\xb2", 1), (b"\xa02", 1), (b"2\r\nX-Private: value", 1),
])
async def test_retry_after_is_bounded(value, expected, settings):
    # Catch unbounded integer conversion, HTTP-date parsing or arbitrary echoing.
    calls = []

    async def upstream(request):
        calls.append(request)
        headers = {} if value is None else {"Retry-After": value}
        return httpx.Response(429, headers=headers, stream=UnreadableStream())

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(upstream), trust_env=False,
    ) as client:
        result = await Forwarder(client, settings).forward(b"test-raw-snappy")
    assert result == ForwardResult(429, "rate_limited", 429, "upstream_rate_limited", expected)
    assert isinstance(result.retry_after, int)
    assert len(calls) == 1


@pytest.mark.parametrize("values", [["2", "3"], ["2", "2"], ["", "60"]])
async def test_duplicate_retry_after_falls_back(settings, values):
    calls = []

    async def upstream(request):
        calls.append(request)
        return httpx.Response(429, headers=[("Retry-After", value) for value in values])

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(upstream), trust_env=False,
    ) as client:
        result = await Forwarder(client, settings).forward(b"raw")
    assert result.retry_after == 1
    assert len(calls) == 1


@pytest.mark.parametrize("exception,status,result,error", [
    (httpx.ConnectTimeout, 504, "timeout", "upstream_timeout"),
    (httpx.ReadTimeout, 504, "timeout", "upstream_timeout"),
    (httpx.WriteTimeout, 504, "timeout", "upstream_timeout"),
    (httpx.PoolTimeout, 504, "timeout", "upstream_timeout"),
    (httpx.NetworkError, 503, "unavailable", "upstream_unavailable"),
    (httpx.ConnectError, 503, "unavailable", "upstream_unavailable"),
    (httpx.ReadError, 503, "unavailable", "upstream_unavailable"),
    (httpx.WriteError, 503, "unavailable", "upstream_unavailable"),
    (httpx.CloseError, 503, "unavailable", "upstream_unavailable"),
    (httpx.RemoteProtocolError, 503, "unavailable", "upstream_unavailable"),
])
async def test_timeout_and_network_mapping(settings, exception, status, result, error):
    # Catch raw exception leakage, timeout subclass ordering and retries.
    calls = []

    async def upstream(request):
        calls.append(request)
        raise exception("private-exception-text http://private.example?token=secret", request=request)

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(upstream), trust_env=False,
    ) as client:
        actual = await Forwarder(client, settings).forward(b"raw")
        assert not client.is_closed
    assert actual == ForwardResult(status, result, error_code=error)
    assert "private" not in repr(actual)
    assert len(calls) == 1


async def test_total_deadline(settings):
    # MockTransport does not enforce HTTPX timeouts: a real outer deadline must.
    calls = []
    entered = asyncio.Event()
    transport_cancelled = asyncio.Event()
    never = asyncio.Event()
    settings = settings.model_copy(update={"upstream_deadline_seconds": 0.05})

    async def upstream(request):
        calls.append(request)
        entered.set()
        try:
            await never.wait()
        finally:
            transport_cancelled.set()

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(upstream), trust_env=False,
    ) as client:
        loop = asyncio.get_running_loop()
        started = loop.time()
        task = asyncio.create_task(Forwarder(client, settings).forward(b"raw"))
        try:
            await asyncio.wait_for(entered.wait(), 1)
            result = await asyncio.wait_for(task, 1)
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        assert loop.time() - started < 1
        assert not client.is_closed
    assert result == ForwardResult(504, "timeout", error_code="upstream_timeout")
    assert transport_cancelled.is_set()
    assert len(calls) == 1


@pytest.mark.parametrize("status", [200, 204, 400, 413, 429, 503, 307, 401])
async def test_upstream_body_not_read(settings, status):
    # Catch buffered client.post(), .aread(), .text and unclosed status branches.
    calls = []
    responses = []
    body = UnreadableStream()

    async def upstream(request):
        calls.append(request)
        response = httpx.Response(status, stream=body)
        responses.append(response)
        return response

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(upstream), trust_env=False,
    ) as client:
        await Forwarder(client, settings).forward(b"raw")
        assert responses[0].is_closed
        assert not client.is_closed
    assert not body.iterated
    assert body.close_calls == 1
    assert len(calls) == 1


async def test_caller_cancellation_propagates_during_send(settings):
    # Catch swallowed cancellation, conversion to 504 and orphaned attempts.
    calls = []
    entered = asyncio.Event()
    cancelled = asyncio.Event()
    never = asyncio.Event()

    async def upstream(request):
        calls.append(request)
        entered.set()
        try:
            await never.wait()
        finally:
            cancelled.set()

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(upstream), trust_env=False,
    ) as client:
        task = asyncio.create_task(Forwarder(client, settings).forward(b"raw"))
        try:
            await asyncio.wait_for(entered.wait(), 1)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(task, 1)
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        assert not client.is_closed
    assert cancelled.is_set()
    assert len(calls) == 1


@pytest.mark.parametrize("cancel_by_deadline", [False, True])
async def test_response_cleanup_is_inside_total_deadline(settings, cancel_by_deadline):
    # Catch response leaks or a deadline that excludes streaming-response close.
    calls = []
    responses = []
    close_entered = asyncio.Event()
    close_cancelled = asyncio.Event()
    never = asyncio.Event()

    class BlockingCloseStream(UnreadableStream):
        async def aclose(self):
            self.close_calls += 1
            close_entered.set()
            try:
                await never.wait()
            finally:
                close_cancelled.set()

    body = BlockingCloseStream()
    if cancel_by_deadline:
        settings = settings.model_copy(update={"upstream_deadline_seconds": 0.05})

    async def upstream(request):
        calls.append(request)
        response = httpx.Response(204, stream=body)
        responses.append(response)
        return response

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(upstream), trust_env=False,
    ) as client:
        task = asyncio.create_task(Forwarder(client, settings).forward(b"raw"))
        try:
            await asyncio.wait_for(close_entered.wait(), 1)
            if cancel_by_deadline:
                actual = await asyncio.wait_for(task, 1)
                assert actual == ForwardResult(504, "timeout", error_code="upstream_timeout")
            else:
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await asyncio.wait_for(task, 1)
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        assert not client.is_closed
    assert close_cancelled.is_set()
    assert responses[0].is_closed
    assert body.close_calls == 1
    assert not body.iterated
    assert len(calls) == 1


@pytest.mark.parametrize("exception", [RuntimeError, httpx.HTTPError])
async def test_unexpected_errors_are_sanitized(settings, exception):
    # Catch arbitrary exception text/URL crossing the public error boundary.
    calls = []

    async def upstream(request):
        calls.append(request)
        raise exception("private-exception http://private.example/?token=secret")

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(upstream), trust_env=False,
    ) as client:
        with pytest.raises(GatewayError) as raised:
            await Forwarder(client, settings).forward(b"raw")
        assert not client.is_closed
    assert raised.value.status_code == 500
    assert raised.value.code == "internal_error"
    assert raised.value.message == "An internal gateway error occurred."
    assert raised.value.retry_after is None
    assert raised.value.__suppress_context__
    assert "private" not in str(raised.value)
    assert len(calls) == 1


async def test_close_failure_is_sanitized_and_does_not_retry(settings):
    calls = []
    responses = []

    class FailingCloseStream(UnreadableStream):
        async def aclose(self):
            self.close_calls += 1
            raise RuntimeError("private-close-exception")

    body = FailingCloseStream()

    async def upstream(request):
        calls.append(request)
        response = httpx.Response(204, stream=body)
        responses.append(response)
        return response

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(upstream), trust_env=False,
    ) as client:
        with pytest.raises(GatewayError) as raised:
            await Forwarder(client, settings).forward(b"raw")
    assert raised.value.status_code == 500
    assert raised.value.code == "internal_error"
    assert str(raised.value) == "An internal gateway error occurred."
    assert responses[0].is_closed
    assert body.close_calls == 1
    assert not body.iterated
    assert len(calls) == 1


def test_result_contract_is_frozen_and_finite():
    result = ForwardResult(204, "accepted")
    assert result.upstream_status is None
    assert result.error_code is None
    assert result.retry_after is None
    with pytest.raises(FrozenInstanceError):
        result.status_code = 500
    assert FORWARD_RESULTS == {
        "accepted", "rejected", "too_large", "rate_limited", "unavailable", "timeout", "bad_status",
    }
