import { ApiProperty } from '@nestjs/swagger';
import type { PageQuery } from '../common/pagination.js';
import type { Prisma } from '../generated/prisma/client.js';

export type AuditQuery = PageQuery;
export const AUDIT_FILTERS = Object.freeze([
  'actor_issuer',
  'actor_subject',
  'resource_type',
  'resource_id',
  'action',
  'from',
  'to',
] as const);
export class AuditDto {
  @ApiProperty({ format: 'uuid' }) readonly id!: string;
  @ApiProperty({ format: 'date-time' }) readonly created_at!: string;
  @ApiProperty({ enum: ['user', 'service', 'agent'] })
  readonly actor_kind!: string;
  @ApiProperty() readonly actor_issuer!: string;
  @ApiProperty() readonly actor_subject!: string;
  @ApiProperty({ type: String, nullable: true }) readonly actor_display!:
    string | null;
  @ApiProperty() readonly operation!: string;
  @ApiProperty() readonly resource_type!: string;
  @ApiProperty({ format: 'uuid' }) readonly resource_id!: string;
  @ApiProperty({ enum: ['success', 'failed', 'denied'] })
  readonly outcome!: string;
  @ApiProperty({ format: 'uuid' }) readonly request_id!: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Allowlisted business delta, no raw bodies or secrets.',
  })
  readonly delta!: Prisma.JsonValue;
}
export function auditDto(
  row: Prisma.AuditLogGetPayload<{ select: typeof auditSelect }>,
): AuditDto {
  return { ...row, created_at: row.created_at.toISOString() };
}

export interface AuditEvent {
  readonly actor: {
    readonly kind: 'user' | 'service' | 'agent';
    readonly issuer: string;
    readonly subject: string;
    readonly display?: string;
  };
  readonly operation:
    | 'create'
    | 'update'
    | 'archive'
    | 'group_membership'
    | 'register'
    | 'lifecycle'
    | 'issue'
    | 'rotate'
    | 'revoke'
    | 'draft'
    | 'publish'
    | 'retire'
    | 'assignment'
    | 'config_report';
  readonly target: {
    readonly type:
      | 'server'
      | 'agent'
      | 'credential'
      | 'profile'
      | 'profile_version'
      | 'group';
    readonly id: string;
  };
  readonly outcome: 'success' | 'failed' | 'denied';
  readonly request_id: string;
  readonly delta: Readonly<Record<string, unknown>>;
}
export const auditSelect = {
  id: true,
  created_at: true,
  actor_kind: true,
  actor_issuer: true,
  actor_subject: true,
  actor_display: true,
  operation: true,
  resource_type: true,
  resource_id: true,
  outcome: true,
  request_id: true,
  delta: true,
} as const;
