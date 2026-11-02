import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsIn,
  IsISO8601,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { ApiError } from '../common/errors.js';
import type { CredentialScope } from '../auth/principal.js';
import type { Prisma } from '../generated/prisma/client.js';

export const CREDENTIAL_SCOPES: readonly CredentialScope[] = Object.freeze([
  'metrics:write',
  'provisioning:read',
  'config:report',
]);
export class IssueDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Client-generated operation ID; retry after commit returns409 safe metadata, never the secret again.',
  })
  @IsUUID('all')
  issuance_request_id!: string;
  @ApiProperty({
    required: false,
    type: [String],
    enum: CREDENTIAL_SCOPES,
    minItems: 1,
    maxItems: 3,
    uniqueItems: true,
  })
  @ValidateIf((_o, v) => v !== undefined)
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(3)
  @ArrayUnique()
  @IsIn(CREDENTIAL_SCOPES, { each: true })
  scopes?: CredentialScope[];
  @ApiProperty({
    required: false,
    format: 'date-time',
    description:
      'Future RFC3339 deadline, max365 days from DB time. Default30 days.',
  })
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/)
  expires_at?: string;
}
export class RotateDto extends IssueDto {}
export class VerifyDto {
  @ApiProperty({
    writeOnly: true,
    maxLength: 8192,
    description:
      'Exact API Key; never normalize, log, or place in a URL. Whole JSON request cap8KiB.',
  })
  @IsString()
  @MaxLength(8192)
  api_key!: string;
}
export const credentialSelect = {
  id: true,
  agent_id: true,
  public_prefix: true,
  scopes: true,
  expires_at: true,
  retire_at: true,
  revoked_at: true,
  rotated_from_id: true,
  issuance_request_id: true,
  created_at: true,
  agent: {
    select: {
      server_id: true,
      lifecycle: true,
      server: { select: { archived_at: true } },
    },
  },
} as const;
export type CredentialRow = Prisma.ApiCredentialGetPayload<{
  select: typeof credentialSelect;
}>;
export class CredentialDto {
  @ApiProperty({ format: 'uuid' }) readonly id!: string;
  @ApiProperty({ format: 'uuid' }) readonly agent_id!: string;
  @ApiProperty({ format: 'uuid' }) readonly server_id!: string;
  @ApiProperty({ description: 'Public ID prefix, never secret bytes.' })
  readonly public_prefix!: string;
  @ApiProperty({ type: [String], enum: CREDENTIAL_SCOPES })
  readonly scopes!: readonly CredentialScope[];
  @ApiProperty({ format: 'date-time' }) readonly expires_at!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readonly retire_at!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readonly revoked_at!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  readonly rotated_from_id!: string | null;
  @ApiProperty({ format: 'uuid' }) readonly issuance_request_id!: string;
  @ApiProperty({ format: 'date-time' }) readonly created_at!: string;
  @ApiProperty({
    enum: ['active', 'rotating', 'expired', 'revoked', 'inactive'],
  })
  readonly status!: string;
}
export class IssuedCredentialDto extends CredentialDto {
  @ApiProperty({
    description:
      'One-time plaintext. Save securely now; lost response requires metadata/revoke/new operation ID. Never persist in browser storage or telemetry.',
  })
  readonly api_key!: string;
}
export class IssuanceConflict extends ApiError {
  constructor(readonly credential: CredentialDto) {
    super('secret_already_issued');
  }
}
export type Verification =
  | { active: false }
  | {
      active: true;
      credential_id: string;
      server_id: string;
      agent_id: string;
      scopes: readonly CredentialScope[];
      expires_at: string;
      cache_ttl_ms: number;
    };
export function effectiveUntil(row: {
  expires_at: Date;
  retire_at: Date | null;
}): number {
  return Math.min(
    row.expires_at.getTime(),
    row.retire_at?.getTime() ?? Infinity,
  );
}
export function credentialDto(row: CredentialRow, now: Date): CredentialDto {
  return {
    id: row.id,
    agent_id: row.agent_id,
    server_id: row.agent.server_id,
    public_prefix: row.public_prefix,
    scopes: row.scopes as CredentialScope[],
    expires_at: row.expires_at.toISOString(),
    retire_at: row.retire_at?.toISOString() ?? null,
    revoked_at: row.revoked_at?.toISOString() ?? null,
    rotated_from_id: row.rotated_from_id,
    issuance_request_id: row.issuance_request_id,
    created_at: row.created_at.toISOString(),
    status: row.revoked_at
      ? 'revoked'
      : effectiveUntil(row) <= now.getTime()
        ? 'expired'
        : row.agent.lifecycle !== 'active' || row.agent.server.archived_at
          ? 'inactive'
          : row.retire_at
            ? 'rotating'
            : 'active',
  };
}
