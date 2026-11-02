"""Parse raw ASGI headers without authenticating self-declared identities."""

from dataclasses import dataclass, field
import re

from app.errors import GatewayError


_ID = re.compile(rb"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}")
_AUTHORIZATION = re.compile(rb"(?i:Bearer) +([^\x00-\x20\x7f-\x9f]+)")
_CONTENT_TYPE = re.compile(
    rb'(?i:application/x-protobuf)(?:[ \t]*;[ \t]*(?i:proto)[ \t]*=[ \t]*(?:prometheus\.WriteRequest|"prometheus\.WriteRequest"))?'
)
_CONTROL = re.compile(rb"[\x00-\x08\x0a-\x1f\x7f-\x9f]")


@dataclass(frozen=True)
class Identity:
    server_id: str
    agent_id: str


@dataclass(frozen=True)
class IngestHeaders:
    api_key: str = field(repr=False)
    server_id: str | None
    agent_id: str | None


def parse_ingest_headers(raw_headers: list[tuple[bytes, bytes]]) -> IngestHeaders:
    # Retain every occurrence. A normal header map would hide duplicates.
    values: dict[bytes, list[bytes]] = {}
    for name, value in raw_headers:
        values.setdefault(name.lower(), []).append(value)

    def single(name: bytes, status: int, code: str) -> bytes:
        entries = values.get(name, [])
        if len(entries) != 1:
            raise GatewayError(status, code)
        return entries[0].strip(b" \t")

    authorization = single(b"authorization", 401, "invalid_authorization")
    match = _AUTHORIZATION.fullmatch(authorization)
    if match is None or len(match[1]) > 4096 or not match[1].isascii():
        raise GatewayError(401, "invalid_authorization")

    ids = []
    for name in (b"x-server-id", b"x-agent-id"):
        if name not in values:
            ids.append(None)
            continue
        value = single(name, 400, "invalid_identity")
        if _ID.fullmatch(value) is None:
            raise GatewayError(400, "invalid_identity")
        ids.append(value.decode("ascii"))

    content_type = single(b"content-type", 415, "unsupported_media")
    if _CONTENT_TYPE.fullmatch(content_type) is None:
        raise GatewayError(415, "unsupported_media")
    if single(b"content-encoding", 415, "unsupported_media").lower() != b"snappy":
        raise GatewayError(415, "unsupported_media")
    if single(b"x-prometheus-remote-write-version", 415, "unsupported_media") != b"0.1.0":
        raise GatewayError(415, "unsupported_media")

    user_agent = single(b"user-agent", 400, "invalid_protocol_header")
    if not user_agent or len(user_agent) > 256 or _CONTROL.search(user_agent):
        raise GatewayError(400, "invalid_protocol_header")

    if b"content-length" in values:
        length = single(b"content-length", 400, "invalid_content_length")
        if re.fullmatch(rb"[0-9]+", length) is None:
            raise GatewayError(400, "invalid_content_length")

    return IngestHeaders(match[1].decode('ascii'), *ids)
