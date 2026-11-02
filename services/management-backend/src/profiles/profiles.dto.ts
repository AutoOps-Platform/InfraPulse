import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsString,
  Length,
  Matches,
  Validate,
  ValidateIf,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import type { Prisma } from '../generated/prisma/client.js';
import { ApiError } from '../common/errors.js';
import {
  validateProfileConfig,
  type ProfileConfigV1,
  type ProfileOs,
} from './profile-config.js';

@ValidatorConstraint({ name: 'profileConfiguration', async: false })
class ProfileConfiguration implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    // Let the finite ApiError carry 413 rather than losing the size distinction.
    validateProfileConfig(value, (value as ProfileConfigV1)?.os);
    return true;
  }
}
export class CreateProfileDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 128,
    pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
  })
  @IsString()
  @Length(1, 128)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  slug!: string;
  @ApiProperty({ minLength: 1, maxLength: 128 })
  @IsString()
  @Length(1, 128)
  @Matches(/^[^\u0000-\u001f\u007f]+$/u)
  name!: string;
  @ApiProperty({ maxLength: 512 })
  @IsString()
  @Length(0, 512)
  @Matches(/^[^\u0000-\u001f\u007f]*$/u)
  description!: string;
  @ApiProperty({ enum: ['linux', 'windows'] })
  @IsIn(['linux', 'windows'])
  os!: ProfileOs;
}
export class PatchProfileDto {
  @ApiProperty({ required: false, minLength: 1, maxLength: 128 })
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @Length(1, 128)
  @Matches(/^[^\u0000-\u001f\u007f]+$/u)
  name?: string;
  @ApiProperty({ required: false, maxLength: 512 })
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @Length(0, 512)
  @Matches(/^[^\u0000-\u001f\u007f]*$/u)
  description?: string;
}
export class ProfileVersionInput {
  @ApiProperty({
    type: 'object',
    additionalProperties: false,
    description:
      'ProfileConfigV1; validated OS-specific JSON, UTF8 ≤64KiB; no shell/template/URL/secrets. Interval defaults to15.',
  })
  @Validate(ProfileConfiguration)
  config!: ProfileConfigV1;
}
export class AssignmentInput {
  @ApiProperty({
    format: 'uuid',
    description: 'Exact immutable published version UUID, never latest.',
  })
  @IsString()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  profile_version_id!: string;
}
export function emptyProfileBody(value: unknown): void {
  if (value === undefined) return;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length
  )
    throw new ApiError('invalid_request');
}
export const profileSelect = {
  id: true,
  slug: true,
  name: true,
  description: true,
  os: true,
  retired_at: true,
  created_at: true,
  updated_at: true,
} as const;
export class ProfileDto {
  @ApiProperty({ format: 'uuid' }) readonly id!: string;
  @ApiProperty() readonly slug!: string;
  @ApiProperty() readonly name!: string;
  @ApiProperty() readonly description!: string;
  @ApiProperty({ enum: ['linux', 'windows'] }) readonly os!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readonly retired_at!: string | null;
  @ApiProperty({ format: 'date-time' }) readonly created_at!: string;
  @ApiProperty({ format: 'date-time' }) readonly updated_at!: string;
}
export function profileDto(
  row: Prisma.MonitoringProfileGetPayload<{ select: typeof profileSelect }>,
): ProfileDto {
  return {
    ...row,
    retired_at: row.retired_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
export const versionSelect = {
  id: true,
  profile_id: true,
  version: true,
  config: true,
  checksum: true,
  status: true,
  created_at: true,
  published_at: true,
} as const;
export class ProfileVersionDto {
  @ApiProperty({ format: 'uuid' }) readonly id!: string;
  @ApiProperty({ format: 'uuid' }) readonly profile_id!: string;
  @ApiProperty({ minimum: 1 }) readonly version!: number;
  @ApiProperty({ type: 'object', additionalProperties: false })
  readonly config!: ProfileConfigV1;
  @ApiProperty({ pattern: '^[0-9a-f]{64}$' }) readonly checksum!: string;
  @ApiProperty({ enum: ['draft', 'published'] }) readonly status!: string;
  @ApiProperty({ format: 'date-time' }) readonly created_at!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readonly published_at!: string | null;
}
export function versionDto(
  row: Prisma.ProfileVersionGetPayload<{ select: typeof versionSelect }>,
): ProfileVersionDto {
  return {
    ...row,
    config: row.config as unknown as ProfileConfigV1,
    created_at: row.created_at.toISOString(),
    published_at: row.published_at?.toISOString() ?? null,
  };
}
export class ProfileDetailDto extends ProfileDto {
  @ApiProperty({
    type: () => [ProfileVersionDto],
    description:
      'Bounded to100 versions; use paginated versions route for further history.',
  })
  readonly versions!: readonly ProfileVersionDto[];
}
export class AssignmentDto {
  @ApiProperty({ format: 'uuid' }) readonly server_id!: string;
  @ApiProperty({ format: 'uuid' }) readonly profile_version_id!: string;
  @ApiProperty({ format: 'date-time' }) readonly assigned_at!: string;
}
