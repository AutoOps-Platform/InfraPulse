"""Bounded raw Snappy / Remote Write scalar-subset Protobuf transport codec."""

import cramjam
from google.protobuf.message import DecodeError

from app.config import Settings
from app.errors import GatewayError
from app.proto import remote_write_pb2


def decode_write(compressed: bytes, settings: Settings) -> remote_write_pb2.WriteRequest:
    if len(compressed) > settings.max_compressed_bytes:
        raise GatewayError(413, "payload_too_large")
    if not compressed:
        raise GatewayError(400, "empty_body")

    try:
        declared_length = cramjam.snappy.decompress_raw_len(compressed)
    except cramjam.DecompressionError:
        raise GatewayError(400, "invalid_snappy") from None
    # The untrusted length must be capped BEFORE allocating the output buffer.
    if declared_length > settings.max_decompressed_bytes:
        raise GatewayError(413, "payload_too_large")
    if declared_length == 0:
        raise GatewayError(400, "empty_write")

    raw = bytearray(declared_length)
    try:
        written = cramjam.snappy.decompress_raw_into(compressed, raw)
    except cramjam.DecompressionError:
        raise GatewayError(400, "invalid_snappy") from None
    if written != declared_length:
        raise GatewayError(400, "invalid_snappy")

    message = remote_write_pb2.WriteRequest()
    try:
        message.ParseFromString(raw)
    except DecodeError:
        raise GatewayError(400, "invalid_protobuf") from None

    known_only = remote_write_pb2.WriteRequest()
    known_only.CopyFrom(message)
    known_only.DiscardUnknownFields()  # Recursive, including labels and samples.
    if known_only.ByteSize() != message.ByteSize():
        raise GatewayError(400, "unsupported_fields")
    if not message.timeseries:
        raise GatewayError(400, "empty_write")
    # Never forward the copy with fields discarded, even for accepted input.
    return message


def encode_write(message: remote_write_pb2.WriteRequest, settings: Settings) -> bytes:
    if message.ByteSize() > settings.max_decompressed_bytes:
        raise GatewayError(413, "payload_too_large")
    serialized = message.SerializeToString()
    if len(serialized) > settings.max_decompressed_bytes:
        raise GatewayError(413, "payload_too_large")
    compressed = bytes(cramjam.snappy.compress_raw(serialized))
    if len(compressed) > settings.max_compressed_bytes:
        raise GatewayError(413, "payload_too_large")
    return compressed
