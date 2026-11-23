import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { SslTarget } from '../../../../generated/prisma/client.js';
import type { AmpRemoteWriteFn, AmpWriteSample } from '../../../../integrations/aws/amp-remote-write.js';
import { ApiError } from '../../../common/errors.js';
import { inventoryId, isSafeText } from '../../../common/pagination.js';
import { PrismaService, throwDatabaseError } from '../../../prisma/prisma.service.js';
import { AuditService } from '../../audit/services/audit.service.js';
import type { UserPrincipal } from '../../auth/guards/auth.guard.js';
import {
  sslTargetDto,
  type CreateSslTargetDto,
  type PatchSslTargetDto,
  type SslTargetDto,
} from '../dto/ssl-targets.dto.js';
import { SslTargetsRepository } from '../repositories/ssl-targets.repository.js';
import { TlsProbeService, normalizeSslHost } from './tls-probe.service.js';

export const SSL_AMP_REMOTE_WRITE = Symbol('SSL_AMP_REMOTE_WRITE');

const MAX_TARGETS = 100;
const PROBE_INTERVAL_MS = 60_000;
const INITIAL_DELAY_MS = 5_000;
const PROBE_CONCURRENCY = 4;

function cleanLabel(value: string | null | undefined, fallback: string): string {
  const text = [...(value ?? '')]
    .map((ch) => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? ' ' : ch))
    .join('')
    .trim();
  return (text || fallback).slice(0, 200);
}

export function buildExternalSslSamples(
  targets: readonly SslTarget[],
  cumulativeErrors: number,
  nowMs: number,
): AmpWriteSample[] {
  const samples: AmpWriteSample[] = [];
  for (const target of targets) {
    if (!target.enabled || !target.not_after || !target.not_before) continue;
    const labels: Record<string, string> = {
      endpoint: `${target.host}:${target.port}`,
      instance: 'management-ssl-prober',
      issuer_CN: cleanLabel(target.issuer_cn, 'Unknown'),
      media: 'external_https',
      source: 'external',
      subject_CN: cleanLabel(target.subject_cn, target.host),
      target_group: cleanLabel(target.group_name, 'default'),
      target_name: cleanLabel(target.name, target.host),
    };
    samples.push(
      {
        name: 'x509_cert_not_after',
        labels,
        value: Math.floor(target.not_after.getTime() / 1000),
        timestampMs: nowMs,
      },
      {
        name: 'x509_cert_not_before',
        labels,
        value: Math.floor(target.not_before.getTime() / 1000),
        timestampMs: nowMs,
      },
    );
  }
  samples.push({
    name: 'x509_read_errors',
    labels: {
      instance: 'management-ssl-prober',
      source: 'external',
    },
    value: cumulativeErrors,
    timestampMs: nowMs,
  });
  return samples;
}

