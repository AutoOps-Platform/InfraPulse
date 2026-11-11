"""Phase 2.3: Telegram Bot Notification and Human-in-the-Loop (HITL) Approval Workflow.

Supports:
- Configured administrator Telegram ID (`TELEGRAM_ADMIN_CHAT_ID`, e.g., `5841901091`).
- Rich incident cards with Inline Keyboard buttons (`[✅ Approve]`, `[❌ Reject]`) for
  `Medium` severity events, urgent read-only RCA escalations for `Critical` events,
  and execution summaries for `Low` allowlisted events.
- Strict callback authentication (`chat_id` & `user_id` verification against
  `TELEGRAM_ADMIN_CHAT_ID`), TTL expiration, and idempotency protection so duplicate
  button clicks never trigger duplicate actions.
"""

from __future__ import annotations

import time
import uuid
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

import httpx
from pydantic import BaseModel, Field

from app.config import AIOpsSettings
from app.schemas.alert import AlertItem
from app.schemas.decision import ExecutionStrategy, PolicyDecision, SeverityTier
from app.schemas.rca import RCAReport


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


class TelegramHITLService:
    """Manages Telegram notifications, inline HITL approval buttons, and callback verification."""

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

    @property
    def admin_chat_id(self) -> str:
        return (self.settings.TELEGRAM_ADMIN_CHAT_ID or "5841901091").strip()

    @property
    def bot_token(self) -> str:
        return self.settings.TELEGRAM_BOT_TOKEN.get_secret_value().strip()

    @property
    def is_bot_configured(self) -> bool:
        return bool(self.bot_token and self.admin_chat_id)

    def get_approval(self, approval_id: str) -> ApprovalRecord | None:
        return self._approvals.get(approval_id)

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
            return TelegramDeliveryReceipt(
                approval_id=approval_id,
                admin_chat_id=self.admin_chat_id,
                bot_configured=False,
                sent_live=False,
                approval_status=status,
                message_text=message_text,
                inline_keyboard=inline_keyboard,
                detail=(
                    f"Prepared for Telegram Admin ID {self.admin_chat_id} "
                    "(set TELEGRAM_BOT_TOKEN in .env to enable live Telegram API delivery)."
                ),
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
        callback: TelegramCallbackPayload,
        *,
        now: float | None = None,
    ) -> ApprovalRecord:
        """Verify administrator identity (`5841901091`), TTL, and idempotency for a button click."""
        if str(callback.chat_id).strip() != self.admin_chat_id or str(callback.user_id).strip() != self.admin_chat_id:
            raise PermissionError(
                f"Unauthorized Telegram actor (expected admin ID '{self.admin_chat_id}')."
            )

        if callback.callback_id in self._processed_callbacks:
            raise ValueError(f"Duplicate callback_id '{callback.callback_id}' already processed.")

        parts = callback.data.split("|")
        if len(parts) < 2 or parts[0] not in {"approve", "reject"}:
            raise ValueError("Invalid callback data format; expected '<approve|reject>|<approval_id>|<action_id>'.")

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

        self._processed_callbacks.add(callback.callback_id)
        record.status = (
            ApprovalStatus.APPROVED if decision_verb == "approve" else ApprovalStatus.REJECTED
        )
        record.decided_by = str(callback.user_id).strip()
        record.decided_at = datetime.now(UTC)
        return record
