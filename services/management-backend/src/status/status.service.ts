import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ReportChunkDto } from './status.dto.js';
import { DatabaseService, type Tx } from '../database/database.service.js';
import { Prisma, type GatewayEpoch } from '../generated/prisma/client.js';
import type { ServicePrincipal } from '../auth/principal.js';
import { ApiError } from '../common/errors.js';
import { evaluateStatus, type SourceObservation } from './status-evaluator.js';
import type {
  EpochDto,
  EpochOpenDto,
  ObservationRecordDto,
  ReportAckDto,
  StatusDto,
} from './status.dto.js';

type TrustedSource = { issuer: string; subject: string };
type Manifest = Pick<
  ReportChunkDto,
  | 'epoch'
  | 'sequence'
  | 'snapshot_start'
  | 'snapshot_end'
  | 'gap'
  | 'chunk_count'
  | 'snapshot_hash'
>;
type Pending = {
  manifest: Manifest;
  chunks: Record<string, ObservationRecordDto[]>;
};
const canonical = (value: unknown) => canonicalize(value)!;
const hash = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const clearPending = {
  pending_sequence: null,
  pending_digest: null,
  pending_chunk_hashes: Prisma.DbNull,
  pending_payload: Prisma.DbNull,
  pending_deadline: null,
};
function manifest(input: ReportChunkDto): Manifest {
  const {
    epoch,
    sequence,
    snapshot_start,
    snapshot_end,
    gap,
    chunk_count,
    snapshot_hash,
  } = input;
  return {
    epoch,
    sequence,
    snapshot_start,
    snapshot_end,
    gap,
    chunk_count,
    snapshot_hash,
  };
}
function logical(m: Manifest, records: ObservationRecordDto[]) {
  const { epoch, sequence, snapshot_start, snapshot_end, gap } = m;
  return {
    epoch,
    sequence,
    snapshot_start,
    snapshot_end,
    gap,
    records: [...records].sort((a, b) =>
      a.agent_id < b.agent_id ? -1 : a.agent_id > b.agent_id ? 1 : 0,
    ),
  };
}
function validPending(
  pending: Pending,
  hashes: Record<string, string> | null,
): boolean {
  try {
    if (
      !pending ||
      typeof pending !== 'object' ||
      Object.keys(pending).sort().join(',') !== 'chunks,manifest' ||
      !pending.manifest ||
      !pending.chunks ||
      Array.isArray(pending.chunks) ||
      !hashes ||
      Array.isArray(hashes)
    )
      return false;
    const keys = Object.keys(pending.chunks);
    if (
      !keys.length ||
      keys.length > 4 ||
      keys.sort().join(',') !== Object.keys(hashes).sort().join(',')
    )
      return false;
    return keys.every((k) => {
      if (
        !/^[0-3]$/.test(k) ||
        Number(k) >= pending.manifest.chunk_count ||
        hash(pending.chunks[k]) !== hashes[k]
      )
        return false;
      const dto = plainToInstance(ReportChunkDto, {
        ...pending.manifest,
        chunk_index: Number(k),
        chunk_hash: hashes[k],
        records: pending.chunks[k],
      });
      return (
        validateSync(dto, {
          whitelist: true,
          forbidNonWhitelisted: true,
          forbidUnknownValues: true,
        }).length === 0
      );
    });
  } catch {
    return false;
  }
}
function epochDto(gateway_id: string, row: GatewayEpoch | null): EpochDto {
  return {
    gateway_id,
    epoch: Number(row?.epoch ?? 0),
    boot_id: row?.boot_id ?? null,
    activated_at: row?.activated_at.toISOString() ?? null,
  };
}
@Injectable()
export class StatusService {
  constructor(
    private readonly db: DatabaseService,
    private readonly sources: readonly TrustedSource[],
  ) {}
  private source(principal: ServicePrincipal): string {
    if (
      principal.kind !== 'service' ||
      !principal.scopes.includes('status:write') ||
      !this.sources.some(
        (s) => s.issuer === principal.issuer && s.subject === principal.subject,
      )
    )
      throw new ApiError('forbidden');
    return principal.subject;
  }
  private async lockSource(tx: Tx, id: string) {
    const rows = await tx.$queryRaw<
      { current_epoch: bigint }[]
    >`SELECT current_epoch FROM management.gateway_sources WHERE gateway_id=${id}::uuid FOR UPDATE`;
    if (!rows.length) throw new ApiError('forbidden');
    return rows[0].current_epoch;
  }
  async currentEpoch(source: ServicePrincipal): Promise<EpochDto> {
    const id = this.source(source);
    return this.db.transaction(async (tx) => {
      const current = await this.lockSource(tx, id);
      const row = current
        ? await tx.gatewayEpoch.findUnique({
            where: { gateway_id_epoch: { gateway_id: id, epoch: current } },
          })
        : null;
      return epochDto(id, row);
    });
  }
  async openEpoch(
    source: ServicePrincipal,
    input: EpochOpenDto,
  ): Promise<EpochDto> {
    const id = this.source(source);
    return this.db.transaction(async (tx) => {
      const current = await this.lockSource(tx, id);
      const existing = await tx.gatewayEpoch.findUnique({
        where: {
          gateway_id_boot_id: { gateway_id: id, boot_id: input.boot_id },
        },
      });
      if (existing) {
        if (
          existing.epoch !== current ||
          existing.retired_at ||
          existing.boot_started_at.getTime() !==
            new Date(input.boot_started_at).getTime()
        )
          throw new ApiError('conflict');
        return epochDto(id, existing); // Lost activation response: no new clock/activation.
      }
      if (
        BigInt(input.expected_epoch) !== current ||
        current >= BigInt(Number.MAX_SAFE_INTEGER)
      )
        throw new ApiError('conflict');
      const now = await this.db.now(tx),
        boot = new Date(input.boot_started_at);
      if (
        !Number.isFinite(boot.getTime()) ||
        boot.getTime() > now.getTime() + 5000
      )
        throw new ApiError('invalid_request');
      if (current) {
        const active = await tx.gatewayEpoch.findUniqueOrThrow({
          where: { gateway_id_epoch: { gateway_id: id, epoch: current } },
          select: { boot_started_at: true },
        });
        // Elapsed time since a truthful boot is not skew. The source lock/CAS
        // plus strict boot ordering prevent delayed unseen boots taking over.
        if (boot <= active.boot_started_at) throw new ApiError('conflict');
        await tx.gatewayEpoch.update({
          where: { gateway_id_epoch: { gateway_id: id, epoch: current } },
          data: { retired_at: now, ...clearPending },
        });
      }
      const row = await tx.gatewayEpoch.create({
        data: {
          gateway_id: id,
          epoch: current + 1n,
          boot_id: input.boot_id,
          boot_started_at: boot,
          activated_at: now,
        },
      });
      await tx.gatewaySource.update({
        where: { gateway_id: id },
        data: { current_epoch: row.epoch, updated_at: now },
      });
      return epochDto(id, row);
    });
  }
  async acceptReport(
    source: ServicePrincipal,
    input: ReportChunkDto,
  ): Promise<ReportAckDto> {
    const id = this.source(source);
    // Rejections that prove observation loss must COMMIT the gap, not throw from
    // inside the transaction and accidentally roll the invalidation back.
    const outcome = await this.db.transaction<ReportAckDto | ApiError>(
      async (tx) => {
        const current = await this.lockSource(tx, id);
        if (current !== BigInt(input.epoch)) throw new ApiError('conflict');
        const key = { gateway_id_epoch: { gateway_id: id, epoch: current } };
        let row = await tx.gatewayEpoch.findUniqueOrThrow({ where: key });
        if (row.retired_at) throw new ApiError('conflict');
        const reject = async (
          code: 'invalid_request' | 'conflict' | 'payload_too_large',
        ) => {
          await tx.gatewayEpoch.update({
            where: key,
            data: {
              gap: true,
              coverage_start: null,
              coverage_end: null,
              ...clearPending,
            },
          });
          return new ApiError(code);
        };
        const ack = (
          state: 'staged' | 'committed',
          indexes: number[],
        ): ReportAckDto => ({
          epoch: input.epoch,
          sequence: input.sequence,
          state,
          accepted_chunk_indexes: indexes.sort((a, b) => a - b),
        });
        if (BigInt(input.sequence) < row.last_sequence)
          throw new ApiError('conflict');
        if (BigInt(input.sequence) === row.last_sequence) {
          if (input.chunk_index >= input.chunk_count)
            throw new ApiError('invalid_request');
          if (
            input.snapshot_hash !== row.last_digest ||
            hash(input.records) !== input.chunk_hash
          )
            throw new ApiError('conflict');
          return ack('committed', [input.chunk_index]); // Logical-digest ack ONLY, no claim of new chunk acceptance and absolutely no state write.
        }
        if (input.chunk_index >= input.chunk_count)
          return reject('invalid_request');
        if (hash(input.records) !== input.chunk_hash) return reject('conflict');
        const now = await this.db.now(tx),
          start = new Date(input.snapshot_start),
          end = new Date(input.snapshot_end);
        if (
          !Number.isFinite(start.getTime()) ||
          !Number.isFinite(end.getTime()) ||
          start > end ||
          start < row.boot_started_at ||
          end < row.activated_at ||
          end.getTime() > now.getTime() + 5000 ||
          now.getTime() - end.getTime() > 30000
        )
          return reject('invalid_request');
        if (row.snapshot_end && end < row.snapshot_end)
          return reject('invalid_request');
        let lost = BigInt(input.sequence) !== row.last_sequence + 1n;
        if (row.pending_deadline && row.pending_deadline <= now) {
          const expired = row.pending_sequence;
          await tx.gatewayEpoch.update({
            where: key,
            data: {
              gap: true,
              coverage_start: null,
              coverage_end: null,
              ...clearPending,
            },
          });
          if (expired === BigInt(input.sequence))
            return new ApiError('conflict');
          row = {
            ...row,
            gap: true,
            coverage_start: null,
            coverage_end: null,
            pending_sequence: null,
            pending_deadline: null,
            pending_payload: null,
            pending_chunk_hashes: null,
            pending_digest: null,
          };
          lost = true;
        }
        if (
          row.pending_sequence &&
          row.pending_sequence !== BigInt(input.sequence)
        ) {
          if (BigInt(input.sequence) < row.pending_sequence)
            throw new ApiError('conflict');
          lost = true;
        }
        let pending: Pending;
        if (row.pending_sequence === BigInt(input.sequence)) {
          pending = row.pending_payload as unknown as Pending;
          // Verify DB-staged syntax, manifest and bytes before acknowledging or
          // finalizing after restart. Corrupt/lost staging is persisted as a gap.
          if (
            !validPending(
              pending,
              row.pending_chunk_hashes as Record<string, string> | null,
            ) ||
            canonical(pending.manifest) !== canonical(manifest(input)) ||
            row.pending_digest !== input.snapshot_hash
          )
            return reject('conflict');
          const prior = pending.chunks[String(input.chunk_index)];
          if (prior) {
            if (canonical(prior) !== canonical(input.records))
              return reject('conflict');
            return ack('staged', Object.keys(pending.chunks).map(Number));
          }
        } else pending = { manifest: manifest(input), chunks: {} };
        pending.chunks[String(input.chunk_index)] = input.records;
        const records = Object.values(pending.chunks).flat();
        if (
          records.length > 1024 ||
          new Set(records.map((r) => r.agent_id)).size !== records.length
        )
          return reject('invalid_request');
        if (
          Buffer.byteLength(canonical(logical(pending.manifest, records))) >
          262144
        )
          return reject('payload_too_large');
        // JSONB adds structural whitespace; enforce the actual database bound, not
        // only compact transport length, before issuing a constraint-failing write.
        const payload = JSON.stringify(pending);
        const bytes = await tx.$queryRaw<
          { bytes: number }[]
        >`SELECT octet_length(${payload}::jsonb::text) AS bytes`;
        if (bytes[0].bytes > 262144) return reject('payload_too_large');
        for (const record of records) {
          const t = new Date(record.last_success_at);
          if (
            !Number.isFinite(t.getTime()) ||
            t > end ||
            t < row.boot_started_at ||
            t.getTime() > now.getTime() + 5000 ||
            now.getTime() - t.getTime() > 600000
          )
            return reject('invalid_request');
        }
        // One bounded join, with proof IDs from the signed reporter. Current key
        // usability is deliberately NOT a condition for historical cache-lag evidence.
        if (records.length) {
          const ids = records.map((r) => r.credential_id);
          const proofs = await tx.apiCredential.findMany({
            where: { id: { in: ids } },
            select: {
              id: true,
              agent_id: true,
              agent: { select: { server_id: true } },
            },
          });
          const byId = new Map(proofs.map((p) => [p.id, p]));
          if (
            records.some(
              (r) =>
                byId.get(r.credential_id)?.agent_id !== r.agent_id ||
                byId.get(r.credential_id)?.agent.server_id !== r.server_id,
            )
          )
            return reject('invalid_request');
        }
        const indexes = Object.keys(pending.chunks).map(Number);
        if (indexes.length < input.chunk_count) {
          const hashes = Object.fromEntries(
            Object.entries(pending.chunks).map(([k, v]) => [k, hash(v)]),
          );
          await tx.gatewayEpoch.update({
            where: key,
            data: {
              ...(lost
                ? { gap: true, coverage_start: null, coverage_end: null }
                : {}),
              pending_sequence: BigInt(input.sequence),
              pending_digest: input.snapshot_hash,
              pending_payload: json(pending),
              pending_chunk_hashes: json(hashes),
              pending_deadline:
                row.pending_sequence === BigInt(input.sequence)
                  ? row.pending_deadline
                  : new Date(now.getTime() + 30000),
            },
          });
          return ack('staged', indexes);
        }
        if (hash(logical(pending.manifest, records)) !== input.snapshot_hash)
          return reject('conflict');
        // Consistent Server->Agent lock/update order, including across snapshots;
        // source lock is never acquired by lifecycle operations (no inverse edge).
        if (records.length) {
          const batch = JSON.stringify(records);
          await tx.$queryRaw`SELECT id FROM management.servers WHERE id IN (SELECT server_id FROM jsonb_to_recordset(${batch}::jsonb) AS r(server_id uuid)) ORDER BY id FOR UPDATE`;
          await tx.$executeRaw`UPDATE management.agents AS a SET last_metric_seen_at=GREATEST(a.last_metric_seen_at,r.last_success_at) FROM jsonb_to_recordset(${batch}::jsonb) AS r(agent_id uuid,last_success_at timestamptz) WHERE a.id=r.agent_id`;
        }
        const contiguous =
          !lost &&
          !input.gap &&
          !row.gap &&
          !!row.coverage_end &&
          start <= row.coverage_end;
        // A known gap/lost sequence can never be backfilled by a claimed old
        // snapshot_start. Re-establish confidence at this completed end, then
        // accumulate subsequent continuous snapshots (never substitute DB now).
        const coverageStart =
          contiguous && row.coverage_start
            ? row.coverage_start
            : lost || input.gap || row.gap
              ? end
              : new Date(Math.max(start.getTime(), row.activated_at.getTime()));
        await tx.gatewayEpoch.update({
          where: key,
          data: {
            last_sequence: BigInt(input.sequence),
            last_digest: input.snapshot_hash,
            received_at: now,
            snapshot_start: start,
            snapshot_end: end,
            coverage_start: coverageStart,
            coverage_end: end,
            gap: input.gap,
            ...clearPending,
          },
        });
        return ack('committed', indexes);
      },
    );
    if (outcome instanceof ApiError) throw outcome;
    return outcome;
  }
  private async projections(
    tx: Tx,
    ids: readonly string[],
    server: boolean,
  ): Promise<Map<string, StatusDto>> {
    if (!ids.length) return new Map();
    const gateways = [...new Set(this.sources.map((source) => source.subject))];
    const gateway = gateways.length === 1 ? gateways[0] : null; // Supported single configured Gateway only.
    type Snapshot = SourceObservation & {
      id: string;
      lifecycle: string | null;
      last_metric_seen_at: Date | null;
      now: Date;
    };
    const relation = server
      ? Prisma.sql`management.servers AS inventory LEFT JOIN management.agents AS a ON a.server_id=inventory.id AND a.lifecycle='active'`
      : Prisma.sql`management.agents AS inventory JOIN management.agents AS a ON a.id=inventory.id`;
    // One PostgreSQL statement snapshot: READ COMMITTED transactions alone would
    // not prevent a source-new/Agent-old negative conclusion across two queries.
    const snapshots = await tx.$queryRaw<Snapshot[]>(Prisma.sql`
      SELECT inventory.id,a.lifecycle,a.last_metric_seen_at,clock_timestamp() AS now,
        e.boot_started_at,e.activated_at,e.snapshot_end,e.received_at,
        e.coverage_start,e.coverage_end,e.gap,e.pending_deadline
      FROM ${relation}
      LEFT JOIN management.gateway_sources AS s ON s.gateway_id=${gateway}::uuid
      LEFT JOIN management.gateway_epochs AS e ON e.gateway_id=s.gateway_id AND e.epoch=s.current_epoch AND e.retired_at IS NULL
      WHERE inventory.id IN (SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`);
    return new Map(
      snapshots.map((row) => [
        row.id,
        evaluateStatus({
          lifecycle: row.lifecycle,
          last_metric_seen_at: row.last_metric_seen_at,
          now: row.now,
          source: row.boot_started_at ? row : null,
        }),
      ]),
    );
  }
  async forAgent(agentId: string): Promise<StatusDto> {
    return this.db.transaction(async (tx) => {
      const status = (await this.projections(tx, [agentId], false)).get(
        agentId,
      );
      if (!status) throw new ApiError('not_found');
      return status;
    });
  }
  async projectAgents(
    tx: Tx,
    rows: readonly {
      id: string;
      lifecycle: string;
      last_metric_seen_at: Date | null;
    }[],
  ): Promise<Map<string, StatusDto>> {
    const statuses = await this.projections(
      tx,
      rows.map((row) => row.id),
      false,
    );
    // A lifecycle transition between inventory selection and this statement must
    // never put Online next to an inactive lifecycle already selected for output.
    for (const row of rows)
      if (row.lifecycle !== 'active') {
        const status = statuses.get(row.id);
        if (status)
          statuses.set(row.id, {
            ...status,
            status: 'Unknown',
            confidence_reason: 'lifecycle_inactive',
          });
      }
    return statuses;
  }
  async projectServers(
    tx: Tx,
    ids: readonly string[],
  ): Promise<Map<string, StatusDto>> {
    return this.projections(tx, ids, true);
  }
}
