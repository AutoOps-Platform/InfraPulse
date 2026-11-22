import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsString,
  Length,
  Validate,
  ValidateIf,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import type { AgentAvailability } from '../../../../config/app.config.js';
import type { Prisma } from '../../../../generated/prisma/client.js';
import {
  emptyAgent,
  type AgentMetadata,
  type CommandObservation,
} from '../../../../integrations/aws/aws.port.js';
import { ApiError } from '../../../common/errors.js';
import { HASH_PATTERN, IsSafeText, hasControlChars } from '../../../common/pagination.js';
import {
  ALERT_SYNC_STATES,
  BINDING_STATES,
  ONBOARDING_ERROR_CODES,
  ONBOARDING_STAGES,
  ONBOARDING_STATES,
  type AlertSyncState,
  type BindingState,
  type OnboardingProgress,
} from '../../onboarding/dto/onboarding.dto.js';
import {
  classifyHealth,
  exact,
  isoTime,
} from '../../onboarding/services/metric-verifier.service.js';

const RESERVED_METADATA_KEYS = new Set([
  'password',
  'secret',
  'token',
  'api_key',
  'authorization',
]);

@ValidatorConstraint({ name: 'inventoryMetadata', async: false })
class InventoryMetadata implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

    const visitNode = (item: unknown, depth: number): boolean => {
      if (depth > 4) return false;
      if (item === null || typeof item === 'boolean') return true;
      if (typeof item === 'number') return Number.isFinite(item);
      if (typeof item === 'string') return item.length <= 512 && !hasControlChars(item);
      if (Array.isArray(item)) return item.every((child) => visitNode(child, depth + 1));
      if (typeof item !== 'object') return false;
      return Object.entries(item).every(
        ([key, child]) =>
          key.length > 0 &&
          key.length <= 64 &&
          !hasControlChars(key) &&
          !RESERVED_METADATA_KEYS.has(key.toLowerCase()) &&
          visitNode(child, depth + 1),
      );
    };

    try {
      return Buffer.byteLength(JSON.stringify(value), 'utf8') <= 4096 && visitNode(value, 1);
    } catch {
      return false;
    }
  }
}

export class CreateServerDto {
  @ApiProperty({ minLength: 1, maxLength: 128 })
  @IsString()
  @Length(1, 128)
  @IsSafeText(1, 128)
  name!: string;

  @ApiProperty({ enum: ['linux', 'windows'] })
  @IsIn(['linux', 'windows'])
  os!: 'linux' | 'windows';

  @ApiProperty({ minLength: 1, maxLength: 64 })
  @IsString()
  @Length(1, 64)
  @IsSafeText(1, 64)
  environment!: string;

  @ApiProperty({ selfRequired: false, type: 'object', additionalProperties: true })
  @ValidateIf((_o, value) => value !== undefined)
  @Validate(InventoryMetadata)
  metadata?: Prisma.InputJsonObject;
}

export class PatchServerDto {
  @ApiProperty({ required: false, minLength: 1, maxLength: 128 })
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @Length(1, 128)
  @IsSafeText(1, 128)
  name?: string;

  @ApiProperty({ required: false, enum: ['linux', 'windows'] })
  @ValidateIf((_o, v) => v !== undefined)
  @IsIn(['linux', 'windows'])
  os?: 'linux' | 'windows';

  @ApiProperty({ required: false, minLength: 1, maxLength: 64 })
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @Length(1, 64)
  @IsSafeText(1, 64)
  environment?: string;

  @ApiProperty({ selfRequired: false, type: 'object', additionalProperties: true })
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
  onboarding_state: true,
  onboarding_generation: true,
  onboarding_attempts: {
    orderBy: { generation: 'desc' },
    take: 1,
    select: {
      id: true,
      enrollment_id: true,
      generation: true,
      state: true,
      stage: true,
      activation_expires_at: true,
      next_run_at: true,
      error_code: true,
      desired_preset_hash: true,
      config_started_at: true,
      config_applied_at: true,
      configuration_version: true,
      command_intent: true,
      command_observation: true,
      verified_observation: true,
      agent_metadata: true,
    },
  },
  managed_node_bindings: {
    orderBy: { generation: 'desc' },
    take: 1,
    select: {
      server_id: true,
      managed_node_id: true,
      platform: true,
      account_id: true,
      region: true,
      desired_preset_hash: true,
      state: true,
      generation: true,
      enrollment_id: true,
      monitoring_health: true,
      last_observed_sample_at: true,
      last_successful_query_at: true,
      alert_receipt: {
        select: {
          state: true,
          generation: true,
          desired_hash: true,
          synced_at: true,
          owned_uids: true,
        },
      },
    },
  },
} as const;

export interface DashboardContext {
  serverId: string;
  nodeId: string;
  enrollmentId: string;
  generation: number;
  platform: 'linux' | 'windows';
  presetHash: string;
  state: 'Active';
  resources: { id: string; dimensions: { name: string; value: string }[] }[];
}

