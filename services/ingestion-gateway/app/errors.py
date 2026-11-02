"""Finite public errors shared by pure validation and later HTTP adapters."""

from types import MappingProxyType


ERROR_MESSAGES = MappingProxyType({
    "invalid_authorization": "A valid Bearer authorization header is required.",
    "invalid_identity": "A supplied identity header is invalid.",
    "identity_mismatch": "Supplied identity does not match the verified credential.",
    "unsupported_media": "The media type, encoding, or protocol version is unsupported.",
    "invalid_protocol_header": "A required protocol header is invalid.",
    "invalid_content_length": "Content-Length is invalid.",
    "empty_body": "The request body is empty.",
    "invalid_snappy": "The Snappy payload is invalid.",
    "invalid_protobuf": "The Protobuf payload is invalid.",
    "unsupported_fields": "The payload contains unsupported fields.",
    "empty_write": "The write request contains no series.",
    "empty_series": "A series contains no samples.",
    "invalid_labels": "The series labels are invalid.",
    "identity_conflict": "Series identity labels conflict with request identity.",
    "duplicate_series": "The request contains duplicate series.",
    "invalid_timestamp": "A sample timestamp is invalid.",
    "payload_too_large": "The payload exceeds a byte limit.",
    "too_many_series": "The request contains too many series.",
    "too_many_samples": "The request contains too many samples.",
    "body_timeout": "The request body read deadline was exceeded.",
    "rate_limited": "The request rate limit was exceeded.",
    "concurrency_limited": "All ingestion slots are occupied.",
    "upstream_rejected": "The upstream rejected the samples.",
    "upstream_too_large": "The upstream rejected the payload size.",
    "upstream_rate_limited": "The upstream rate limit was exceeded.",
    "upstream_unavailable": "The upstream is unavailable.",
    "credential_verification_unavailable": "Credential verification is unavailable.",
    "upstream_timeout": "The upstream deadline or timeout was exceeded.",
    "upstream_bad_status": "The upstream returned an unsupported status.",
    "internal_error": "An internal gateway error occurred.",
})
ERROR_CODES = frozenset(ERROR_MESSAGES)


class GatewayError(Exception):
    def __init__(self, status_code: int, code: str, *, retry_after: int | None = None):
        if code not in ERROR_CODES:
            raise ValueError("Unknown gateway error code")
        self.status_code = status_code
        self.code = code
        self.retry_after = retry_after
        self.message = ERROR_MESSAGES[code]
        super().__init__(self.message)
