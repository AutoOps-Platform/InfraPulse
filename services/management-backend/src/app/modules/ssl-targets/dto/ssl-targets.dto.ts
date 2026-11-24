import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import type { SslTarget } from '../../../../generated/prisma/client.js';

export class CreateSslTargetDto {
  @ApiProperty({ maxLength: 128 })
  @IsString()
  @Length(1, 128)
  name!: string;

  @ApiProperty({ maxLength: 253, description: 'Public DNS hostname without scheme or path.' })
  @IsString()
  @Length(1, 253)
  host!: string;

  @ApiPropertyOptional({ default: 443, minimum: 1, maximum: 65535 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @ApiPropertyOptional({ default: 'default', maxLength: 64 })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  group?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class PatchSslTargetDto {
  @ApiPropertyOptional({ maxLength: 128 })
  @IsOptional()
  @IsString()
  @Length(1, 128)
  name?: string;

  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  group?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class SslTargetDto {
  @ApiProperty({ format: 'uuid' }) readonly id!: string;
  @ApiProperty() readonly name!: string;
  @ApiProperty() readonly host!: string;
  @ApiProperty() readonly port!: number;
  @ApiProperty() readonly group!: string;
  @ApiProperty() readonly enabled!: boolean;
  @ApiProperty({ type: String, nullable: true }) readonly subjectCn!: string | null;
  @ApiProperty({ type: String, nullable: true }) readonly issuerCn!: string | null;
  @ApiProperty({ type: String, nullable: true }) readonly serialNumber!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) readonly notBefore!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) readonly notAfter!: string | null;
  @ApiProperty({ type: Boolean, nullable: true }) readonly authorized!: boolean | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) readonly lastProbedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) readonly lastError!: string | null;
  @ApiProperty({ format: 'date-time' }) readonly createdAt!: string;
  @ApiProperty({ format: 'date-time' }) readonly updatedAt!: string;
}

export function sslTargetDto(row: SslTarget): SslTargetDto {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    group: row.group_name,
    enabled: row.enabled,
    subjectCn: row.subject_cn,
    issuerCn: row.issuer_cn,
    serialNumber: row.serial_number,
    notBefore: row.not_before ? row.not_before.toISOString() : null,
    notAfter: row.not_after ? row.not_after.toISOString() : null,
    authorized: row.authorized,
    lastProbedAt: row.last_probed_at ? row.last_probed_at.toISOString() : null,
    lastError: row.last_error,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
