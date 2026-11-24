"""P0.2: Amazon Managed Prometheus (AMP) Async Client with AWS SigV4 Signing.

Implements pure-Python stdlib (`hmac`, `hashlib`, `urllib.parse`, `datetime`)
AWS4-HMAC-SHA256 SigV4 request signing for `service="aps"`, matching
`services/management-backend/src/integrations/aws/amp-query.ts`.

Supports:
- `POST {AMP_ENDPOINT}/api/v1/query`
- `POST {AMP_ENDPOINT}/api/v1/query_range`
"""

from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from urllib.parse import parse_qsl, quote, urlencode, urlsplit

import httpx

from app.config import AIOpsSettings


class AMPQueryError(RuntimeError):
    """Raised when an Amazon Managed Prometheus request fails or returns an error."""

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True, slots=True)
class AwsStaticCredentials:
    """Static AWS credentials used to sign SigV4 requests to AMP."""

    access_key_id: str
    secret_access_key: str
    session_token: str | None = None


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _hmac_sha256(key: bytes, message: str) -> bytes:
    return hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()


def format_amz_date(now: datetime | None = None) -> tuple[str, str]:
    """Format a UTC timestamp as `(amz_date, date_stamp)` for AWS SigV4."""
    if now is None:
        utc_now = datetime.now(timezone.utc)
    elif now.tzinfo is None:
        utc_now = now.replace(tzinfo=timezone.utc)
    else:
        utc_now = now.astimezone(timezone.utc)
    amz_date = utc_now.strftime("%Y%m%dT%H%M%SZ")
    return amz_date, amz_date[:8]


def _canonical_query_string(raw_query: str) -> str:
    if not raw_query:
        return ""
    pairs = parse_qsl(raw_query, keep_blank_values=True)
    encoded = [
        (quote(k, safe="-_.~"), quote(v, safe="-_.~"))
        for k, v in pairs
    ]
    encoded.sort()
    return "&".join(f"{k}={v}" for k, v in encoded)


