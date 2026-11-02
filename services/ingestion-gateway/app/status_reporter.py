"""Best-effort, bounded public success metadata; never on the ingest await path.

One event-loop owner, one worker and one immutable in-flight logical snapshot.
No metrics, credentials, durable spool, threads, or per-ingest tasks are retained.
"""
import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import time
from uuid import UUID, uuid4

import rfc8785

from app.config import Settings
from app.credentials import VerifiedCredential
from app.management_client import SignedManagementClient

_EPOCH = '/internal/v1/status/epoch'
_REPORTS = '/internal/v1/status/reports'
_SAFE_INTEGER = 9007199254740991


def utc_now_ms() -> int:
    return time.time_ns() // 1_000_000


def _stamp(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def _millis(value) -> int:
    if not isinstance(value, str) or not value.endswith(('Z', '+00:00')):
        raise ValueError()
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError()
    return round(parsed.timestamp() * 1000)


def _uuid(value) -> bool:
    return isinstance(value, str) and str(UUID(value)) == value


@dataclass(frozen=True)
class _Observation:
    agent_id: str
    server_id: str
    credential_id: str
    succeeded_at_ms: int

    def wire(self):
        return {'agent_id': self.agent_id, 'server_id': self.server_id,
                'credential_id': self.credential_id, 'last_success_at': _stamp(self.succeeded_at_ms)}


@dataclass(frozen=True)
class _Snapshot:
    sequence: int
    end_ms: int
    gap_generation: int
    observations: tuple[_Observation, ...]
    chunks: tuple[bytes, ...]
    created_at: float


class StatusReporter:
    def __init__(self, settings: Settings, client: SignedManagementClient, *,
                 utc_now_ms=utc_now_ms, monotonic=time.monotonic):
        self._settings, self._client = settings, client
        self._clock, self._monotonic = utc_now_ms, monotonic
        self._pending: dict[str, _Observation] = {}
        self._gap_generation, self._cleared_generation = 1, 0
        self._epoch = None
        self._activation_ms = None
        self._sequence = 0
        self._snapshot = None
        self._attempts = 0
        self._busy = False
        self._task = self._close_task = None
        self._closing = False
        self._wake = asyncio.Event()
        self.observer = None

    @property
    def pending_count(self) -> int:
        return len(self._pending)

    @property
    def coverage_gap(self) -> bool:
        return self._gap_generation > self._cleared_generation

    def _event(self, result: str) -> None:
        # Observability is best effort too, including the synchronous ingest sink.
        try:
            if self.observer is not None:
                self.observer.record_status(result)
        except Exception:
            pass

    def _gap(self, result: str) -> None:
        self._gap_generation += 1
        self._event(result)

    def record_success(self, proof: VerifiedCredential, succeeded_at_ms: int) -> None:
        try:
            if self._task is None or self._closing:
                self._gap('dropped')
                return
            if (not isinstance(proof, VerifiedCredential) or type(succeeded_at_ms) is not int
                    or not all(_uuid(value) for value in (proof.identity.agent_id,
                        proof.identity.server_id, proof.credential_id))
                    or succeeded_at_ms < self._boot_ms or succeeded_at_ms > self._clock() + 5000):
                self._gap('clock_gap')
                return
            agent_id = proof.identity.agent_id
            previous = self._pending.get(agent_id)
            if previous is not None and succeeded_at_ms < previous.succeeded_at_ms:
                self._gap('clock_gap')
                return
            if previous is None and len(self._pending) >= self._settings.status_max_pending_agents:
                self._gap('overflow')
                return
            self._pending[agent_id] = _Observation(agent_id, proof.identity.server_id,
                                                   proof.credential_id, succeeded_at_ms)
        except Exception:
            self._gap('dropped')

    async def start(self) -> None:
        if self._task is not None or self._closing:
            return
        # Only here, once per lifespan, never refreshed after control-plane failure.
        self._boot_id, self._boot_ms = str(uuid4()), self._clock()
        self._last_wall, self._last_mono = self._boot_ms, self._monotonic()
        self._last_end = self._boot_ms
        self._task = asyncio.create_task(self._run(), name='ingest-status-reporter')

    async def _run(self) -> None:
        while True:
            try:
                await asyncio.wait_for(self._wake.wait(), self._settings.status_interval_seconds)
            except TimeoutError:
                pass
            self._wake.clear()
            await self._tick()
            if self._closing:
                return

    async def close(self) -> None:
        if self._close_task is None:
            self._close_task = asyncio.create_task(self._stop(), name='ingest-status-stop')
        cancellation = None
        while not self._close_task.done():
            try:
                await asyncio.shield(self._close_task)
            except asyncio.CancelledError as exc:
                cancellation = exc
        self._close_task.result()
        if cancellation is not None:
            raise cancellation

    async def _stop(self) -> None:
        self._closing = True
        if self._task is None:
            return
        self._wake.set()
        try:
            async with asyncio.timeout(2):
                await asyncio.shield(self._task)
        except TimeoutError:
            self._gap('dropped')
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        if self._pending:
            self._gap('dropped')
        self._pending.clear()
        self._snapshot = None

    async def _json(self, method, path, body=b''):
        response = await self._client.request(method, path, body)
        return response.status_code, json.loads(response.body) if response.status_code == 200 else None

    def _epoch_dto(self, data):
        if (not isinstance(data, dict) or set(data) != {'gateway_id', 'boot_id', 'epoch', 'activated_at'}
                or data['gateway_id'] != self._settings.gateway_id
                or type(data['epoch']) is not int or not 0 <= data['epoch'] <= _SAFE_INTEGER):
            raise ValueError()
        if data['epoch'] == 0:
            if data['boot_id'] is not None or data['activated_at'] is not None:
                raise ValueError()
        elif not _uuid(data['boot_id']):
            raise ValueError()
        else:
            _millis(data['activated_at'])
        return data

    async def _register(self) -> bool:
        # At most three GET/refetch + CAS pairs per tick, never a conflict spin.
        for _ in range(3):
            status, current = await self._json('GET', _EPOCH)
            if status != 200:
                return False
            current = self._epoch_dto(current)
            if current['boot_id'] != self._boot_id:
                body = rfc8785.dumps({'boot_id': self._boot_id, 'boot_started_at': _stamp(self._boot_ms),
                                      'expected_epoch': current['epoch']})
                status, current = await self._json('POST', _EPOCH, body)
                if status == 409:
                    continue
                if status != 200:
                    return False
                current = self._epoch_dto(current)
            if current['boot_id'] != self._boot_id or current['epoch'] < 1:
                raise ValueError()
            activation = _millis(current['activated_at'])
            # Receiver DB time can precede a future-skewed boot by up to5s.
            # Delayed registration can instead activate arbitrarily after boot.
            if activation < self._boot_ms - 5000 or activation > self._clock() + 5000:
                self._gap('clock_gap')
                return False
            self._epoch, self._activation_ms = current['epoch'], activation
            return True
        return False

    def _abandon(self):
        self._snapshot = None
        self._attempts = 0
        self._gap('abandoned')

    def _expire(self, now: int) -> None:
        expired = [key for key, item in self._pending.items() if now - item.succeeded_at_ms > 600000]
        for key in expired:
            del self._pending[key]
        if expired:
            self._gap('dropped')
            if self._snapshot is not None:
                self._abandon()

    def _capture(self, now: int, mono: float) -> _Snapshot:
        observations = tuple(sorted(self._pending.values(), key=lambda item: item.agent_id))
        records = [item.wire() for item in observations]
        self._sequence += 1
        envelope = {'epoch': self._epoch, 'sequence': self._sequence,
            'snapshot_start': _stamp(self._last_end), 'snapshot_end': _stamp(now), 'gap': self.coverage_gap}
        logical = rfc8785.dumps({**envelope, 'records': records})
        if len(logical) > 262144:
            raise ValueError()
        digest = hashlib.sha256(logical).hexdigest()
        subsets = [records[index:index + 256] for index in range(0, len(records), 256)] or [[]]
        chunks = tuple(rfc8785.dumps({**envelope, 'chunk_index': index, 'chunk_count': len(subsets),
            'snapshot_hash': digest, 'chunk_hash': hashlib.sha256(rfc8785.dumps(subset)).hexdigest(),
            'records': subset}) for index, subset in enumerate(subsets))
        if len(chunks) > 4 or any(len(chunk) > 65536 for chunk in chunks):
            raise ValueError()
        return _Snapshot(self._sequence, now, self._gap_generation, observations, chunks, mono)

    def _ack(self, data, snapshot, index):
        if (not isinstance(data, dict) or set(data) != {'epoch', 'sequence', 'state', 'accepted_chunk_indexes'}
                or type(data['epoch']) is not int or data['epoch'] != self._epoch
                or type(data['sequence']) is not int or data['sequence'] != snapshot.sequence
                or data['state'] not in {'staged', 'committed'}
                or not isinstance(data['accepted_chunk_indexes'], list)):
            raise ValueError()
        indexes = data['accepted_chunk_indexes']
        if (not indexes or len(indexes) != len(set(indexes)) or index not in indexes
                or any(type(i) is not int or not 0 <= i < len(snapshot.chunks) for i in indexes)):
            raise ValueError()
        return data['state']

    async def _tick(self) -> None:
        if self._busy or self._task is None:
            return
        self._busy = True
        try:
            now, mono = self._clock(), self._monotonic()
            if now < self._last_wall or abs((now - self._last_wall) - (mono - self._last_mono) * 1000) > 5000:
                self._gap('clock_gap')
                if self._snapshot is not None:
                    self._abandon()
            self._last_wall, self._last_mono = now, mono
            self._expire(now)
            if now < self._last_end or now < self._boot_ms:
                self._gap('clock_gap')
                return
            if self._epoch is None and not await self._register():
                self._event('unavailable')
                return
            # Registration may complete later than the tick began. Do not pretend
            # coverage existed before activation or rewrite historical successes.
            now, mono = self._clock(), self._monotonic()
            self._expire(now)
            if now < self._activation_ms or now < self._last_end:
                self._gap('clock_gap')
                return
            if self._snapshot is not None and (self._attempts >= 3 or mono - self._snapshot.created_at >= 30):
                self._abandon()
            if self._snapshot is None:
                self._snapshot = self._capture(now, mono)
                self._attempts = 0
            snapshot = self._snapshot
            self._attempts += 1
            for index, body in enumerate(snapshot.chunks):
                # Earlier chunk RPCs also consume staging/record lifetime. Never
                # continue an immutable manifest past a bound; recapture next tick.
                current = self._clock()
                if (self._monotonic() - snapshot.created_at >= 30
                        or current < snapshot.end_ms
                        or any(current - item.succeeded_at_ms > 600000 for item in snapshot.observations)):
                    self._expire(current)
                    if self._snapshot is not None:
                        self._abandon()
                    return
                # Client signs these immutable bytes afresh for every attempt.
                status, data = await self._json('POST', _REPORTS, body)
                if status == 409:
                    self._abandon()
                    self._epoch = None
                    self._event('conflict')
                    return
                if status != 200:
                    self._event('unavailable')
                    return
                state = self._ack(data, snapshot, index)
                if state == 'committed':
                    # A replay ack supplies only its own index. The receiver's
                    # committed state attests the immutable logical digest, not
                    # newly accepted content or a fresh heartbeat.
                    self._last_end = snapshot.end_ms
                    for item in snapshot.observations:
                        if self._pending.get(item.agent_id) == item:
                            del self._pending[item.agent_id]
                    self._cleared_generation = snapshot.gap_generation
                    self._snapshot = None
                    self._attempts = 0
                    self._event('committed')
                    return
            self._event('unavailable')  # all staged is not a completion ack
        except asyncio.CancelledError:
            self._gap('dropped')
            raise
        except Exception:
            # Never log exception/DTO/request/assertion/key/URL or leak upstream.
            self._event('unavailable')
        finally:
            self._busy = False
