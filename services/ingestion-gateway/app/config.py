"""Server-owned gateway settings; no implicit dotenv loading."""

from typing import Annotated, Literal
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
    ready_timeout_seconds: PositiveFiniteFloat = 1
    prometheus_write_url: str = "http://prometheus:9090/api/v1/write"
    prometheus_ready_url: str = "http://prometheus:9090/-/ready"
    log_level: Literal["NOTSET", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] = "INFO"
    host_port: PositiveInt = 8000

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
