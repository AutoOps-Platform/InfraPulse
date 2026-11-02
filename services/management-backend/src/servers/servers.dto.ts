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
import { ApiError } from '../common/errors.js';
import type { Page, PageSpec } from '../common/pagination.js';
import type { Prisma } from '../generated/prisma/client.js';
import { StatusDto } from '../status/status.dto.js';

const controls = /[\u0000-\u001f\u007f]/u;
const reserved = new Set([
  'password',
  'secret',
  'token',
  'api_key',
  'authorization',
]);
@ValidatorConstraint({ name: 'inventoryMetadata', async: false })
class InventoryMetadata implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return false;
    const visit = (item: unknown, depth: number): boolean => {
      if (depth > 4) return false;
      if (item === null || typeof item === 'boolean') return true;
      if (typeof item === 'number') return Number.isFinite(item);
      if (typeof item === 'string')
        return item.length <= 512 && !controls.test(item);
      if (Array.isArray(item))
        return item.every((child) => visit(child, depth + 1));
      if (typeof item !== 'object') return false;
      return Object.entries(item).every(
        ([key, child]) =>
          key.length > 0 &&
          key.length <= 64 &&
          !controls.test(key) &&
          !reserved.has(key.toLowerCase()) &&
          visit(child, depth + 1),
      );
    };
    try {
      return (
        Buffer.byteLength(JSON.stringify(value), 'utf8') <= 4096 &&
        visit(value, 1)
      );
    } catch {
      return false;
    }
  }
}
export class CreateServerDto {
  @ApiProperty({ minLength: 1, maxLength: 128 })
  @IsString()
  @Length(1, 128)
  @Matches(/^[^\u0000-\u001f\u007f]+$/u)
  name!: string;
  @ApiProperty({ enum: ['linux', 'windows'] }) @IsIn(['linux', 'windows']) os!:
    'linux' | 'windows';
  @ApiProperty({ minLength: 1, maxLength: 64 })
  @IsString()
  @Length(1, 64)
  @Matches(/^[^\u0000-\u001f\u007f]+$/u)
  environment!: string;
  @ApiProperty({
    selfRequired: false,
    type: 'object',
    additionalProperties: true,
    description:
      'Non-secret JSON object, UTF8 ≤4KiB, depth ≤4; reserved credential fields rejected recursively.',
  })
  @ValidateIf((_o, value) => value !== undefined)
  @Validate(InventoryMetadata)
  metadata?: Prisma.InputJsonObject;
}
export class PatchServerDto {
  @ApiProperty({ required: false, minLength: 1, maxLength: 128 })
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @Length(1, 128)
  @Matches(/^[^\u0000-\u001f\u007f]+$/u)
  name?: string;
  @ApiProperty({ required: false, enum: ['linux', 'windows'] })
  @ValidateIf((_o, v) => v !== undefined)
  @IsIn(['linux', 'windows'])
  os?: 'linux' | 'windows';
  @ApiProperty({ required: false, minLength: 1, maxLength: 64 })
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @Length(1, 64)
  @Matches(/^[^\u0000-\u001f\u007f]+$/u)
  environment?: string;
  @ApiProperty({
    selfRequired: false,
    type: 'object',
    additionalProperties: true,
  })
  @ValidateIf((_o, v) => v !== undefined)
  @Validate(InventoryMetadata)
  metadata?: Prisma.InputJsonObject;
}
export const serverSelect = {
  id: true,
  name: true,
  os: true,
  environment: true,
  metadata: true,
  created_at: true,
  updated_at: true,
  archived_at: true,
} as const;
export class ServerDto {
  @ApiProperty({ type: StatusDto }) readonly telemetry!: StatusDto;
  @ApiProperty({ format: 'uuid' }) readonly id!: string;
  @ApiProperty({ minLength: 1, maxLength: 128 }) readonly name!: string;
  @ApiProperty({ enum: ['linux', 'windows'] }) readonly os!: string;
  @ApiProperty({ minLength: 1, maxLength: 64 }) readonly environment!: string;
  @ApiProperty({ type: 'object', additionalProperties: true })
  readonly metadata!: Prisma.JsonValue;
  @ApiProperty({ format: 'date-time' }) readonly created_at!: string;
  @ApiProperty({ format: 'date-time' }) readonly updated_at!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readonly archived_at!: string | null;
}
export function serverDto(
  row: Prisma.ServerGetPayload<{ select: typeof serverSelect }>,
  telemetry: StatusDto,
): ServerDto {
  return {
    ...row,
    telemetry,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    archived_at: row.archived_at?.toISOString() ?? null,
  };
}
export const SERVER_FILTERS = Object.freeze([
  'os',
  'environment',
  'group',
  'archive',
  'name',
] as const);
export function inventoryId(value: string): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value,
    )
  )
    throw new ApiError('invalid_request');
  return value;
}
export function enumFilter(
  value: string | undefined,
  values: readonly string[],
): string | undefined {
  if (value !== undefined && !values.includes(value))
    throw new ApiError('invalid_request');
  return value;
}
// Prisma's unique cursor resolves native timestamptz precision in the database;
// using JS date comparison here would drop/duplicate microsecond-tied rows.
export async function pageCursor(
  page: PageSpec,
  find: (id: string) => Promise<{ created_at: Date } | null>,
): Promise<{ cursor?: { id: string }; skip?: number }> {
  if (!page.after) return {};
  const anchor = await find(page.after.id);
  if (!anchor || anchor.created_at.toISOString() !== page.after.created_at)
    throw new ApiError('invalid_request');
  return { cursor: { id: page.after.id }, skip: 1 };
}
export function inventoryPage<T extends { id: string; created_at: Date }, R>(
  rows: T[],
  page: PageSpec,
  map: (row: T) => R,
): Page<R> {
  const selected = rows.slice(0, page.limit);
  const last = selected.at(-1);
  return {
    items: selected.map(map),
    next_cursor:
      rows.length > page.limit && last
        ? Buffer.from(
            JSON.stringify({
              created_at: last.created_at.toISOString(),
              id: last.id,
            }),
          ).toString('base64url')
        : null,
  };
}
