"""Opt-in lab tests. Collection never opens a connection or reads runtime data.

Retries belong only to this sender. No Compose lifecycle, sample deletion or
production retry changes are performed here. Console evidence is allowlisted.
"""

from asyncio import sleep, timeout
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
from random import uniform
from time import monotonic, time
from uuid import UUID, uuid4
import re

import cramjam
import httpx
import pytest

from app.proto.remote_write_pb2 import WriteRequest


pytestmark = pytest.mark.e2e


@pytest.fixture(autouse=True)
def require_opt_in():
    if os.environ.get("INFRAPULSE_RUN_E2E") != "1":
        pytest.skip("Set INFRAPULSE_RUN_E2E=1 to send traffic to the running lab")


async def send_with_retry(
    client: httpx.AsyncClient, payload: bytes, headers: dict[str, str], *,
    max_attempts: int = 3, deadline_seconds: float = 20.0,
) -> httpx.Response:
    """Send identical bytes at most three times, inside a total sender deadline."""
    assert max_attempts >= 1 and math.isfinite(deadline_seconds) and deadline_seconds > 0
    end = monotonic() + min(deadline_seconds, 20.0)
    attempts = min(max_attempts, 3)
    response = None
    failure = None
    for attempt in range(attempts):
        remaining = end - monotonic()
        if remaining <= 0:
            break
        try:
            async with timeout(remaining):
                response = await client.post(
                    "/api/v1/ingest/remote-write", content=payload, headers=headers,
                    timeout=remaining,
                )
            failure = None
            if response.status_code != 429 and not 500 <= response.status_code <= 599:
                return response
        except (httpx.TransportError, TimeoutError) as error:
            failure = error
            response = None
        if attempt + 1 == attempts:
            break
        delay = 0.5 * (2 ** attempt) + uniform(0.0, 0.25)
        if response is not None and response.status_code == 429:
            try:
                seconds = float(response.headers["Retry-After"])
                if math.isfinite(seconds):
                    delay = min(60.0, max(1.0, seconds))
            except (KeyError, ValueError):
                pass
        if delay >= end - monotonic():
            break
        await sleep(delay)
    if failure is not None:
        raise failure
    if response is not None:
        return response
    raise TimeoutError("E2E sender deadline exhausted")


async def query_until(
    client: httpx.AsyncClient, promql: str, *, deadline_seconds: float = 30.0,
    expect_present: bool = True,
) -> list[dict[str, object]]:
    """Require successful vector responses; absence needs the entire deadline."""
    assert math.isfinite(deadline_seconds) and deadline_seconds > 0
    end = monotonic() + deadline_seconds
    while monotonic() < end:
        remaining = end - monotonic()
        async with timeout(remaining):
            response = await client.get(
                "/api/v1/query", params={"query": promql}, timeout=min(5.0, remaining),
            )
        response.raise_for_status()
        body = response.json()
        assert body.get("status") == "success", "Prometheus query did not succeed"
        data = body.get("data", {})
        assert data.get("resultType") == "vector", "Expected an instant vector"
        result = data.get("result")
        assert isinstance(result, list) and all(isinstance(row, dict) for row in result)
        if result:
            assert expect_present, "Rejected sample unexpectedly exists in Prometheus"
            return result
        remaining = end - monotonic()
        if remaining > 0:
            await sleep(min(0.5, remaining))
    assert not expect_present, "Sample not visible before query deadline"
    return []


@pytest.fixture
def protocol_headers():
    # The parent isolated fixture issues this real credential over signed Admin
    # HTTP. Only a private file PATH is passed through the environment/argv.
    # Never print file contents or credential-bearing assertion diagnostics.
    try:
        fixture = json.loads(Path(os.environ['E2E_CREDENTIAL_FILE']).read_text(encoding='utf-8'))
        key, server, agent = fixture['api_key'], fixture['server_id'], fixture['agent_id']
        if (not isinstance(key, str) or re.fullmatch(r'[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}', key) is None
                or str(UUID(key.split('.')[0])) != key.split('.')[0]
                or str(UUID(server)) != server or str(UUID(agent)) != agent):
            raise ValueError()
    except Exception:
        raise RuntimeError('A valid parent-issued private E2E credential fixture is required') from None
    return {
        "Authorization": "Bearer " + key,
        "X-Server-ID": server, "X-Agent-ID": agent,
        "Content-Type": "application/x-protobuf", "Content-Encoding": "snappy",
        "X-Prometheus-Remote-Write-Version": "0.1.0",
        "User-Agent": "infrapulse-e2e/0.1.0",
    }


@pytest.fixture
async def clients(require_opt_in):
    async with httpx.AsyncClient(
        base_url=os.environ.get("E2E_GATEWAY_URL", "http://ingest:8000"),
        trust_env=False, follow_redirects=False, timeout=10,
    ) as gateway, httpx.AsyncClient(
        base_url=os.environ.get("E2E_PROMETHEUS_URL", "http://prometheus:9090"),
        trust_env=False, follow_redirects=False, timeout=5,
    ) as prometheus:
        yield gateway, prometheus


