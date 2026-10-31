"""Exercise raw headers: duplicates must not disappear into a header dict."""

from dataclasses import FrozenInstanceError

import pytest

from app.identity import Identity, parse_ingest_headers
from app.errors import ERROR_CODES, ERROR_MESSAGES, GatewayError


REQUIRED = [
    (b"authorization", 401, "invalid_authorization"),
    (b"x-server-id", 400, "invalid_identity"),
    (b"x-agent-id", 400, "invalid_identity"),
    (b"content-type", 415, "unsupported_media"),
    (b"content-encoding", 415, "unsupported_media"),
    (b"x-prometheus-remote-write-version", 415, "unsupported_media"),
    (b"user-agent", 400, "invalid_protocol_header"),
]
EXPECTED_CODES = {
    "invalid_authorization", "invalid_identity", "unsupported_media",
    "invalid_protocol_header", "invalid_content_length", "empty_body",
    "invalid_snappy", "invalid_protobuf", "unsupported_fields", "empty_write",
    "empty_series", "invalid_labels", "identity_conflict", "duplicate_series",
    "invalid_timestamp", "payload_too_large", "too_many_series", "too_many_samples",
    "body_timeout", "rate_limited", "concurrency_limited", "upstream_rejected",
    "upstream_too_large", "upstream_rate_limited", "upstream_unavailable",
    "upstream_timeout", "upstream_bad_status", "internal_error",
}


def replacing(headers, name, value):
    result = [(key, old) for key, old in headers if key.lower() != name]
    if value is not None:
        result.append((name, value))
    return result


def assert_rejected(headers, status, code):
    with pytest.raises(GatewayError) as caught:
        parse_ingest_headers(headers)
    error = caught.value
    assert error.status_code == status
    assert error.code == code
    assert error.code in ERROR_CODES
    assert str(error) == ERROR_MESSAGES[error.code]


def test_nonempty_arbitrary_token_is_not_authenticated(headers):
    identity = parse_ingest_headers(headers)
    assert (identity.server_id, identity.agent_id) == ("srv-lab", "agent-lab")
    assert not hasattr(identity, "token")


def test_identity_is_frozen_and_parser_does_not_mutate_headers(headers):
    original = headers.copy()
    identity = parse_ingest_headers(headers)
    assert headers == original
    assert identity == Identity("srv-lab", "agent-lab")
    with pytest.raises(FrozenInstanceError):
        identity.server_id = "other"


@pytest.mark.parametrize("name", [b"x-server-id", b"x-agent-id"])
@pytest.mark.parametrize("value,accepted", [
    (b"a", True), (b"Z" * 128, True), (b"a_.:-09", True),
    (b"", False), (b"a" * 129, False), ("máy".encode(), False),
    (b"a b", False), (b"-a", False), (b"a/b", False),
    (b"a\x00", False), (b"a\r\n", False), (None, False),
])
def test_id_boundaries(headers, name, value, accepted):
    raw = replacing(headers, name, value)
    if accepted:
        identity = parse_ingest_headers(raw)
        field = "server_id" if name == b"x-server-id" else "agent_id"
        assert getattr(identity, field) == value.decode("ascii")
    else:
        assert_rejected(raw, 400, "invalid_identity")


@pytest.mark.parametrize("value,accepted", [
    (b"Bearer anything", True), (b"bearer different-arbitrary-token", True),
    (b"bEaReR " + b"x" * 4096, True),
    (None, False), (b"", False), (b"Bearer", False), (b"Bearer ", False),
    (b"Basic token", False), (b"Bearertoken", False),
    (b"Bearer two tokens", False), (b"Bearer a\tb", False),
    (b"Bearer a\x00b", False), (b"Bearer a\x7fb", False),
    (b"Bearer a\r\nb", False), (b"Bearer " + b"x" * 4097, False),
])
def test_authorization_contract(headers, value, accepted):
    raw = replacing(headers, b"authorization", value)
    if accepted:
        assert parse_ingest_headers(raw) == Identity("srv-lab", "agent-lab")
    else:
        assert_rejected(raw, 401, "invalid_authorization")


@pytest.mark.parametrize("name,status,code", REQUIRED)
def test_duplicate_protocol_headers(headers, name, status, code):
    value = next(value for key, value in headers if key == name)
    assert_rejected(headers + [(name.upper(), value)], status, code)


@pytest.mark.parametrize("name,status,code", REQUIRED)
def test_required_header_missing(headers, name, status, code):
    assert_rejected(replacing(headers, name, None), status, code)


