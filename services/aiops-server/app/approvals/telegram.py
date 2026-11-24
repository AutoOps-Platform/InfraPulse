"""Production Telegram Bot Notification, Human-in-the-Loop (HITL) Approval, & Private VPC Long-Polling.

Supports:
- Strict environment-only administrator chat ID (`TELEGRAM_ADMIN_CHAT_ID`; zero hardcoded IDs).
- Rich incident cards with Inline Keyboard buttons (`[Approve]`, `[Reject]`) for `Medium`
  severity events, urgent read-only RCA escalations for `Critical` events, and execution
  summaries for `Low` allowlisted events.
- Native Telegram Bot API `Update` JSON parsing (`callback_query`) alongside normalized
  `TelegramCallbackPayload` payloads.
- `answerCallbackQuery` acknowledgements so Telegram button spinners clear cleanly.
- Optional outbound long-polling (`getUpdates`) with `start_polling()` / `stop_polling()`
  lifecycle hooks so HITL works inside a private AWS VPC without public webhook ingress.
- Strict callback authentication (`chat_id` & `user_id` verification against configured
  `TELEGRAM_ADMIN_CHAT_ID`), TTL expiration, and idempotency protection.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
import uuid
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

import httpx
from pydantic import BaseModel, Field, ValidationError

from app.config import AIOpsSettings
from app.schemas.alert import AlertItem
from app.schemas.decision import ExecutionStrategy, PolicyDecision, SeverityTier
from app.schemas.rca import RCAReport

logger = logging.getLogger(__name__)


class ApprovalStatus(StrEnum):
    """Lifecycle state of a Human-in-the-Loop approval request."""

    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    EXPIRED = "expired"
    NOT_REQUIRED = "not_required"


class ApprovalRecord(BaseModel):
    """In-memory record tracking an active HITL approval request."""

    approval_id: str
    incident_fingerprint: str
    server_id: str
    alert_name: str
    severity: SeverityTier
    proposed_action_id: str | None = None
    status: ApprovalStatus = ApprovalStatus.PENDING
    admin_chat_id: str
    decided_by: str | None = None
    decided_at: datetime | None = None
    created_at_monotonic: float = Field(default_factory=time.monotonic, exclude=True)
    ttl_seconds: int = 900


class TelegramDeliveryReceipt(BaseModel):
    """Result of formatting and dispatching a Telegram Bot message."""

    approval_id: str | None = None
    admin_chat_id: str
    bot_configured: bool
    sent_live: bool = False
    approval_status: ApprovalStatus
    message_text: str
    inline_keyboard: list[list[dict[str, str]]] = Field(default_factory=list)
    telegram_message_id: int | None = None
    detail: str = ""


class TelegramCallbackPayload(BaseModel):
    """Normalized payload for testing or receiving Telegram `callback_query` webhooks."""

    callback_id: str = Field(default_factory=lambda: f"cb-{uuid.uuid4().hex[:8]}")
    chat_id: str
    user_id: str
    data: str = Field(description="Format: '<approve|reject>|<approval_id>|<action_id>'")


def parse_telegram_update(payload: dict[str, Any] | TelegramCallbackPayload) -> TelegramCallbackPayload:
    """Normalize either a native Telegram Bot API `Update` JSON or a flat `TelegramCallbackPayload`."""
    if isinstance(payload, TelegramCallbackPayload):
        return payload
    if not isinstance(payload, dict):
        raise ValueError("Telegram webhook payload must be a JSON object.")

    # Native Telegram Bot API Update with `callback_query`
    if "callback_query" in payload:
        cbq = payload.get("callback_query")
        if not isinstance(cbq, dict):
            raise ValueError("Invalid Telegram Update: 'callback_query' must be an object.")
        callback_id = str(cbq.get("id") or "").strip()
        from_obj = cbq.get("from") if isinstance(cbq.get("from"), dict) else {}
        message_obj = cbq.get("message") if isinstance(cbq.get("message"), dict) else {}
        chat_obj = message_obj.get("chat") if isinstance(message_obj.get("chat"), dict) else {}
        user_id = str(from_obj.get("id") if from_obj.get("id") is not None else "").strip()
        chat_id = str(chat_obj.get("id") if chat_obj.get("id") is not None else user_id).strip()
        data = str(cbq.get("data") or "").strip()
        if not callback_id or not user_id or not chat_id or not data:
            raise ValueError(
                "Incomplete Telegram callback_query: requires 'id', 'from.id', 'message.chat.id', and 'data'."
            )
        return TelegramCallbackPayload(
            callback_id=callback_id,
            chat_id=chat_id,
            user_id=user_id,
            data=data,
        )

    # Flat TelegramCallbackPayload format
    try:
        return TelegramCallbackPayload.model_validate(payload)
    except ValidationError as exc:
        raise ValueError(
            "Unsupported Telegram payload: expected native 'callback_query' Update or flat callback payload."
        ) from exc


class TelegramHITLService:
    """Manages Telegram notifications, inline HITL approval buttons, callback verification, and polling."""

    def __init__(
        self,
        settings: AIOpsSettings | None = None,
        *,
        http_client: httpx.AsyncClient | None = None,
        approval_ttl_seconds: int = 900,
    ) -> None:
        self.settings = settings or AIOpsSettings.from_env()
        self._client = http_client
        self.approval_ttl_seconds = max(60, approval_ttl_seconds)
        self._approvals: dict[str, ApprovalRecord] = {}
        self._processed_callbacks: set[str] = set()
        self._last_update_id: int = 0
        self._polling_task: asyncio.Task[None] | None = None
        self._stop_event: asyncio.Event | None = None

    @property
    def admin_chat_id(self) -> str:
        """Return configured administrator Telegram chat ID strictly from settings (never hardcoded)."""
        return (self.settings.TELEGRAM_ADMIN_CHAT_ID or "").strip()

    @property
    def bot_token(self) -> str:
        return self.settings.TELEGRAM_BOT_TOKEN.get_secret_value().strip()

    @property
    def is_bot_configured(self) -> bool:
        return bool(self.bot_token and self.admin_chat_id)

    @property
    def is_polling_active(self) -> bool:
        return self._polling_task is not None and not self._polling_task.done()

    def get_approval(self, approval_id: str) -> ApprovalRecord | None:
        return self._approvals.get(approval_id)

    @staticmethod
    def parse_telegram_update(
        payload: dict[str, Any] | TelegramCallbackPayload,
    ) -> TelegramCallbackPayload:
        """Parse native Telegram `Update` JSON or flat `TelegramCallbackPayload`."""
        return parse_telegram_update(payload)

    @staticmethod
    def _build_inline_keyboard(approval_id: str, action_id: str | None) -> list[list[dict[str, str]]]:
        slug = action_id or "manual-review"
        return [
            [
                {
                    "text": f"✅ Approve ({slug})",
                    "callback_data": f"approve|{approval_id}|{slug}",
                },
                {
                    "text": "❌ Reject",
                    "callback_data": f"reject|{approval_id}|none",
                },
            ]
        ]

    def _format_telegram_card(
        self,
        alert: AlertItem,
        policy: PolicyDecision,
        rca: RCAReport | None,
        approval_id: str | None,
    ) -> str:
        """Format a structured operational message for Telegram administrator review."""
        header = (
            "🚨 [CRITICAL - IMMEDIATE ESCALATION | NO AUTO-EXEC]"
            if policy.severity == SeverityTier.CRITICAL
            else "⚠️ [MEDIUM - HITL APPROVAL REQUIRED]"
            if policy.strategy == ExecutionStrategy.REQUEST_HITL_APPROVAL
            else "✅ [LOW - ALLOWLISTED AUTO-EXECUTION]"
        )
        lines = [
            header,
            f"• Domain: {alert.domain.upper()} | Target: {alert.target_id}",
            f"• Server: {alert.server_id}",
            f"• Alert: {alert.alert_name} (Severity: {policy.severity.value.upper()})",
            f"• Strategy: {policy.strategy.value}",
        ]
        if approval_id:
            lines.append(f"• Approval ID: {approval_id}")
        if rca:
            lines.extend(
                [
                    "",
                    f"🔍 Summary: {rca.summary}",
                    f"🧠 Understanding: {rca.understanding or rca.summary}",
                    f"🛠️ Proposed Resolution: {rca.proposed_resolution}",
                    f"⚡ Expected Impact: {rca.expected_impact}",
                    f"🧰 Tools Used: {', '.join(rca.intended_tools)}",
                    f"🎯 Recommended Action: {rca.recommended_action_id or 'manual-review'} "
                    f"(Confidence: {int(rca.confidence * 100)}%)",
                ]
            )
        return "\n".join(lines)

    async def notify_and_request_approval(
        self,
        alert: AlertItem,
        policy: PolicyDecision,
        rca: RCAReport | None,
        *,
        fingerprint: str,
    ) -> TelegramDeliveryReceipt:
        """Create an approval record (when required) and dispatch the Telegram notification."""
        needs_buttons = policy.strategy == ExecutionStrategy.REQUEST_HITL_APPROVAL
        approval_id: str | None = None
        inline_keyboard: list[list[dict[str, str]]] = []
        status = (
            ApprovalStatus.PENDING
            if needs_buttons
            else ApprovalStatus.NOT_REQUIRED
        )

        action_slug = (
            (rca.recommended_action_id if rca else None)
            or policy.approved_action_id
            or policy.jev_decision.candidate_action_id
        )

        if needs_buttons:
            approval_id = f"apr-{uuid.uuid4().hex[:10]}"
            record = ApprovalRecord(
                approval_id=approval_id,
                incident_fingerprint=fingerprint,
                server_id=alert.server_id,
                alert_name=alert.alert_name,
                severity=policy.severity,
                proposed_action_id=action_slug,
                status=ApprovalStatus.PENDING,
                admin_chat_id=self.admin_chat_id,
                ttl_seconds=self.approval_ttl_seconds,
            )
            self._approvals[approval_id] = record
            inline_keyboard = self._build_inline_keyboard(approval_id, action_slug)

        message_text = self._format_telegram_card(alert, policy, rca, approval_id)

        if not self.is_bot_configured:
            if not self.admin_chat_id:
                detail = (
                    "Telegram HITL is not configured "
                    "(set TELEGRAM_ADMIN_CHAT_ID and TELEGRAM_BOT_TOKEN in environment)."
                )
            else:
                detail = (
                    "Prepared for configured Telegram admin chat "
                    "(set TELEGRAM_BOT_TOKEN in environment to enable live Telegram API delivery)."
                )
            return TelegramDeliveryReceipt(
                approval_id=approval_id,
                admin_chat_id=self.admin_chat_id,
                bot_configured=False,
                sent_live=False,
                approval_status=status,
                message_text=message_text,
                inline_keyboard=inline_keyboard,
                detail=detail,
            )

        url = f"https://api.telegram.org/bot{self.bot_token}/sendMessage"
        payload: dict[str, Any] = {
            "chat_id": self.admin_chat_id,
            "text": message_text,
        }
        if inline_keyboard:
            payload["reply_markup"] = {"inline_keyboard": inline_keyboard}

        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=10.0)
        try:
            resp = await client.post(url, json=payload)
            if resp.status_code == 200:
                body = resp.json()
                msg_id = (body.get("result") or {}).get("message_id")
                return TelegramDeliveryReceipt(
                    approval_id=approval_id,
                    admin_chat_id=self.admin_chat_id,
                    bot_configured=True,
                    sent_live=True,
                    approval_status=status,
                    message_text=message_text,
                    inline_keyboard=inline_keyboard,
                    telegram_message_id=msg_id,
                    detail="Delivered live to Telegram Bot API.",
                )
            return TelegramDeliveryReceipt(
                approval_id=approval_id,
                admin_chat_id=self.admin_chat_id,
                bot_configured=True,
                sent_live=False,
                approval_status=status,
                message_text=message_text,
                inline_keyboard=inline_keyboard,
                detail=f"Telegram API returned HTTP {resp.status_code}.",
            )
        except httpx.HTTPError as exc:
            return TelegramDeliveryReceipt(
                approval_id=approval_id,
                admin_chat_id=self.admin_chat_id,
                bot_configured=True,
                sent_live=False,
                approval_status=status,
                message_text=message_text,
                inline_keyboard=inline_keyboard,
                detail=f"Telegram transport error: {exc}",
            )
        finally:
            if owns_client:
                await client.aclose()

    def process_callback(
        self,
        callback: TelegramCallbackPayload | dict[str, Any],
        *,
        now: float | None = None,
    ) -> ApprovalRecord:
        """Verify configured admin identity, TTL, and idempotency for a Telegram button click."""
        normalized = self.parse_telegram_update(callback)
        if not self.admin_chat_id:
            raise PermissionError("TELEGRAM_ADMIN_CHAT_ID is not configured.")

        if (
            str(normalized.chat_id).strip() != self.admin_chat_id
            or str(normalized.user_id).strip() != self.admin_chat_id
        ):
            raise PermissionError(
                "Unauthorized Telegram actor for configured TELEGRAM_ADMIN_CHAT_ID."
            )

        if normalized.callback_id in self._processed_callbacks:
            raise ValueError(f"Duplicate callback_id '{normalized.callback_id}' already processed.")

        parts = normalized.data.split("|")
        if len(parts) < 2 or parts[0] not in {"approve", "reject"}:
            raise ValueError(
                "Invalid callback data format; expected '<approve|reject>|<approval_id>|<action_id>'."
            )

        decision_verb, approval_id = parts[0], parts[1]
        record = self._approvals.get(approval_id)
        if record is None:
            raise KeyError(f"Approval request '{approval_id}' not found.")

        if record.status != ApprovalStatus.PENDING:
            raise ValueError(
                f"Approval '{approval_id}' is already finalized with status '{record.status.value}'."
            )

        current = time.monotonic() if now is None else now
        if (current - record.created_at_monotonic) > record.ttl_seconds:
            record.status = ApprovalStatus.EXPIRED
            raise ValueError(f"Approval request '{approval_id}' has expired.")

        self._processed_callbacks.add(normalized.callback_id)
        record.status = (
            ApprovalStatus.APPROVED if decision_verb == "approve" else ApprovalStatus.REJECTED
        )
        record.decided_by = str(normalized.user_id).strip()
        record.decided_at = datetime.now(UTC)
        return record

    async def answer_callback_query(self, callback_id: str, text: str) -> bool:
        """Acknowledge a Telegram inline button click via `answerCallbackQuery`."""
        clean_id = (callback_id or "").strip()
        if not self.is_bot_configured or not clean_id:
            return False

        url = f"https://api.telegram.org/bot{self.bot_token}/answerCallbackQuery"
        payload = {
            "callback_query_id": clean_id,
            "text": text[:200],
        }
        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=10.0)
        try:
            resp = await client.post(url, json=payload)
            if resp.status_code != 200:
                return False
            body = resp.json()
            return bool(body.get("ok", True))
        except (httpx.HTTPError, ValueError):
            return False
        finally:
            if owns_client:
                await client.aclose()

    async def poll_updates_once(self) -> list[ApprovalRecord]:
        """Fetch pending Telegram updates via `getUpdates` and process HITL callback queries."""
        if not self.is_bot_configured:
            return []

        url = f"https://api.telegram.org/bot{self.bot_token}/getUpdates"
        params = {
            "offset": self._last_update_id + 1,
            "timeout": 0,
        }
        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=15.0)
        try:
            resp = await client.get(url, params=params)
            if resp.status_code != 200:
                return []
            body = resp.json()
        except (httpx.HTTPError, ValueError):
            return []
        finally:
            if owns_client:
                await client.aclose()

        updates = body.get("result")
        if not isinstance(updates, list):
            return []

        processed: list[ApprovalRecord] = []
        for update in updates:
            if not isinstance(update, dict):
                continue
            raw_uid = update.get("update_id")
            if isinstance(raw_uid, int):
                self._last_update_id = max(self._last_update_id, raw_uid)
            if "callback_query" not in update:
                continue
            try:
                cb_payload = self.parse_telegram_update(update)
            except ValueError as exc:
                logger.warning("Skipping malformed Telegram callback_query update: %s", exc)
                continue
            try:
                record = self.process_callback(cb_payload)
                processed.append(record)
                await self.answer_callback_query(
                    cb_payload.callback_id,
                    f"Recorded: {record.status.value.upper()} ({record.approval_id})",
                )
            except (PermissionError, KeyError, ValueError) as exc:
                await self.answer_callback_query(
                    cb_payload.callback_id,
                    f"Unable to process decision: {exc}",
                )
        return processed

    async def _polling_loop(self) -> None:
        """Background long-polling loop for private VPC deployments without public webhook ingress."""
        interval = max(0.2, float(getattr(self.settings, "TELEGRAM_POLL_INTERVAL_SECONDS", 2.0)))
        while self._stop_event is not None and not self._stop_event.is_set():
            try:
                await self.poll_updates_once()
            except Exception as exc:  # pragma: no cover - defensive runtime guard
                logger.warning("Telegram polling iteration failed: %s", exc)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._stop_event.wait(), timeout=interval)

    async def start_polling(self) -> bool:
        """Start background Telegram `getUpdates` polling when enabled and configured."""
        polling_enabled = bool(getattr(self.settings, "TELEGRAM_POLLING_ENABLED", False))
        if not polling_enabled or not self.is_bot_configured:
            return False
        if self.is_polling_active:
            return True
        self._stop_event = asyncio.Event()
        self._polling_task = asyncio.create_task(
            self._polling_loop(),
            name="telegram-hitl-poller",
        )
        return True

    async def stop_polling(self) -> None:
        """Gracefully stop background Telegram polling task."""
        if self._stop_event is not None:
            self._stop_event.set()
        if self._polling_task is not None:
            self._polling_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._polling_task
            self._polling_task = None
        self._stop_event = None
