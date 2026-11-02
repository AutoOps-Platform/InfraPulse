"""Per-request Ed25519 service assertions; no user roles or self-granted scopes."""
import base64
import hashlib
import math
from pathlib import Path
import re
import time
from typing import Callable
from uuid import uuid4

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
import jwt

from app.errors import GatewayError


def _unavailable() -> GatewayError:
    return GatewayError(503, 'credential_verification_unavailable')


def _text(value: str) -> bool:
    return (isinstance(value, str) and 1 <= len(value) <= 128
            and not re.search(r'[\x00-\x1f\x7f]', value))


class ServiceSigner:
    """Load a private file once; private material never participates in repr/errors."""

    def __init__(self, private_key_file: str | Path, *, issuer: str, audience: str,
                 subject: str, kid: str, ttl_seconds: int = 60,
                 clock: Callable[[], float] = time.time):
        try:
            if (type(ttl_seconds) is not int or not 1 <= ttl_seconds <= 60
                    or not all(_text(value) for value in (issuer, audience, subject))
                    or not isinstance(kid, str) or re.fullmatch(r'[A-Za-z0-9._-]{1,64}', kid) is None):
                raise ValueError()
            # Bound file reads, including malformed/unexpected file contents.
            with Path(private_key_file).open('rb') as source:
                pem = source.read(16385)
            if len(pem) > 16384:
                raise ValueError()
            key = serialization.load_pem_private_key(pem, password=None)
            if not isinstance(key, Ed25519PrivateKey):
                raise ValueError()
        except Exception:
            raise _unavailable() from None
        self._key = key
        self._issuer = issuer
        self._audience = audience
        self._subject = subject
        self._kid = kid
        self._ttl = ttl_seconds
        self._clock = clock

    def sign(self, method: str, target: str, body: bytes) -> str:
        try:
            now = self._clock()
            if (not math.isfinite(now) or type(body) is not bytes
                    or not isinstance(method, str) or not re.fullmatch(r'[A-Za-z]+', method)
                    or not isinstance(target, str) or not target.startswith('/')
                    or target.startswith('//') or re.search(r'[\x00-\x20\x7f#]', target)):
                raise ValueError()
            issued = math.floor(now)
            return jwt.encode({
                'iss': self._issuer, 'aud': self._audience, 'sub': self._subject,
                'kind': 'service', 'iat': issued, 'nbf': issued, 'exp': issued + self._ttl,
                'jti': str(uuid4()), 'm': method.upper(), 't': target,
                'b': base64.urlsafe_b64encode(hashlib.sha256(body).digest()).rstrip(b'=').decode('ascii'),
            }, self._key, algorithm='EdDSA', headers={'kid': self._kid})
        except Exception:
            raise _unavailable() from None
