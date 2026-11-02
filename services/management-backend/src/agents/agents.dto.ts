import { ApiProperty } from '@nestjs/swagger';
import { IsIn, ValidateIf } from 'class-validator';
import type { Prisma } from '../generated/prisma/client.js';
import { ApiError } from '../common/errors.js';
import { StatusDto } from '../status/status.dto.js';
export class RegisterAgentDto {
  @ApiProperty({ required: false, enum: ['telegraf'], default: 'telegraf' })
  @ValidateIf((_o, v) => v !== undefined)
  @IsIn(['telegraf'])
  agent_type?: 'telegraf';
}
// Unknown metatype intentionally bypasses global DTO transformation; this local
// empty-object validator rejects lifecycle mass-assignment, null and arrays.
export type AgentTransitionDto = Readonly<Record<string, never>>;
export function transitionBody(input: unknown): void {
  if (
    input !== undefined &&
    (!input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).length !== 0)
  )
    throw new ApiError('invalid_request');
}
export const AGENT_FILTERS = Object.freeze(['server', 'lifecycle'] as const);
export const agentSelect = {
  id: true,
  server_id: true,
  os_at_registration: true,
  agent_type: true,
  version: true,
  version_source: true,
  version_reported_at: true,
  lifecycle: true,
  last_metric_seen_at: true,
  registered_at: true,
  retired_at: true,
  created_at: true,
  updated_at: true,
  last_applied_profile_version_id: true,
  last_applied_at: true,
  last_config_report_result: true,
  last_config_report_at: true,
} as const;
export class AgentDto {
  @ApiProperty({ type: StatusDto }) readonly telemetry!: StatusDto;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) readonly last_metric_seen_at!: string | null;
  @ApiProperty({ format: 'uuid' }) readonly id!: string;
  @ApiProperty({ format: 'uuid' }) readonly server_id!: string;
  @ApiProperty({ enum: ['linux', 'windows'] })
  readonly os_at_registration!: string;
  @ApiProperty({ enum: ['telegraf'] }) readonly agent_type!: string;
  @ApiProperty({ type: String, nullable: true }) readonly version!:
    string | null;
  @ApiProperty({ type: String, nullable: true }) readonly version_source!:
    string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readonly version_reported_at!: string | null;
  @ApiProperty({
    enum: ['active', 'disabled', 'retired'],
    description: 'Authorization lifecycle, never an Online/Offline claim.',
  })
  readonly lifecycle!: string;
  @ApiProperty({ format: 'date-time' }) readonly registered_at!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readonly retired_at!: string | null;
  @ApiProperty({ format: 'date-time' }) readonly created_at!: string;
  @ApiProperty({ format: 'date-time' }) readonly updated_at!: string;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Last Agent-reported applied version, not independent verification; may differ from desired assignment.',
  })
  readonly last_applied_profile_version_id!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readonly last_applied_at!: string | null;
  @ApiProperty({
    type: String,
    enum: ['applied', 'failed'],
    nullable: true,
    description:
      'Agent-reported only. Failure retains previous applied version; never an Online claim.',
  })
  readonly last_config_report_result!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readonly last_config_report_at!: string | null;
}
export function agentDto(
  row: Prisma.AgentGetPayload<{ select: typeof agentSelect }>,
  telemetry: StatusDto,
): AgentDto {
  return {
    ...row,
    telemetry,
    last_metric_seen_at: telemetry.last_metric_seen_at,
    version_reported_at: row.version_reported_at?.toISOString() ?? null,
    last_applied_at: row.last_applied_at?.toISOString() ?? null,
    last_config_report_at: row.last_config_report_at?.toISOString() ?? null,
    registered_at: row.registered_at.toISOString(),
    retired_at: row.retired_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