@Injectable()
export class SslTargetsService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private running = false;
  private cumulativeErrors = 0;
  private readonly outbound = new Set<AbortController>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: SslTargetsRepository,
    private readonly audit: AuditService,
    private readonly prober: TlsProbeService,
    @Optional() @Inject(SSL_AMP_REMOTE_WRITE) private readonly remoteWrite?: AmpRemoteWriteFn,
  ) {}

  onModuleInit(): void {
    if (!this.remoteWrite) return;
    this.stopped = false;
    this.scheduleNext(INITIAL_DELAY_MS);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const ac of this.outbound) {
      ac.abort();
    }
    this.outbound.clear();
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.probeAllAndPublish().finally(() => {
        this.scheduleNext(PROBE_INTERVAL_MS);
      });
    }, delayMs);
    this.timer.unref();
  }

  private async pushSnapshot(): Promise<void> {
    if (!this.remoteWrite || this.stopped) return;
    const targets = await this.prisma.$transaction((tx) => this.repo.list(tx, { enabled: true }));
    const samples = buildExternalSslSamples(targets, this.cumulativeErrors, Date.now());
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 4000);
    timer.unref();
    this.outbound.add(ac);
    try {
      await this.remoteWrite(samples, ac.signal);
    } catch {
      /* Remote write failures are non-fatal; next 60s tick retries cleanly. */
    } finally {
      clearTimeout(timer);
      this.outbound.delete(ac);
    }
  }

  private async probeTargetRow(row: SslTarget, timeoutMs = 3000): Promise<SslTarget> {
    const result = await this.prober.probe(row.host, row.port, timeoutMs);
    const now = new Date();
    if (!result.ok) {
      this.cumulativeErrors += 1;
    }
    const updateData = result.ok
      ? {
          subject_cn: result.subjectCn,
          issuer_cn: result.issuerCn,
          serial_number: result.serialNumber,
          not_before: result.notBefore,
          not_after: result.notAfter,
          authorized: result.authorized,
          last_probed_at: now,
          last_error: result.authorizationError,
          updated_at: now,
        }
      : {
          authorized: false,
          last_probed_at: now,
          last_error: result.error.slice(0, 256),
          updated_at: now,
        };
    try {
      return await this.prisma.$transaction((tx) => this.repo.update(tx, row.id, updateData));
    } catch {
      return row;
    }
  }

  async probeAllAndPublish(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const targets = await this.prisma.$transaction((tx) => this.repo.list(tx, { enabled: true }));
      const queue = [...targets];
      const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length) }, async () => {
        while (queue.length > 0 && !this.stopped) {
          const next = queue.shift();
          if (next) {
            await this.probeTargetRow(next, 4000);
          }
        }
      });
      await Promise.all(workers);
      await this.pushSnapshot();
    } catch {
      /* Swallow transient DB/network errors so the periodic loop never dies. */
    } finally {
      this.running = false;
    }
  }

  async list(): Promise<{ items: SslTargetDto[] }> {
    const rows = await this.prisma
      .$transaction((tx) => this.repo.list(tx))
      .catch(throwDatabaseError);
    return { items: rows.map(sslTargetDto) };
  }

  async get(id: string): Promise<SslTargetDto> {
    const targetId = inventoryId(id);
    const row = await this.prisma
      .$transaction((tx) => this.repo.findById(tx, targetId))
      .catch(throwDatabaseError);
    if (!row) throw new ApiError('not_found');
    return sslTargetDto(row);
  }

  async create(
    input: CreateSslTargetDto,
    actor: UserPrincipal,
    requestId: string,
  ): Promise<SslTargetDto> {
    const name = input.name.trim();
    const host = normalizeSslHost(input.host);
    const port = input.port ?? 443;
    const group = (input.group ?? 'default').trim();
    const enabled = input.enabled ?? true;

    if (
      !isSafeText(name, 128) ||
      !host ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !isSafeText(group, 64)
    ) {
      throw new ApiError('invalid_request');
    }

    const created = await this.prisma
      .$transaction(async (tx) => {
        const existing = await this.repo.list(tx);
        if (existing.length >= MAX_TARGETS) {
          throw new ApiError('conflict');
        }
        const now = new Date();
        const row = await this.repo.create(tx, {
          id: randomUUID(),
          name,
          host,
          port,
          group_name: group,
          enabled,
          created_at: now,
          updated_at: now,
        });
        await this.audit.append(tx, {
          actor,
          operation: 'create',
          target: { type: 'ssl_target', id: row.id },
          outcome: 'success',
          request_id: requestId,
          delta: { name: row.name, host: row.host, port: row.port, group_name: row.group_name, enabled: row.enabled },
        });
        return row;
      })
      .catch(throwDatabaseError);

    const probed = enabled ? await this.probeTargetRow(created, 3000) : created;
    if (enabled) {
      void this.pushSnapshot();
    }
    return sslTargetDto(probed);
  }

  async update(
    id: string,
    input: PatchSslTargetDto,
    actor: UserPrincipal,
    requestId: string,
  ): Promise<SslTargetDto> {
    const targetId = inventoryId(id);
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!isSafeText(name, 128)) throw new ApiError('invalid_request');
      data.name = name;
    }
    if (input.group !== undefined) {
      const group = input.group.trim();
      if (!isSafeText(group, 64)) throw new ApiError('invalid_request');
      data.group_name = group;
    }
    if (input.enabled !== undefined) {
      data.enabled = input.enabled;
    }
    if (Object.keys(data).length === 0) {
      throw new ApiError('invalid_request');
    }

    const updated = await this.prisma
      .$transaction(async (tx) => {
        const existing = await this.repo.findById(tx, targetId);
        if (!existing) throw new ApiError('not_found');
        const row = await this.repo.update(tx, targetId, {
          ...data,
          updated_at: new Date(),
        });
        await this.audit.append(tx, {
          actor,
          operation: 'update',
          target: { type: 'ssl_target', id: row.id },
          outcome: 'success',
          request_id: requestId,
          delta: data,
        });
        return row;
      })
      .catch(throwDatabaseError);

    void this.pushSnapshot();
    return sslTargetDto(updated);
  }

  async probeOne(id: string): Promise<SslTargetDto> {
    const targetId = inventoryId(id);
    const existing = await this.prisma
      .$transaction((tx) => this.repo.findById(tx, targetId))
      .catch(throwDatabaseError);
    if (!existing) throw new ApiError('not_found');
    const probed = await this.probeTargetRow(existing, 3000);
    void this.pushSnapshot();
    return sslTargetDto(probed);
  }

  async remove(id: string, actor: UserPrincipal, requestId: string): Promise<void> {
    const targetId = inventoryId(id);
    await this.prisma
      .$transaction(async (tx) => {
        const existing = await this.repo.findById(tx, targetId);
        if (!existing) throw new ApiError('not_found');
        await this.repo.delete(tx, targetId);
        await this.audit.append(tx, {
          actor,
          operation: 'delete',
          target: { type: 'ssl_target', id: targetId },
          outcome: 'success',
          request_id: requestId,
          delta: { host: existing.host, port: existing.port },
        });
      })
      .catch(throwDatabaseError);
    void this.pushSnapshot();
  }
}
