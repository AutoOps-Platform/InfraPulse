import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateIf,
} from 'class-validator';
import type { ProfileConfigV1 } from '../profiles/profile-config.js';

export class ConfigReportDto {
  @ApiProperty({
    format: 'uuid',
    example: '00000000-0000-4000-8000-000000000007',
    description:
      'Exact version previously provisioned to this Agent, including valid historical receipts.',
  })
  @IsUUID('all')
  profile_version_id!: string;
  @ApiProperty({
    pattern: '^[0-9a-f]{64}$',
    example: '0'.repeat(64),
    description:
      'SHA256 checksum from the provisioning receipt; placeholder example only.',
  })
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  checksum!: string;
  @ApiProperty({
    enum: ['applied', 'failed'],
    example: 'applied',
    description:
      'Agent-reported only, not proof that a binary/config is running.',
  })
  @IsIn(['applied', 'failed'])
  result!: 'applied' | 'failed';
  @ApiProperty({
    required: false,
    minLength: 1,
    maxLength: 128,
    pattern: '^[^\\u0000-\\u001f\\u007f]+$',
    example: '1.37.2',
    description: 'Reported binary version, never stdout, raw config or secret.',
  })
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @Length(1, 128)
  @Matches(/^[^\u0000-\u001f\u007f]+$/u)
  agent_version?: string;
}
export class ProvisionedProfileDto {
  @ApiProperty({
    format: 'uuid',
    example: '00000000-0000-4000-8000-000000000006',
  })
  readonly id!: string;
  @ApiProperty({
    format: 'uuid',
    example: '00000000-0000-4000-8000-000000000007',
  })
  readonly version_id!: string;
  @ApiProperty({ minimum: 1, example: 1 }) readonly version!: number;
  @ApiProperty({ pattern: '^[0-9a-f]{64}$', example: '0'.repeat(64) })
  readonly checksum!: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Immutable validated ProfileConfigV1, not rendered Telegraf TOML.',
  })
  readonly config!: ProfileConfigV1;
}
export class IngestionRequirementsDto {
  @ApiProperty({
    example: 'http://127.0.0.1:8000',
    description:
      'Trusted configured agent-facing origin. Default loopback is host-sender lab only, not a VM URL; HTTP signatures do not replace TLS.',
  })
  readonly base_url!: string;
  @ApiProperty({ enum: ['/api/v1/ingest/remote-write'] })
  readonly path!: '/api/v1/ingest/remote-write';
  @ApiProperty({ enum: ['application/x-protobuf'] })
  readonly content_type!: 'application/x-protobuf';
  @ApiProperty({ enum: ['snappy'] }) readonly content_encoding!: 'snappy';
  @ApiProperty({ enum: ['0.1.0'] }) readonly remote_write_version!: '0.1.0';
  @ApiProperty({
    enum: ['Bearer'],
    description:
      'Use the separately stored one-time issued key. No key is returned by provisioning.',
  })
  readonly authorization_scheme!: 'Bearer';
  @ApiProperty({
    type: 'object',
    additionalProperties: false,
    properties: {
      'X-Server-ID': { type: 'string', format: 'uuid' },
      'X-Agent-ID': { type: 'string', format: 'uuid' },
    },
    description:
      'Trusted proof identity. Optional ingest claims must match these IDs.',
  })
  readonly identity_headers!: { 'X-Server-ID': string; 'X-Agent-ID': string };
}
export class ProvisioningDto {
  @ApiProperty({
    format: 'uuid',
    example: '00000000-0000-4000-8000-000000000001',
  })
  readonly server_id!: string;
  @ApiProperty({
    format: 'uuid',
    example: '00000000-0000-4000-8000-000000000002',
  })
  readonly agent_id!: string;
  @ApiProperty({ enum: ['linux', 'windows'], example: 'linux' }) readonly os!:
    'linux' | 'windows';
  @ApiProperty({ type: ProvisionedProfileDto })
  readonly profile!: ProvisionedProfileDto;
  @ApiProperty({ type: IngestionRequirementsDto })
  readonly ingestion!: IngestionRequirementsDto;
}