@pytest.mark.parametrize("name,value,accepted", [
    (b"content-type", b"application/x-protobuf", True),
    (b"content-type", b"application/x-protobuf; proto=prometheus.WriteRequest", True),
    (b"content-type", b'application/x-protobuf; proto="prometheus.WriteRequest"', True),
    (b"content-type", b"Application/X-Protobuf; PROTO=prometheus.WriteRequest", True),
    (b"content-type", b"application/x-protobuf; proto=io.prometheus.write.v2.Request", False),
    (b"content-type", b"application/x-protobuf; charset=utf-8", False),
    (b"content-type", b"application/x-protobuf; proto=prometheus.WriteRequest; proto=prometheus.WriteRequest", False),
    (b"content-type", b"application/x-protobuf;", False),
    (b"content-type", b"application/json", False),
    (b"content-type", b"application/x-protobuf, application/x-protobuf", False),
    (b"content-encoding", b"Snappy", True),
    (b"content-encoding", b"snappy,gzip", False),
    (b"content-encoding", b"snappy, snappy", False),
    (b"content-encoding", b"gzip", False),
    (b"content-encoding", b"snappy-framed", False),
    (b"x-prometheus-remote-write-version", b"0.1.0", True),
    (b"x-prometheus-remote-write-version", b"1.0.0", False),
    (b"x-prometheus-remote-write-version", b"2.0.0", False),
])
def test_media_contract(headers, name, value, accepted):
    raw = replacing(headers, name, value)
    if accepted:
        assert parse_ingest_headers(raw) == Identity("srv-lab", "agent-lab")
    else:
        assert_rejected(raw, 415, "unsupported_media")


@pytest.mark.parametrize("value,accepted", [
    (b"a", True), (b"a" * 256, True), (b"a" * 257, False),
    (None, False), (b"", False), (b" \t ", False), (b"a\x00b", False),
])
def test_user_agent_bounds(headers, value, accepted):
    raw = replacing(headers, b"user-agent", value)
    if accepted:
        assert parse_ingest_headers(raw) == Identity("srv-lab", "agent-lab")
    else:
        assert_rejected(raw, 400, "invalid_protocol_header")


def test_header_names_ignore_case_and_values_strip_only_ows(headers):
    raw = [(name.upper(), b" \t" + value + b"\t ") for name, value in headers]
    assert parse_ingest_headers(raw) == Identity("srv-lab", "agent-lab")


@pytest.mark.parametrize("value", [b"", b"+1", b"-1", b"1.0", b"1,1", b"1 2", b"\xff", b"1\n"])
def test_content_length_must_be_single_decimal(headers, value):
    assert_rejected(headers + [(b"content-length", value)], 400, "invalid_content_length")


@pytest.mark.parametrize("second", [b"1", b"2"])
def test_duplicate_content_length_is_rejected(headers, second):
    assert_rejected(headers + [(b"content-length", b"1"), (b"Content-Length", second)], 400, "invalid_content_length")


@pytest.mark.parametrize("value", [b"0", b"123", b" \t123\t "])
def test_content_length_syntax_is_not_a_body_length_guarantee(headers, value):
    assert parse_ingest_headers(headers + [(b"content-length", value)]) == Identity("srv-lab", "agent-lab")


def test_unknown_headers_do_not_replace_identity(headers):
    raw = headers + [(b"host", b"some-other-host"), (b"x-request-id", b"untrusted")]
    assert parse_ingest_headers(raw) == Identity("srv-lab", "agent-lab")


def test_error_codes_and_messages_are_finite():
    assert set(ERROR_CODES) == EXPECTED_CODES
    assert set(ERROR_MESSAGES) == EXPECTED_CODES
    for code in ERROR_CODES:
        error = GatewayError(400, code, retry_after=2)
        assert (error.status_code, error.code, error.retry_after) == (400, code, 2)
        assert error.message == ERROR_MESSAGES[code]
        assert str(error) == ERROR_MESSAGES[code]
        assert error.message


def test_error_cannot_accept_untrusted_public_message():
    with pytest.raises(ValueError):
        GatewayError(500, "secret-request-value")
    with pytest.raises(TypeError):
        GatewayError(500, "internal_error", message="secret-request-value")


def test_invalid_identity_is_not_echoed(headers):
    assert_rejected(replacing(headers, b"x-server-id", b"sensitive input"), 400, "invalid_identity")
    with pytest.raises(GatewayError) as caught:
        parse_ingest_headers(replacing(headers, b"authorization", b"Basic sensitive input"))
    assert "sensitive" not in str(caught.value)
    assert "sensitive" not in repr(caught.value)
