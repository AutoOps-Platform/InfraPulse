import { randomUUID } from 'node:crypto';
import { Injectable, Optional } from '@nestjs/common';
import { ApiError } from '../../../common/errors.js';
import {
  enumFilter,
  inventoryId,
  inventoryPage,
  isSafeText,
  isUuid,
  parsePage,
  type Page,
} from '../../../common/pagination.js';
import { PrismaService, throwDatabaseError, type Tx } from '../../../prisma/prisma.service.js';
import {
  ONBOARDING_ERROR_CODES,
  ONBOARDING_STAGES,
  ONBOARDING_STATES,
} from '../../onboarding/dto/onboarding.dto.js';
import {
  AUDIT_FILTERS,
  auditDto,
  type AuditDto,
  type AuditEvent,
  type AuditQuery,
} from '../dto/audit.dto.js';
import { AuditRepository } from '../repositories/audit.repository.js';

const ONBOARDING_DELTA_KEYS = new Set([
  'server_id',
  'attempt_id',
  'enrollment_id',
  'generation',
  'state',
  'stage',
  'error_code',
]);

const INVENTORY_DELTA_KEYS = new Set([
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

const ALLOWED_RESOURCE_TYPES = [
  'server',
  'agent',
  'credential',
  'profile',
  'profile_version',
  'group',
  'onboarding',
] as const;

const ALLOWED_OPERATIONS = [
  'create',
  'update',
  'archive',
  'delete',
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
  'onboarding_intent',
  'onboarding_transition',
  'decommission_intent',
  'decommission_transition',
] as const;

function validOnboardingValue(key: string, value: unknown): boolean {
  if (key === 'generation') return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  if (key === 'state') return ONBOARDING_STATES.some((item) => item === value);
  if (key === 'stage') return ONBOARDING_STAGES.some((item) => item === value);
  if (key === 'error_code') return value === null || ONBOARDING_ERROR_CODES.some((item) => item === value);
  return isUuid(value);
}

@Injectable()
export class AuditService {
  constructor(
    private readonly repo: AuditRepository,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  async list(query: AuditQuery): Promise<Page<AuditDto>> {
    const page = parsePage(query, AUDIT_FILTERS);
    const f = page.filters;

    for (const key of ['actor_issuer', 'actor_subject'] as const) {
      if (f[key] !== undefined && !isSafeText(f[key], 128)) {
        throw new ApiError('invalid_request');
      }
    }
    enumFilter(f.resource_type, [...ALLOWED_RESOURCE_TYPES, 'alert_binding']);
    enumFilter(f.action, [...ALLOWED_OPERATIONS, 'alert_sync_intent', 'alert_sync_result']);
    if (f.resource_id) inventoryId(f.resource_id);

    const parseFilterDate = (value: string | undefined): Date | undefined => {
      if (value === undefined) return undefined;
      const parsed = new Date(value);
      if (
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
        !Number.isFinite(parsed.getTime()) ||
        parsed.toISOString() !== value
      ) {
        throw new ApiError('invalid_request');
      }
      return parsed;
    };

    const from = parseFilterDate(f.from);
    const to = parseFilterDate(f.to);
    if (from && to && from > to) throw new ApiError('invalid_request');
    if (!this.prisma) throw new ApiError('dependency_unavailable');

    return this.prisma
      .$transaction(async (tx) => {
        const rows = await this.repo.list(tx, page, {
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
        });
        return inventoryPage(rows, page, auditDto);
      })
      .catch(throwDatabaseError);
  }

  async append(tx: Tx, event: AuditEvent): Promise<void> {
    try {
      if (
        !['user', 'service', 'agent'].includes(event.actor.kind) ||
        !isSafeText(event.actor.issuer, 128) ||
        !isSafeText(event.actor.subject, 128) ||
        (event.actor.display !== undefined && !isSafeText(event.actor.display, 128)) ||
        !ALLOWED_OPERATIONS.includes(event.operation) ||
        !ALLOWED_RESOURCE_TYPES.includes(event.target.type) ||
        !['success', 'failed', 'denied'].includes(event.outcome)
      ) {
        throw new Error();
      }

      const isOnboarding = [
        'onboarding_intent',
        'onboarding_transition',
        'decommission_intent',
        'decommission_transition',
      ].includes(event.operation);
      if (isOnboarding !== (event.target.type === 'onboarding')) throw new Error();

      const delta: Record<string, string | number | boolean | null | string[]> = {};
      for (const [key, value] of Object.entries(event.delta)) {
        if (isOnboarding) {
          if (!ONBOARDING_DELTA_KEYS.has(key)) continue;
          if (!validOnboardingValue(key, value)) throw new Error();
        } else if (!INVENTORY_DELTA_KEYS.has(key)) {
          continue;
        }

        if (
          value === null ||
          typeof value === 'boolean' ||
          (typeof value === 'number' && Number.isFinite(value)) ||
          isSafeText(value, 512)
        ) {
          delta[key] = value;
        } else if (
          Array.isArray(value) &&
          value.length <= 64 &&
          value.every((item) => isSafeText(item, 128))
        ) {
          delta[key] = value;
        } else {
          throw new Error();
        }
      }

      if (Buffer.byteLength(JSON.stringify(delta)) > 4096) throw new Error();
      await this.repo.append(tx, {
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
      });
    } catch {
      throw new ApiError('audit_unavailable');
    }
  }
}
