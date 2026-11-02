import type { INestApplication } from '@nestjs/common';
import type { SchemaObject } from '@nestjs/swagger';
import {
  ApiProperty,
  DocumentBuilder,
  SwaggerModule,
  getSchemaPath,
} from '@nestjs/swagger';
import { ServerDto } from '../servers/servers.dto.js';
import { GroupDto } from '../groups/groups.dto.js';
import { AgentDto } from '../agents/agents.dto.js';
import { EpochDto, EpochOpenDto, ObservationRecordDto, ReportAckDto, ReportChunkDto, StatusDto } from '../status/status.dto.js';
import { AuditDto } from '../audit/audit.dto.js';
import {
  ProfileDto,
  ProfileDetailDto,
  ProfileVersionDto,
  AssignmentDto,
  CreateProfileDto,
  PatchProfileDto,
  ProfileVersionInput,
  AssignmentInput,
} from '../profiles/profiles.dto.js';
import {
  CredentialDto,
  IssuedCredentialDto,
  IssueDto,
  RotateDto,
  VerifyDto,
} from '../credentials/credentials.dto.js';

import {
  ConfigReportDto,
  ProvisioningDto,
  ProvisionedProfileDto,
  IngestionRequirementsDto,
} from '../provisioning/provisioning.dto.js';

export function inventoryPageSchema(model: string) {
  return {
    type: 'object' as const,
    required: ['items', 'next_cursor'],
    properties: {
      items: { type: 'array' as const, items: { $ref: getSchemaPath(model) } },
      next_cursor: {
        type: 'string' as const,
        nullable: true,
        description: 'Opaque validated continuation cursor; null at end.',
      },
    },
  };
}