def _payload(run_id: str, value: float, timestamp_ms: int, *, identity: str, ids: dict[str, str]) -> bytes:
    message = WriteRequest()
    series = message.timeseries.add()
    labels = [("__name__", "infrapulse_e2e_value"), ("run_id", run_id)]
    if identity != "missing":
        labels += [("server_id", str(uuid4()) if identity == "conflict" else ids['X-Server-ID']),
                   ("agent_id", ids['X-Agent-ID'])]
    for name, value_text in sorted(labels):
        series.labels.add(name=name, value=value_text)
    series.samples.add(value=value, timestamp=timestamp_ms)
    return bytes(cramjam.snappy.compress_raw(message.SerializeToString()))


def _query(run_id: str) -> str:
    return 'infrapulse_e2e_value{run_id="' + run_id + '"}'


async def _assert_visible(prometheus, run_id, value, timestamp_ms, case, ids):
    result = await query_until(prometheus, _query(run_id))
    assert len(result) == 1
    labels = result[0]["metric"]
    assert labels == {"__name__": "infrapulse_e2e_value", "run_id": run_id,
                      "server_id": ids['X-Server-ID'], "agent_id": ids['X-Agent-ID']}
    assert float(result[0]["value"][1]) == value
    # Instant-vector value[0] is evaluation time, not the stored sample timestamp.
    timestamp_result = await query_until(prometheus, "timestamp(" + _query(run_id) + ")")
    assert len(timestamp_result) == 1
    assert float(timestamp_result[0]["value"][1]) == pytest.approx(timestamp_ms / 1000, abs=0.0001, rel=0)
    print(json.dumps({"event": "E2E_VISIBLE", "case": case, "run_id": run_id,
                      "value": value, "server_id": ids['X-Server-ID'], "agent_id": ids['X-Agent-ID'],
                      "sample_timestamp_ms": timestamp_ms,
                      "observed_at": datetime.now(timezone.utc).isoformat()}), flush=True)


async def test_scalar_fixture_is_wire_compatible(clients, protocol_headers):
    wire = bytes.fromhex((Path(__file__).parents[1] / "fixtures" / "remote_write_scalar.hex").read_text(encoding="utf-8"))
    # Independently hand-derived field values, not the production codec as oracle.
    message = WriteRequest.FromString(wire)
    assert len(message.timeseries) == 1
    series = message.timeseries[0]
    assert [(label.name, label.value) for label in series.labels] == [("__name__", "up")]
    assert [(sample.value, sample.timestamp) for sample in series.samples] == [(1.0, 1000)]
    run_id, timestamp_ms = str(uuid4()), int(time() * 1000)
    series.labels[0].value = "infrapulse_e2e_value"
    series.labels.add(name="run_id", value=run_id)
    series.samples[0].timestamp = timestamp_ms
    gateway, prometheus = clients
    result = await send_with_retry(gateway, bytes(cramjam.snappy.compress_raw(message.SerializeToString())), protocol_headers)
    assert result.status_code == 204
    await _assert_visible(prometheus, run_id, 1.0, timestamp_ms, "independent_wire", protocol_headers)


async def test_missing_identity_labels_visible(clients, protocol_headers):
    run_id, timestamp_ms = str(uuid4()), int(time() * 1000)
    gateway, prometheus = clients
    without_claims = {key: value for key, value in protocol_headers.items() if key not in {'X-Server-ID', 'X-Agent-ID'}}
    response = await send_with_retry(gateway, _payload(run_id, 42.25, timestamp_ms, identity="missing", ids=protocol_headers), without_claims)
    assert response.status_code == 204
    await _assert_visible(prometheus, run_id, 42.25, timestamp_ms, "missing_ids", protocol_headers)


async def test_matching_labels_visible(clients, protocol_headers):
    run_id, timestamp_ms = str(uuid4()), int(time() * 1000)
    gateway, prometheus = clients
    response = await send_with_retry(gateway, _payload(run_id, 43.25, timestamp_ms, identity="matching", ids=protocol_headers), protocol_headers)
    assert response.status_code == 204
    await _assert_visible(prometheus, run_id, 43.25, timestamp_ms, "matching_ids", protocol_headers)


async def test_conflict_is_not_written(clients, protocol_headers):
    run_id, timestamp_ms = str(uuid4()), int(time() * 1000)
    gateway, prometheus = clients
    response = await send_with_retry(gateway, _payload(run_id, 99.0, timestamp_ms, identity="conflict", ids=protocol_headers), protocol_headers)
    assert response.status_code == 400
    assert await query_until(prometheus, _query(run_id), expect_present=False) == []
    print(json.dumps({"event": "E2E_REJECTED", "run_id": run_id, "value": 99.0,
                      "sample_timestamp_ms": timestamp_ms, "absence_seconds": 30}), flush=True)


async def test_gateway_scrape_up(clients):
    _, prometheus = clients
    result = await query_until(prometheus, 'up{job="ingestion-gateway"} == 1', deadline_seconds=90)
    assert len(result) == 1
    assert result[0]["metric"]["instance"] == "ingest:8000"
    assert float(result[0]["value"][1]) == 1.0
    print(json.dumps({"event": "E2E_SCRAPE", "job": "ingestion-gateway", "value": 1}), flush=True)