def sign_sigv4(
    *,
    method: str,
    url: str,
    region: str,
    service: str = "aps",
    body: str | bytes = "",
    content_type: str = "application/x-www-form-urlencoded",
    credentials: AwsStaticCredentials | None = None,
    access_key_id: str | None = None,
    secret_access_key: str | None = None,
    session_token: str | None = None,
    extra_headers: dict[str, str] | None = None,
    now: datetime | None = None,
) -> dict[str, str]:
    """Compute AWS4-HMAC-SHA256 SigV4 headers for an HTTP request.

    Matches the signing specification used by `services/management-backend/src/integrations/aws/amp-query.ts`.
    """
    creds = credentials or AwsStaticCredentials(
        access_key_id=(access_key_id or "").strip(),
        secret_access_key=(secret_access_key or "").strip(),
        session_token=(session_token or "").strip() or None,
    )
    if not creds.access_key_id or not creds.secret_access_key:
        raise ValueError("AWS access_key_id and secret_access_key are required for SigV4 signing.")

    parsed = urlsplit(url)
    if not parsed.scheme or not parsed.netloc:
        raise ValueError(f"Invalid URL for SigV4 signing: '{url}'.")

    amz_date, date_stamp = format_amz_date(now)
    body_bytes = body.encode("utf-8") if isinstance(body, str) else body
    payload_hash = _sha256_hex(body_bytes)

    headers: dict[str, str] = {
        "content-type": content_type,
        "host": parsed.netloc,
        "x-amz-content-sha256": payload_hash,
        "x-amz-date": amz_date,
    }
    if extra_headers:
        for key, value in extra_headers.items():
            headers[key.lower()] = value
    if creds.session_token:
        headers["x-amz-security-token"] = creds.session_token

    sorted_keys = sorted(headers.keys())
    canonical_headers = "".join(f"{k}:{headers[k].strip()}\n" for k in sorted_keys)
    signed_headers = ";".join(sorted_keys)

    canonical_uri = quote(parsed.path or "/", safe="/-_.~")
    canonical_query = _canonical_query_string(parsed.query)
    canonical_request = "\n".join(
        [
            method.upper(),
            canonical_uri,
            canonical_query,
            canonical_headers,
            signed_headers,
            payload_hash,
        ]
    )

    credential_scope = f"{date_stamp}/{region}/{service}/aws4_request"
    string_to_sign = "\n".join(
        [
            "AWS4-HMAC-SHA256",
            amz_date,
            credential_scope,
            _sha256_hex(canonical_request.encode("utf-8")),
        ]
    )

    k_date = _hmac_sha256(f"AWS4{creds.secret_access_key}".encode("utf-8"), date_stamp)
    k_region = _hmac_sha256(k_date, region)
    k_service = _hmac_sha256(k_region, service)
    k_signing = _hmac_sha256(k_service, "aws4_request")
    signature = hmac.new(k_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

    return {
        **headers,
        "Authorization": (
            f"AWS4-HMAC-SHA256 Credential={creds.access_key_id}/{credential_scope}, "
            f"SignedHeaders={signed_headers}, Signature={signature}"
        ),
    }


class AMPClient:
    """Async Amazon Managed Prometheus (AMP) client with SigV4 (`service="aps"`) authentication."""

    SERVICE_NAME = "aps"
    CONTENT_TYPE = "application/x-www-form-urlencoded"

    def __init__(
        self,
        settings: AIOpsSettings | None = None,
        *,
        endpoint: str | None = None,
        region: str | None = None,
        access_key_id: str | None = None,
        secret_access_key: str | None = None,
        session_token: str | None = None,
        timeout_seconds: float | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        raw_endpoint = endpoint if endpoint is not None else (settings.AMP_ENDPOINT if settings else "")
        self.endpoint = self._normalize_endpoint(raw_endpoint)
        self.region = (region if region is not None else (settings.AWS_REGION if settings else "ap-southeast-1")).strip() or "ap-southeast-1"

        resolved_access_key = (
            access_key_id
            if access_key_id is not None
            else (settings.AWS_ACCESS_KEY_ID.get_secret_value() if settings else "")
        ).strip()
        resolved_secret_key = (
            secret_access_key
            if secret_access_key is not None
            else (settings.AWS_SECRET_ACCESS_KEY.get_secret_value() if settings else "")
        ).strip()
        resolved_session_token = (
            session_token
            if session_token is not None
            else (settings.AWS_SESSION_TOKEN.get_secret_value() if settings else "")
        ).strip() or None

        self._credentials: AwsStaticCredentials | None = (
            AwsStaticCredentials(
                access_key_id=resolved_access_key,
                secret_access_key=resolved_secret_key,
                session_token=resolved_session_token,
            )
            if (resolved_access_key and resolved_secret_key)
            else None
        )
        self.timeout_seconds = (
            float(timeout_seconds)
            if timeout_seconds is not None
            else (float(settings.AMP_TIMEOUT_SECONDS) if settings else 10.0)
        )
        self._client = http_client

    @staticmethod
    def _normalize_endpoint(raw_endpoint: str) -> str:
        cleaned = raw_endpoint.strip().rstrip("/")
        for suffix in ("/api/v1/remote_write", "/api/v1/query_range", "/api/v1/query", "/api/v1"):
            if cleaned.endswith(suffix):
                cleaned = cleaned[: -len(suffix)].rstrip("/")
                break
        return cleaned

    @property
    def is_configured(self) -> bool:
        """Return True when `AMP_ENDPOINT` is configured."""
        return bool(self.endpoint)

    @property
    def has_credentials(self) -> bool:
        """Return True when static AWS credentials are available for SigV4 signing."""
        return self._credentials is not None

    def _build_headers(self, url: str, body: str, *, now: datetime | None = None) -> dict[str, str]:
        if self._credentials is not None:
            return sign_sigv4(
                method="POST",
                url=url,
                region=self.region,
                service=self.SERVICE_NAME,
                body=body,
                content_type=self.CONTENT_TYPE,
                credentials=self._credentials,
                now=now,
            )
        return {"content-type": self.CONTENT_TYPE}

    async def _post_form(
        self,
        path: str,
        form_fields: dict[str, str],
        *,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        if not self.is_configured:
            raise AMPQueryError("AMP_ENDPOINT is not configured.")

        url = f"{self.endpoint}{path}"
        body = urlencode(form_fields)
        headers = self._build_headers(url, body, now=now)

        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self.timeout_seconds)
        try:
            response = await client.post(url, headers=headers, content=body.encode("utf-8"))
        except httpx.HTTPError as exc:
            raise AMPQueryError(f"AMP transport error: {exc}") from exc
        finally:
            if owns_client:
                await client.aclose()

        if response.status_code in (401, 403):
            raise AMPQueryError(
                f"AMP AccessDeniedException (HTTP {response.status_code})",
                status_code=response.status_code,
            )
        if response.status_code >= 400:
            detail = response.text.strip()[:200]
            raise AMPQueryError(
                f"AMP_HTTP_{response.status_code}" + (f": {detail}" if detail else ""),
                status_code=response.status_code,
            )

        try:
            payload = response.json()
        except ValueError as exc:
            raise AMPQueryError(
                "AMP returned non-JSON response payload.",
                status_code=response.status_code,
            ) from exc

        if not isinstance(payload, dict) or payload.get("status") != "success":
            err_msg = payload.get("error") if isinstance(payload, dict) else "invalid payload"
            raise AMPQueryError(
                f"AMP query error: {err_msg}",
                status_code=response.status_code,
            )
        return payload

    async def query(
        self,
        promql: str,
        *,
        eval_time: float | int | str | None = None,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        """Execute an instant PromQL query via `POST {AMP_ENDPOINT}/api/v1/query`."""
        fields: dict[str, str] = {"query": promql}
        if eval_time is not None:
            fields["time"] = str(eval_time)
        return await self._post_form("/api/v1/query", fields, now=now)

    async def query_range(
        self,
        promql: str,
        *,
        start: float | int | str,
        end: float | int | str,
        step: int | str = 60,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        """Execute a range PromQL query via `POST {AMP_ENDPOINT}/api/v1/query_range`."""
        fields: dict[str, str] = {
            "query": promql,
            "start": str(start),
            "end": str(end),
            "step": str(step),
        }
        return await self._post_form("/api/v1/query_range", fields, now=now)
