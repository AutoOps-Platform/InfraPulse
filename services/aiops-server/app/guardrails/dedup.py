"""Step 7 (Refinement 2.1): Alert fingerprint deduplication and response caching.

Prevents alert storms from causing unexpected LLM/Decision API consumption spikes.
"""

from __future__ import annotations

import time
from collections import OrderedDict
from typing import Generic, TypeVar

T = TypeVar("T")


class AlertDeduplicator:
    """Suppresses repeated firing alerts sharing the same fingerprint within a cooldown window."""

    def __init__(self, cooldown_seconds: int = 300, max_entries: int = 1024) -> None:
        self.cooldown_seconds = max(0, cooldown_seconds)
        self.max_entries = max(1, max_entries)
        self._seen_at: OrderedDict[str, float] = OrderedDict()

    def is_duplicate(self, fingerprint: str, *, now: float | None = None) -> bool:
        """Return True if the fingerprint was already processed within `cooldown_seconds`."""
        if self.cooldown_seconds <= 0:
            return False
        current = time.monotonic() if now is None else now
        last_seen = self._seen_at.get(fingerprint)
        if last_seen is not None and (current - last_seen) < self.cooldown_seconds:
            return True
        return False

    def record(self, fingerprint: str, *, now: float | None = None) -> None:
        """Record that `fingerprint` was processed at `now`."""
        current = time.monotonic() if now is None else now
        if fingerprint in self._seen_at:
            self._seen_at.move_to_end(fingerprint)
        self._seen_at[fingerprint] = current
        while len(self._seen_at) > self.max_entries:
            self._seen_at.popitem(last=False)

    def clear(self, fingerprint: str | None = None) -> None:
        """Clear a single fingerprint (e.g., on alert resolution) or the entire table."""
        if fingerprint is None:
            self._seen_at.clear()
        else:
            self._seen_at.pop(fingerprint, None)


class ResponseCache(Generic[T]):
    """Bounded TTL cache for reusing validated RCA responses on recurring fault signatures."""

    def __init__(self, ttl_seconds: int = 600, max_entries: int = 512) -> None:
        self.ttl_seconds = max(0, ttl_seconds)
        self.max_entries = max(1, max_entries)
        self._store: OrderedDict[str, tuple[float, T]] = OrderedDict()

    def get(self, key: str, *, now: float | None = None) -> T | None:
        """Return cached value if present and unexpired, else None."""
        if self.ttl_seconds <= 0:
            return None
        entry = self._store.get(key)
        if entry is None:
            return None
        created_at, value = entry
        current = time.monotonic() if now is None else now
        if (current - created_at) >= self.ttl_seconds:
            self._store.pop(key, None)
            return None
        self._store.move_to_end(key)
        return value

    def set(self, key: str, value: T, *, now: float | None = None) -> None:
        """Store `value` under `key` with current monotonic timestamp."""
        if self.ttl_seconds <= 0:
            return
        current = time.monotonic() if now is None else now
        if key in self._store:
            self._store.move_to_end(key)
        self._store[key] = (current, value)
        while len(self._store) > self.max_entries:
            self._store.popitem(last=False)
