"""Server-owned gateway settings; no implicit dotenv loading."""

from typing import Annotated, Literal
from pathlib import Path
import re
from uuid import UUID
from urllib.parse import urlsplit

from pydantic import AnyHttpUrl, Field, PositiveInt, TypeAdapter, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


PositiveFiniteFloat = Annotated[float, Field(gt=0, allow_inf_nan=False)]
NonnegativeFiniteFloat = Annotated[float, Field(ge=0, allow_inf_nan=False)]
_HTTP_URL = TypeAdapter(AnyHttpUrl)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="INGEST_", env_file=None, allow_inf_nan=False
    )

    max_compressed_bytes: PositiveInt = 1048576
    max_decompressed_bytes: PositiveInt = 8388608
    max_series: PositiveInt = 5000
    max_samples: PositiveInt = 20000
    max_labels_per_series: PositiveInt = 64
    max_inflight: PositiveInt = 2
    rate_per_second: PositiveFiniteFloat = 10
    rate_burst: PositiveInt = 20
    max_sample_age_seconds: PositiveFiniteFloat = 3600
    max_future_skew_seconds: NonnegativeFiniteFloat = 120
    body_read_timeout_seconds: PositiveFiniteFloat = 5

    connect_timeout_seconds: PositiveFiniteFloat = 2
    read_timeout_seconds: PositiveFiniteFloat = 10
    write_timeout_seconds: PositiveFiniteFloat = 10
    pool_timeout_seconds: PositiveFiniteFloat = 1
    upstream_deadline_seconds: PositiveFiniteFloat = 12
    ready_timeout_seconds: Annotated[float, Field(gt=0, le=1, allow_inf_nan=False)] = 1
    management_base_url: str = Field(default='http://management:3000', repr=False)
    gateway_id: str
    service_key_id: str
    service_signing_key_file: Path = Field(repr=False)
    credential_timeout_seconds: Annotated[float, Field(gt=0, le=2, allow_inf_nan=False)] = 2
    credential_cache_ttl_seconds: Annotated[float, Field(gt=0, le=30, allow_inf_nan=False)] = 30
    credential_cache_max_entries: Annotated[int, Field(ge=1, le=10000)] = 1024
    status_interval_seconds: Annotated[float, Field(gt=0, le=10, allow_inf_nan=False)] = 10
    status_timeout_seconds: Annotated[float, Field(gt=0, le=2, allow_inf_nan=False)] = 2
    status_max_pending_agents: Annotated[int, Field(ge=1, le=1024)] = 1024
    prometheus_write_url: str = "http://prometheus:9090/api/v1/write"
    prometheus_ready_url: str = "http://prometheus:9090/-/ready"
    log_level: Literal["NOTSET", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] = "INFO"
    host_port: PositiveInt = 8000

    @field_validator('gateway_id')
    @classmethod
    def validate_gateway_id(cls, value: str) -> str:
        if str(UUID(value)) != value:
            raise ValueError('Gateway ID must be a canonical UUID')
        return value

    @field_validator('service_key_id')
    @classmethod
    def validate_service_key_id(cls, value: str) -> str:
        if re.fullmatch(r'[A-Za-z0-9._-]{1,64}', value) is None:
            raise ValueError('Invalid service key ID')
        return value

    @field_validator('service_signing_key_file', mode='before')
    @classmethod
    def validate_signing_key_path(cls, value):
        if not isinstance(value, (str, Path)) or not str(value).strip() or re.search(r'[\x00-\x1f\x7f]', str(value)):
            raise ValueError('Invalid signing key path')
        return value

    @field_validator('management_base_url')
    @classmethod
    def validate_management_url(cls, value: str) -> str:
        cls.validate_upstream_url(value)
        parsed = urlsplit(value)
        if parsed.path not in {'', '/'} or '?' in value:
            raise ValueError('Management URL must be an HTTP(S) origin')
        return value

    @field_validator("prometheus_write_url", "prometheus_ready_url")
    @classmethod
    def validate_upstream_url(cls, value: str) -> str:
        # Check raw syntax before a URL library can normalize away unsafe parts.
        if any(character.isspace() or ord(character) < 32 or ord(character) == 127 for character in value):
            raise ValueError("Upstream URL must not contain whitespace or controls")
        try:
            parsed = urlsplit(value)
            if (
                parsed.scheme not in {"http", "https"}
                or not parsed.hostname
                or "@" in parsed.netloc
                or "#" in value
            ):
                raise ValueError
            # Accessing port checks its syntax and range, even if it is unused here.
            parsed.port
            _HTTP_URL.validate_python(value)
        except ValueError:
            raise ValueError("Upstream URL must be HTTP(S) with host and no userinfo or fragment") from None
        return value
