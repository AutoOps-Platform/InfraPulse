import { randomUUID } from 'node:crypto';
import { Injectable, Inject } from '@nestjs/common';
import { ApiError } from '../common/errors.js';
import { DatabaseService, type Tx } from '../database/database.service.js';
import { parsePage, type Page } from '../common/pagination.js';
import {
  enumFilter,
  inventoryId,
  inventoryPage,
  pageCursor,
} from '../servers/servers.dto.js';
import {
  AUDIT_FILTERS,
  auditDto,
  auditSelect,
  type AuditDto,
  type AuditEvent,
  type AuditQuery,
} from './audit.dto.js';

const deltaFields = new Set([
  'name',
  'os',
  'environment',
  'archived_at',
  'lifecycle',
  'group_id',
  'server_id',
  'agent_id',
  'profile_version_id',
  'version',
  'checksum',
  'status',
  'result',
  'expires_at',
  'retire_at',
  'revoked_at',
  'scopes',
]);
function text(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}
@Injectable()
export class AuditService {
  // Optional TS argument preserves append-only construction in prior pure tests;
  // Nest still requires the real DatabaseService for this provider.
  constructor(@Inject(DatabaseService) private readonly db?: DatabaseService) {}
  async list(query: AuditQuery): Promise<Page<AuditDto>> {
    const page = parsePage(query, AUDIT_FILTERS);
    const f = page.filters;
    for (const key of ['actor_issuer', 'actor_subject'] as const)
      if (f[key] !== undefined && !text(f[key], 128))
        throw new ApiError('invalid_request');
    enumFilter(f.resource_type, [
      'server',
      'agent',
      'credential',
      'profile',
      'profile_version',
      'group',
    ]);
    enumFilter(f.action, [
      'create',
      'update',
      'archive',
      'group_membership',
      'register',
      'lifecycle',
      'issue',
      'rotate',
      'revoke',
      'draft',
      'publish',
      'retire',
      'assignment',
      'config_report',
    ]);
    if (f.resource_id) inventoryId(f.resource_id);
    const date = (value: string | undefined): Date | undefined => {
      if (value === undefined) return undefined;
      const parsed = new Date(value);
      if (
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
        !Number.isFinite(parsed.getTime()) ||
        parsed.toISOString() !== value
      )
        throw new ApiError('invalid_request');
      return parsed;
    };
    const from = date(f.from),
      to = date(f.to);
    if (from && to && from > to) throw new ApiError('invalid_request');
    const db = this.db;
    if (!db) throw new ApiError('dependency_unavailable');
    return db.transaction(async (tx) => {
      const cursor = await pageCursor(page, (id) =>
        tx.auditLog.findUnique({ where: { id }, select: { created_at: true } }),
      );
      const rows = await tx.auditLog.findMany({
        where: {
          ...(f.actor_issuer ? { actor_issuer: f.actor_issuer } : {}),
          ...(f.actor_subject ? { actor_subject: f.actor_subject } : {}),
          ...(f.resource_type ? { resource_type: f.resource_type } : {}),
          ...(f.resource_id ? { resource_id: f.resource_id } : {}),
          ...(f.action ? { operation: f.action } : {}),
          ...(from || to
            ? {
                created_at: {
                  ...(from ? { gte: from } : {}),
                  ...(to ? { lte: to } : {}),
                },
              }
            : {}),
        },
        ...cursor,
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        take: page.limit + 1,
        select: auditSelect,
      });
      return inventoryPage(rows, page, auditDto);
    });
  }
  async append(tx: Tx, event: AuditEvent): Promise<void> {
    try {
      if (
        !['user', 'service', 'agent'].includes(event.actor.kind) ||
        !text(event.actor.issuer, 128) ||
        !text(event.actor.subject, 128) ||
        (event.actor.display !== undefined &&
          !text(event.actor.display, 128)) ||
        ![
          'create',
          'update',
          'archive',
          'group_membership',
          'register',
          'lifecycle',
          'issue',
          'rotate',
          'revoke',
          'draft',
          'publish',
          'retire',
          'assignment',
          'config_report',
        ].includes(event.operation) ||
        ![
          'server',
          'agent',
          'credential',
          'profile',
          'profile_version',
          'group',
        ].includes(event.target.type) ||
        !['success', 'failed', 'denied'].includes(event.outcome)
      )
        throw new Error();
      const delta: Record<string, string | number | boolean | null | string[]> =
        {};
      for (const [key, value] of Object.entries(event.delta)) {
        if (!deltaFields.has(key)) continue; // Project before serialization, never sanitize a raw object after writing.
        if (
          value === null ||
          typeof value === 'boolean' ||
          (typeof value === 'number' && Number.isFinite(value)) ||
          text(value, 512)
        )
          delta[key] = value;
        else if (
          Array.isArray(value) &&
          value.length <= 64 &&
          value.every((item) => text(item, 128))
        )
          delta[key] = value;
        else throw new Error();
      }
      if (Buffer.byteLength(JSON.stringify(delta)) > 4096) throw new Error();
      await tx.auditLog.create({
        data: {
          id: randomUUID(),
          actor_kind: event.actor.kind,
          actor_issuer: event.actor.issuer,
          actor_subject: event.actor.subject,
          actor_display: event.actor.display,
          operation: event.operation,
          resource_type: event.target.type,
          resource_id: event.target.id,
          outcome: event.outcome,
          request_id: event.request_id,
          delta,
        },
        select: { id: true },
      });
    } catch {
      throw new ApiError('audit_unavailable');
    }
  }
}
