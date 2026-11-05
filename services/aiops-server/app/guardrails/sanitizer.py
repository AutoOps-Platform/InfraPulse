"""Step 6: Prompt injection detection, input validation, and untrusted input isolation."""

from __future__ import annotations

import re

from app.schemas.alert import AlertWebhookPayload

# Patterns indicative of prompt injection or unauthorized shell/package execution
_INJECTION_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"ignore\s+(all\s+)?(previous|prior|system)\s+instructions", re.IGNORECASE),
    re.compile(r"disregard\s+(all\s+)?(previous|prior|system)\s+(instructions|rules)", re.IGNORECASE),
    re.compile(r"you\s+are\s+now\s+(in\s+)?developer\s+mode", re.IGNORECASE),
    re.compile(r"(?:\brm\s+-rf\b|\bcurl\b.*\|\s*(?:sh|bash)\b|\bwget\b.*\|\s*(?:sh|bash)\b)", re.IGNORECASE),
    re.compile(r"(?:\bapt(?:-get)?\s+install\b|\bpip\s+install\b|\bnpm\s+install\s+-g\b)", re.IGNORECASE),
    re.compile(r"(?:\bpowershell\b.*\b-enc|\binvoke-expression\b|\biex\s*\()", re.IGNORECASE),
)

_MAX_FIELD_LENGTH = 4096


class GuardrailViolationError(ValueError):
    """Raised when an incoming payload violates prompt-injection or input safety rules."""


class InputSanitizer:
    """Validates and isolates untrusted telemetry payloads before model invocation."""

    @staticmethod
    def inspect_text(value: str, *, field_name: str = "input") -> str:
        """Validate text length and reject known prompt-injection or shell-execution payloads."""
        if len(value) > _MAX_FIELD_LENGTH:
            raise GuardrailViolationError(
                f"Field '{field_name}' exceeds maximum length of {_MAX_FIELD_LENGTH} characters."
            )
        for pattern in _INJECTION_PATTERNS:
            if pattern.search(value):
                raise GuardrailViolationError(
                    f"Potential prompt injection or forbidden command pattern detected in '{field_name}'."
                )
        return value.strip()

    @classmethod
    def validate_webhook_payload(cls, payload: AlertWebhookPayload) -> AlertWebhookPayload:
        """Inspect all titles, messages, labels, and annotations in a webhook batch."""
        if payload.title:
            cls.inspect_text(payload.title, field_name="title")
        if payload.message:
            cls.inspect_text(payload.message, field_name="message")

        for idx, alert in enumerate(payload.alerts):
            for k, v in alert.labels.items():
                cls.inspect_text(k, field_name=f"alerts[{idx}].labels.key")
                cls.inspect_text(v, field_name=f"alerts[{idx}].labels[{k}]")
            for k, v in alert.annotations.items():
                cls.inspect_text(k, field_name=f"alerts[{idx}].annotations.key")
                cls.inspect_text(v, field_name=f"alerts[{idx}].annotations[{k}]")
        return payload

    @staticmethod
    def wrap_untrusted_telemetry(raw_content: str) -> str:
        """Isolate untrusted telemetry inside explicit XML-style data tags."""
        escaped = raw_content.replace("</untrusted_telemetry>", "[REDACTED_TAG]")
        return (
            "<untrusted_telemetry>\n"
            f"{escaped}\n"
            "</untrusted_telemetry>"
        )
