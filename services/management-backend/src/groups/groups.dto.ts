import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches, ValidateIf } from 'class-validator';
import type { Prisma } from '../generated/prisma/client.js';
export class CreateGroupDto {
  @ApiProperty({ minLength: 1, maxLength: 128 })
  @IsString()
  @Length(1, 128)
  @Matches(/^[^\u0000-\u001f\u007f]+$/u)
  name!: string;
  @ApiProperty({
    minLength: 1,
    maxLength: 64,
    pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
  })
  @IsString()
  @Length(1, 64)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  slug!: string;
}
export class PatchGroupDto {
  @ApiProperty({ required: false, minLength: 1, maxLength: 128 })
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @Length(1, 128)
  @Matches(/^[^\u0000-\u001f\u007f]+$/u)
  name?: string;
  @ApiProperty({
    required: false,
    minLength: 1,
    maxLength: 64,
    pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
  })
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @Length(1, 64)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  slug?: string;
}
export class GroupDto {
  @ApiProperty({ format: 'uuid' }) readonly id!: string;
  @ApiProperty({ minLength: 1, maxLength: 128 }) readonly name!: string;
  @ApiProperty({ minLength: 1, maxLength: 64 }) readonly slug!: string;
  @ApiProperty({ format: 'date-time' }) readonly created_at!: string;
  @ApiProperty({ format: 'date-time' }) readonly updated_at!: string;
}
export const groupSelect = {
  id: true,
  name: true,
  slug: true,
  created_at: true,
  updated_at: true,
} as const;
export function groupDto(
  row: Prisma.ServerGroupGetPayload<{ select: typeof groupSelect }>,
): GroupDto {
  return {
    ...row,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
// No generic query filters are enabled for groups.
export const GROUP_FILTERS = Object.freeze([] as const);
