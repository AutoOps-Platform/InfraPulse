"""Admission must be atomic, no-queue, and charge tokens only with a slot."""

import pytest

from app.errors import GatewayError
from app.pipeline import AdmissionController


def test_token_bucket_refill(settings):
    now = [0.0]
    admission = AdmissionController(settings, monotonic=lambda: now[0])
    for _ in range(20):
        admission.acquire().release()
    with pytest.raises(GatewayError) as failure:
        admission.acquire()
    assert (failure.value.status_code, failure.value.code, failure.value.retry_after) == (
        429, "rate_limited", 1,
    )
    now[0] += 0.1
    admission.acquire().release()
    with pytest.raises(GatewayError):
        admission.acquire()


def test_max_inflight(settings):
    admission = AdmissionController(settings, monotonic=lambda: 0.0)
    first, second = admission.acquire(), admission.acquire()
    for _ in range(30):
        with pytest.raises(GatewayError) as failure:
            admission.acquire()
        assert (failure.value.status_code, failure.value.code, failure.value.retry_after) == (
            429, "concurrency_limited", 1,
        )
    first.release()
    second.release()
    # Rejected requests must not consume any of the remaining 18 tokens.
    for _ in range(18):
        admission.acquire().release()
    with pytest.raises(GatewayError) as failure:
        admission.acquire()
    assert failure.value.code == "rate_limited"


def test_release_idempotent(settings):
    admission = AdmissionController(settings, monotonic=lambda: 0.0)
    lease = admission.acquire()
    lease.release()
    lease.release()
    first, second = admission.acquire(), admission.acquire()
    with pytest.raises(GatewayError):
        admission.acquire()
    first.release()
    second.release()
    assert admission.inflight == 0


def test_refill_is_capped_at_burst(settings):
    now = [0.0]
    admission = AdmissionController(settings, monotonic=lambda: now[0])
    now[0] = 1000.0
    for _ in range(20):
        admission.acquire().release()
    with pytest.raises(GatewayError):
        admission.acquire()