export class ApiErrorDto {
  @ApiProperty({ description: 'Finite sanitized error code.' }) code!: string;
  @ApiProperty({ description: 'Finite public message; no exception detail.' })
  message!: string;
  @ApiProperty({ format: 'uuid' }) request_id!: string;
}
export class MeDto {
  @ApiProperty({ enum: ['user'] }) kind!: 'user';
  @ApiProperty() issuer!: string;
  @ApiProperty({
    description: 'Stable opaque subject, never inferred from a username.',
  })
  subject!: string;
  @ApiProperty() context!: string;
  @ApiProperty({ enum: ['Viewer', 'Operator', 'Admin'] }) role!: string;
  @ApiProperty({ required: false, maxLength: 128 }) display?: string;
}
export function managementOpenApi(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('InfraPulse Management')
    .setVersion('1')
    .setDescription(
      'Default deny. Per-request signed method, exact raw target and body; nonce is single use. User Viewer/Operator read only; Admin mutations. Internal scopes are server-owned; Agents use separate credentials. Secret issue/rotate responses are one-time and Cache-Control: no-store. Signed HTTP does not replace TLS.',
    )
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'Ed25519 JWT',
        description:
          'User assertion, maximum 60 seconds; org role and default context required.',
      },
      'AdminAssertion',
    )
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'Agent API Key',
        description: 'Own Agent and required credential scope only.',
      },
      'AgentApiKey',
    )
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'Ed25519 JWT',
        description:
          'Internal service assertion; trusted server scope map, never Admin.',
      },
      'InternalServiceAssertion',
    )
    .build();
  const document = SwaggerModule.createDocument(app, config, {
    extraModels: [
      ApiErrorDto,
      EpochDto,
      EpochOpenDto,
      ObservationRecordDto,
      ReportAckDto,
      ReportChunkDto,
      StatusDto,
      MeDto,
      ServerDto,
      GroupDto,
      AgentDto,
      AuditDto,
      CredentialDto,
      IssuedCredentialDto,
      IssueDto,
      RotateDto,
      VerifyDto,
      ProfileDto,
      ProfileDetailDto,
      ProfileVersionDto,
      AssignmentDto,
      CreateProfileDto,
      PatchProfileDto,
      ProfileVersionInput,
      AssignmentInput,
      ConfigReportDto,
      ProvisioningDto,
      ProvisionedProfileDto,
      IngestionRequirementsDto,
    ],
  });
  const schemas = document.components!.schemas!;
  const strings = {
    type: 'array' as const,
    maxItems: 64,
    items: { type: 'string' as const, minLength: 1, maxLength: 128 },
    description:
      'No controls, invalid Unicode, shell/template expressions, URLs or secrets.',
  };
  const options = (linux: boolean): SchemaObject => ({
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      disk: {
        type: 'object' as const,
        additionalProperties: false,
        properties: linux
          ? {
              exclude_filesystems: strings,
              mount_points: {
                ...strings,
                items: { ...strings.items, pattern: '^/' },
              },
            }
          : { include_volumes: strings },
      },
      network: {
        type: 'object' as const,
        additionalProperties: false,
        properties: { interfaces: strings },
      },
    },
  });
  schemas.ProfileConfigV1 = {
    type: 'object',
    additionalProperties: false,
    required: ['schema_version', 'os', 'metric_groups', 'options'],
    description:
      'Validated64KiB UTF8 JSON; RFC8785 SHA256. Duplicate keys, invalid Unicode and nonfinite/unsafe numbers rejected. Exactly four metric groups; no system/plugin/renderer fields.',
    properties: {
      schema_version: { type: 'integer', enum: [1] },
      os: { type: 'string', enum: ['linux', 'windows'] },
      interval_seconds: {
        type: 'integer',
        minimum: 5,
        maximum: 300,
        default: 15,
      },
      metric_groups: {
        type: 'object',
        additionalProperties: false,
        required: ['cpu', 'memory', 'disk', 'network'],
        properties: {
          cpu: { type: 'boolean' },
          memory: { type: 'boolean' },
          disk: { type: 'boolean' },
          network: { type: 'boolean' },
        },
      },
      options: { type: 'object', additionalProperties: true },
    },
    oneOf: [
      {
        properties: {
          os: { type: 'string', enum: ['linux'] },
          options: options(true),
        },
      },
      {
        properties: {
          os: { type: 'string', enum: ['windows'] },
          options: options(false),
        },
      },
    ],
  };
  for (const name of [
    'ProfileVersionDto',
    'ProfileVersionInput',
    'ProvisionedProfileDto',
  ]) {
    const schema = schemas[name];
    if (schema && 'properties' in schema)
      schema.properties!.config = {
        $ref: '#/components/schemas/ProfileConfigV1',
      };
  }
  for (const name of [
    'CreateProfileDto',
    'PatchProfileDto',
    'ProfileVersionInput',
    'AssignmentInput',
    'ConfigReportDto',
    'EpochOpenDto',
    'ReportChunkDto',
    'ObservationRecordDto',
  ]) {
    const schema = schemas[name];
    if (schema && 'properties' in schema) schema.additionalProperties = false;
  }
  return document;
}
// Programmatic lab opt-in only. No new auth/docs environment switch, no default public docs route.
export function installOpenApi(
  app: INestApplication,
  options: { enabled: boolean; listenHost: string } = {
    enabled: false,
    listenHost: '127.0.0.1',
  },
): void {
  if (!options.enabled) return;
  if (!['127.0.0.1', '::1'].includes(options.listenHost))
    throw new Error('Loopback docs required.');
  app.use(
    '/docs',
    (
      req: { socket: { remoteAddress?: string } },
      res: { status(code: number): { end(): void } },
      next: () => void,
    ) => {
      if (
        !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
          req.socket.remoteAddress ?? '',
        )
      ) {
        res.status(404).end();
        return;
      }
      next();
    },
  );
  SwaggerModule.setup('docs', app, managementOpenApi(app), {
    swaggerOptions: { persistAuthorization: false },
    raw: false,
  });
}
