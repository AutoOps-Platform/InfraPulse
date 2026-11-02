import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsInt,
  IsISO8601,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const rfc3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
export class EpochOpenDto {
  @ApiProperty({ format: 'uuid' }) @IsDefined() @Matches(uuid) boot_id!: string;
  @ApiProperty({ format: 'date-time' })
  @IsDefined()
  @IsISO8601({ strict: true })
  @Matches(rfc3339)
  boot_started_at!: string;
  @ApiProperty({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  @IsDefined()
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  expected_epoch!: number;
}
export class EpochDto {
  @ApiProperty({ format: 'uuid' }) gateway_id!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) boot_id!:
    string | null;
  @ApiProperty({ minimum: 0 }) epoch!: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  activated_at!: string | null;
}
export class ObservationRecordDto {
  @ApiProperty({ format: 'uuid' })
  @IsDefined()
  @Matches(uuid)
  agent_id!: string;
  @ApiProperty({ format: 'uuid' })
  @IsDefined()
  @Matches(uuid)
  server_id!: string;
  @ApiProperty({ format: 'uuid' })
  @IsDefined()
  @Matches(uuid)
  credential_id!: string;
  @ApiProperty({ format: 'date-time' })
  @IsDefined()
  @IsISO8601({ strict: true })
  @Matches(rfc3339)
  last_success_at!: string;
}
export class ReportChunkDto {
  @ApiProperty({ minimum: 1 })
  @IsDefined()
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  epoch!: number;
  @ApiProperty({ minimum: 1 })
  @IsDefined()
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  sequence!: number;
  @ApiProperty({ format: 'date-time' })
  @IsDefined()
  @IsISO8601({ strict: true })
  @Matches(rfc3339)
  snapshot_start!: string;
  @ApiProperty({ format: 'date-time' })
  @IsDefined()
  @IsISO8601({ strict: true })
  @Matches(rfc3339)
  snapshot_end!: string;
  @ApiProperty() @IsDefined() @IsBoolean() gap!: boolean;
  @ApiProperty({ minimum: 0, maximum: 3 })
  @IsDefined()
  @IsInt()
  @Min(0)
  @Max(3)
  chunk_index!: number;
  @ApiProperty({ minimum: 1, maximum: 4 })
  @IsDefined()
  @IsInt()
  @Min(1)
  @Max(4)
  chunk_count!: number;
  @ApiProperty({ pattern: digest.source })
  @IsDefined()
  @IsString()
  @Matches(digest)
  snapshot_hash!: string;
  @ApiProperty({ pattern: digest.source })
  @IsDefined()
  @IsString()
  @Matches(digest)
  chunk_hash!: string;
  @ApiProperty({ type: [ObservationRecordDto], maxItems: 256 })
  @IsDefined()
  @IsArray()
  @ArrayMaxSize(256)
  @ValidateNested({ each: true })
  @Type(() => ObservationRecordDto)
  records!: ObservationRecordDto[];
}
export class ReportAckDto {
  @ApiProperty() epoch!: number;
  @ApiProperty() sequence!: number;
  @ApiProperty({ enum: ['staged', 'committed'] }) state!:
    'staged' | 'committed';
  @ApiProperty({ type: [Number], maxItems: 4 })
  accepted_chunk_indexes!: readonly number[];
}
export const STATUSES = ['Online', 'Stale', 'Offline', 'Unknown'] as const;
export const SOURCE_HEALTH = [
  'healthy',
  'stale',
  'gap',
  'unavailable',
] as const;
export const CONFIDENCE_REASONS = [
  'recent_success',
  'continuous_90s',
  'continuous_300s',
  'never_seen',
  'lifecycle_inactive',
  'no_active_agent',
  'source_unavailable',
  'source_stale',
  'coverage_gap',
  'insufficient_coverage',
  'before_boot',
  'clock_skew',
] as const;
export class StatusDto {
  @ApiProperty({ enum: STATUSES }) status!: (typeof STATUSES)[number];
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  last_metric_seen_at!: string | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Last complete observation, not the current wall clock; Offline does not mean powered off.',
  })
  status_as_of!: string | null;
  @ApiProperty({ enum: SOURCE_HEALTH })
  source_health!: (typeof SOURCE_HEALTH)[number];
  @ApiProperty({ enum: CONFIDENCE_REASONS })
  confidence_reason!: (typeof CONFIDENCE_REASONS)[number];
}