export interface ConfigurationObservation {
  version: string | null;
  status: CommandObservation['status'] | null;
  requestedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export class ServerDto {
  @ApiProperty({ type: 'object', additionalProperties: false })
  readonly configuration!: ConfigurationObservation;
  @ApiProperty({ type: [String] }) readonly alertRuleUids!: string[];
  @ApiProperty({ type: 'object', additionalProperties: false })
  readonly onboarding!: OnboardingProgress;
  @ApiProperty({ type: 'object', additionalProperties: false, nullable: true })
  readonly dashboardContext!: DashboardContext | null;
  @ApiProperty({ format: 'uuid' }) readonly id!: string;
  @ApiProperty({ minLength: 1, maxLength: 128 }) readonly name!: string;
  @ApiProperty({ enum: ['linux', 'windows'] }) readonly os!: string;
  @ApiProperty({ minLength: 1, maxLength: 64 }) readonly environment!: string;
  @ApiProperty({ type: 'object', additionalProperties: true }) readonly metadata!: Prisma.JsonValue;
  @ApiProperty({ format: 'date-time' }) readonly created_at!: string;
  @ApiProperty({ format: 'date-time' }) readonly updated_at!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readonly archived_at!: string | null;
}

export const SERVER_FILTERS = Object.freeze([
  'os',
  'environment',
  'group',
  'archive',
  'name',
] as const);

function toIsoTimestamp(value: Date | null | undefined): string | null {
  return value instanceof Date &&
    Number.isFinite(value.getTime()) &&
    value.getUTCFullYear() >= 0 &&
    value.getUTCFullYear() <= 9999
    ? value.toISOString()
    : null;
}

function projectDashboardContext(
  row: Prisma.ServerGetPayload<{ select: typeof serverSelect }>,
  now: Date,
): DashboardContext | null {
  try {
    const a = row.onboarding_attempts[0];
    const b = row.managed_node_bindings[0];
    if (
      row.archived_at !== null ||
      row.onboarding_state !== 'Success' ||
      !a ||
      a.state !== 'Success' ||
      a.stage !== 'Complete' ||
      a.generation !== row.onboarding_generation ||
      !b ||
      b.state !== 'Active' ||
      b.server_id !== row.id ||
      b.generation !== a.generation ||
      b.enrollment_id !== a.enrollment_id ||
      b.platform !== row.os ||
      b.account_id !== '491333778094' ||
      b.region !== 'ap-southeast-1' ||
      !/^mi-[a-f0-9]{17}$/.test(b.managed_node_id) ||
      !HASH_PATTERN.test(a.desired_preset_hash) ||
      b.desired_preset_hash !== a.desired_preset_hash ||
      !a.configuration_version ||
      !HASH_PATTERN.test(a.configuration_version) ||
      !a.config_applied_at ||
      !a.verified_observation
    ) {
      return null;
    }

    const r = exact(a.verified_observation, ['identity', 'commandId', 'finishedAt', 'resources']);
    const identity = exact(r.identity, [
      'serverId',
      'nodeId',
      'enrollmentId',
      'operationId',
      'platform',
      'configurationVersion',
    ]);
    const command = a.command_intent as { kind?: string; identity?: Record<string, unknown> } | null;
    const observation = a.command_observation as CommandObservation | null;

    if (
      identity.serverId !== row.id ||
      identity.enrollmentId !== a.enrollment_id ||
      identity.nodeId !== b.managed_node_id ||
      identity.platform !== row.os ||
      identity.configurationVersion !== a.configuration_version ||
      command?.kind !== 'Configure' ||
      !command.identity ||
      Object.keys(identity).some((k) => command.identity![k] !== identity[k]) ||
      observation?.status !== 'Success' ||
      observation.errorCode !== null ||
      observation.serviceState !== 'running' ||
      observation.commandId !== r.commandId ||
      !isoTime(r.finishedAt) ||
      observation.finishedAt !== r.finishedAt ||
      r.finishedAt !== toIsoTimestamp(a.config_applied_at) ||
      +a.config_applied_at > +now ||
      !Array.isArray(r.resources) ||
      r.resources.length < 1 ||
      r.resources.length > 32
    ) {
      return null;
    }

    const resources = r.resources.map((item: unknown) => {
      const res = exact(item, ['id', 'kind', 'dimensions']);
      if (
        !['cpu', 'memory', 'filesystem', 'interface'].includes(String(res.kind)) ||
        typeof res.id !== 'string' ||
        !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(res.id) ||
        !Array.isArray(res.dimensions) ||
        res.dimensions.length < 1 ||
        res.dimensions.length > 10
      ) {
        throw new Error();
      }
      const dimensions = res.dimensions.map((dim: unknown) => {
        const d = exact(dim, ['name', 'value']);
        if (
          typeof d.name !== 'string' ||
          !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(d.name) ||
          /hash|time|activation|code|secret|token|credential/i.test(d.name) ||
          ['ServerId', 'ManagedNodeId', 'EnrollmentId'].includes(d.name) ||
          typeof d.value !== 'string' ||
          !/^[\x20-\x7e]{1,256}$/.test(d.value) ||
          d.value.includes('${')
        ) {
          throw new Error();
        }
        return { name: d.name, value: d.value };
      });
      if (new Set(dimensions.map((d) => d.name)).size !== dimensions.length) throw new Error();
      return { id: res.id, dimensions };
    });

    if (new Set(resources.map((res) => res.id)).size !== resources.length) return null;
    return {
      serverId: row.id,
      nodeId: b.managed_node_id,
      enrollmentId: b.enrollment_id,
      generation: b.generation,
      platform: row.os as 'linux' | 'windows',
      presetHash: b.desired_preset_hash,
      state: 'Active',
      resources,
    };
  } catch {
    return null;
  }
}

function narrowChoice<T extends string>(value: string, choices: readonly T[]): T {
  const found = choices.find((item) => item === value);
  if (!found) throw new ApiError('dependency_unavailable');
  return found;
}

export function serverDto(
  row: Prisma.ServerGetPayload<{ select: typeof serverSelect }>,
  now: Date = new Date(),
  availability: AgentAvailability = {
    available: false,
    configurationVersion: null,
    reason: 'release_missing',
  },
): ServerDto {
  const {
    onboarding_attempts: attempts,
    managed_node_bindings: bindings,
    onboarding_state,
    onboarding_generation,
    ...inventory
  } = row;
  const attempt = attempts[0];
  const candidate = bindings[0];
  const binding =
    candidate?.generation === onboarding_generation &&
    candidate.enrollment_id === attempt?.enrollment_id
      ? candidate
      : undefined;
  const alert = binding?.alert_receipt;

  const bindingState: BindingState = binding
    ? narrowChoice(binding.state, BINDING_STATES)
    : 'Retired';

  if (
    attempt
      ? attempt.generation !== onboarding_generation || attempt.state !== onboarding_state
      : onboarding_generation !== 0 || onboarding_state !== 'Pending'
  ) {
    throw new ApiError('dependency_unavailable');
  }

  const sampleAt = toIsoTimestamp(binding?.last_observed_sample_at);
  const queryAt = toIsoTimestamp(binding?.last_successful_query_at);
  const health = classifyHealth({
    now,
    bindingState,
    queryStatus: binding && binding.monitoring_health !== 'Unknown' ? 'Complete' : 'Never',
    lastObservedSampleAt: sampleAt === null ? null : new Date(sampleAt),
    lastSuccessfulQueryAt: queryAt === null ? null : new Date(queryAt),
  });

  const onboarding: OnboardingProgress = {
    serverId: row.id,
    availability,
    agent: attempt?.agent_metadata
      ? (attempt.agent_metadata as unknown as AgentMetadata)
      : emptyAgent(),
    attemptId: attempt?.id ?? null,
    enrollmentId: attempt?.enrollment_id ?? null,
    generation: onboarding_generation,
    state: narrowChoice(onboarding_state, ONBOARDING_STATES),
    stage: attempt ? narrowChoice(attempt.stage, ONBOARDING_STAGES) : 'AwaitingBootstrap',
    bindingState: binding ? bindingState : null,
    expiresAt: toIsoTimestamp(attempt?.activation_expires_at),
    nextRunAt: toIsoTimestamp(attempt?.next_run_at),
    errorCode:
      attempt?.error_code === null || attempt?.error_code === undefined
        ? null
        : narrowChoice(attempt.error_code, ONBOARDING_ERROR_CODES),
    monitoring: {
      health,
      lastObservedSampleAt: health === 'Unknown' && sampleAt === null ? null : sampleAt,
      lastSuccessfulQueryAt: health === 'Unknown' && queryAt === null ? null : queryAt,
    },
    alertSync: alert
      ? {
          state: narrowChoice(alert.state, ALERT_SYNC_STATES) as AlertSyncState,
          generation: alert.generation,
          desiredHash: alert.desired_hash,
          syncedAt: toIsoTimestamp(alert.synced_at),
        }
      : {
          state: 'Pending',
          generation: onboarding_generation,
          desiredHash: null,
          syncedAt: null,
        },
  };

  const observation = attempt?.command_observation as unknown as CommandObservation | null;
  return {
    ...inventory,
    onboarding,
    alertRuleUids:
      alert?.state === 'Synced' &&
      alert.generation === onboarding_generation &&
      Array.isArray(alert.owned_uids)
        ? alert.owned_uids
            .filter((v): v is string => typeof v === 'string' && /^ip_[a-f0-9]{32}_[a-z0-9]{4}$/.test(v))
            .slice(0, 32)
        : [],
    configuration: {
      version: attempt?.configuration_version ?? null,
      status: observation?.status ?? null,
      requestedAt: observation?.requestedAt ?? null,
      startedAt: observation?.startedAt ?? null,
      finishedAt: observation?.finishedAt ?? null,
    },
    dashboardContext: projectDashboardContext(row, now),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    archived_at: row.archived_at?.toISOString() ?? null,
  };
}
