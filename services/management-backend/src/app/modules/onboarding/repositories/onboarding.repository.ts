import { createHash, randomUUID } from 'node:crypto';
import { Injectable, Optional } from '@nestjs/common';
import {
  Prisma,
  type ManagedNodeBinding,
  type OnboardingAttempt,
} from '../../../../generated/prisma/client.js';
import {
  emptyAgent,
  terminalCommand,
  type AgentCommand,
  type AgentMetadata,
  type CommandObservation,
} from '../../../../integrations/aws/aws.port.js';
import { ApiError } from '../../../common/errors.js';
import { HASH_PATTERN, isSafeText, isUuid } from '../../../common/pagination.js';
import {
  PrismaService,
  databaseNow,
  lockServer,
  type Tx,
} from '../../../prisma/prisma.service.js';
import type { AuditEvent } from '../../audit/dto/audit.dto.js';
import { AuditService } from '../../audit/services/audit.service.js';
import {
  BINDING_STATES,
  MONITORING_HEALTH,
  ONBOARDING_ERROR_CODES,
  ONBOARDING_STAGES,
  ONBOARDING_STATES,
  PLATFORMS,
} from '../dto/onboarding.dto.js';
import type { CleanupState } from '../services/decommission.service.js';
import { validTime } from '../services/metric-verifier.service.js';
import {
  OnboardingRuntime,
  verifiedEvidence,
  type AttemptSnapshot,
  type BindingSnapshot,
  type PresetMatcher,
  type Transition,
} from '../services/onboarding-state.policy.js';

export type { PresetMatcher } from '../services/onboarding-state.policy.js';

export type IntentActor = Pick<AuditEvent['actor'], 'issuer' | 'subject' | 'display'>;

export interface DurableIntent {
  kind: AttemptSnapshot['intent'];
  requestId: string;
  presetVersionId: string;
  configurationVersion: string;
}

export type LeasedAttempt = AttemptSnapshot & { leaseOwner: string; leaseExpiresAt: Date };

export interface OnboardingStore {
  readonly recordIntent: (
    serverId: string,
    actor: IntentActor,
    intent: DurableIntent,
    now: Date,
  ) => Promise<AttemptSnapshot>;
  readonly claimDue: (limit: number, owner: string, now: Date) => Promise<LeasedAttempt[]>;
  readonly heartbeat: (
    id: string,
    generation: number,
    version: number,
    owner: string,
    now: Date,
  ) => Promise<LeasedAttempt | null>;
  readonly beginCommand: (
    a: LeasedAttempt,
    command: AgentCommand,
    previous: CommandObservation | null,
    now: Date,
  ) => Promise<LeasedAttempt | null>;
  readonly commitTransition: (
    id: string,
    generation: number,
    version: number,
    transition: Transition,
  ) => Promise<'Applied' | 'Fenced'>;
}

const INTENT_KINDS = ['bootstrap', 'retry-config', 'regenerate-unused', 'decommission'] as const;

const toJson = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

function narrowChoice<T extends string>(value: string, choices: readonly T[]): T {
  const found = choices.find((item) => item === value);
  if (!found) throw new ApiError('dependency_unavailable');
  return found;
}

function toBindingSnapshot(row: ManagedNodeBinding): BindingSnapshot {
  return {
    id: row.id,
    serverId: row.server_id,
    enrollmentId: row.enrollment_id,
    generation: row.generation,
    accountId: row.account_id,
    region: row.region,
    nodeId: row.managed_node_id,
    activationId: row.activation_id,
    platform: narrowChoice(row.platform, PLATFORMS),
    presetHash: row.desired_preset_hash,
    state: narrowChoice(row.state, BINDING_STATES),
    monitoringHealth: narrowChoice(row.monitoring_health, MONITORING_HEALTH),
    lastObservedSampleAt: row.last_observed_sample_at,
    lastSuccessfulQueryAt: row.last_successful_query_at,
  };
}

export function isKnownTransactionAbort(error: unknown): boolean {
  const e = error as {
    code?: unknown;
    meta?: { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } };
  } | null;
  if (!e) return false;
  const code = typeof e.code === 'string' ? e.code : '';
  const metaCode = typeof e.meta?.code === 'string' ? e.meta.code : '';
  const originalCode =
    typeof e.meta?.driverAdapterError?.cause?.originalCode === 'string'
      ? e.meta.driverAdapterError.cause.originalCode
      : '';
  return (
    code === 'P2034' ||
    ['40001', '40P01'].includes(code) ||
    (code === 'P2010' && ['40001', '40P01'].includes(metaCode)) ||
    ['40001', '40P01'].includes(originalCode)
  );
}

@Injectable()
export class OnboardingRepository implements OnboardingStore {
  private readonly presetMatches: PresetMatcher;

  constructor(
    private readonly db: PrismaService,
    private readonly audit: AuditService,
    @Optional() runtime?: OnboardingRuntime,
  ) {
    this.presetMatches = runtime?.presetMatches ?? (() => false);
  }

  private async transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    for (let n = 0; n < 3; n++) {
      try {
        return await this.db.$transaction(work);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (isKnownTransactionAbort(error) && n < 2) continue;
        const code =
          error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
            ? (error as { code: string }).code
            : '';
        throw new ApiError(
          ['P2002', 'P2004'].includes(code) ? 'conflict' : 'dependency_unavailable',
        );
      }
    }
    throw new ApiError('dependency_unavailable');
  }

  private async capacityLock(tx: Tx): Promise<void> {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(741703,3)::text`;
  }

  private async snapshot(
    tx: Tx,
    a: OnboardingAttempt,
    disposition: AttemptSnapshot['disposition'] = 'Existing',
  ): Promise<AttemptSnapshot> {
    const s = await tx.server.findUniqueOrThrow({
      where: { id: a.server_id },
      select: { os: true, onboarding_generation: true },
    });
    const b = await tx.managedNodeBinding.findFirst({
      where: { server_id: a.server_id, state: { not: 'Retired' } },
    });
    const last = await tx.onboardingAttempt.findFirst({
      where: {
        server_id: a.server_id,
        enrollment_id: a.enrollment_id,
        generation: { lt: a.generation },
        command_intent: { not: Prisma.DbNull },
      },
      orderBy: { generation: 'desc' },
    });
    const legacy = await tx.onboardingAttempt.count({
      where: {
        server_id: a.server_id,
        enrollment_id: a.enrollment_id,
        configuration_version: null,
        OR: [
          { association_id: { not: null } },
          { configure_dispatch_at: { not: null } },
          { config_started_at: { not: null } },
          { registered_at: { not: null } },
        ],
      },
    });

    return {
      id: a.id,
      serverId: a.server_id,
      enrollmentId: a.enrollment_id,
      generation: a.generation,
      currentGeneration: s.onboarding_generation,
      intent: narrowChoice(a.intent, INTENT_KINDS),
      platform: narrowChoice(s.os, PLATFORMS),
      state: narrowChoice(a.state, ONBOARDING_STATES),
      stage: narrowChoice(a.stage, ONBOARDING_STAGES),
      presetVersionId: a.desired_preset_version_id,
      presetHash: a.desired_preset_hash,
      configurationVersion: a.configuration_version,
      activationId: a.activation_id,
      activationExpiresAt: a.activation_expires_at,
      registeredAt: a.registered_at,
      configStartedAt: a.config_started_at,
      configAppliedAt: a.config_applied_at,
      registrationDeadline: a.registration_deadline,
      configurationDeadline: a.configuration_deadline,
      verificationDeadline: a.verification_deadline,
      errorCode: a.error_code === null ? null : narrowChoice(a.error_code, ONBOARDING_ERROR_CODES),
      retryCount: a.retry_count,
      retryCursor: a.retry_cursor,
      nextRunAt: a.next_run_at,
      createdAt: a.created_at,
      leaseOwner: a.lease_owner,
      leaseVersion: a.lease_version,
      leaseExpiresAt: a.lease_expires_at,
      binding: b ? toBindingSnapshot(b) : null,
      command: a.command_intent as unknown as AgentCommand | null,
      observation: a.command_observation as unknown as CommandObservation | null,
      previousCommand: last
        ? {
            command: last.command_intent as unknown as AgentCommand,
            observation: last.command_observation as unknown as CommandObservation | null,
          }
        : null,
      legacyReservation: legacy > 0,
      agent: a.agent_metadata ? (a.agent_metadata as unknown as AgentMetadata) : emptyAgent(),
      disposition,
    };
  }

  private async appendAudit(
    tx: Tx,
    a: OnboardingAttempt,
    operation:
      | 'onboarding_intent'
      | 'onboarding_transition'
      | 'decommission_intent'
      | 'decommission_transition',
    actor?: IntentActor,
    requestId = a.request_id,
  ): Promise<void> {
    await this.audit.append(tx, {
      actor: actor
        ? { kind: 'user', ...actor }
        : { kind: 'service', issuer: 'infrapulse', subject: 'onboarding-reconciler' },
      operation,
      target: { type: 'onboarding', id: a.id },
      outcome:
        ['Failed', 'Expired'].includes(a.state) || a.stage === 'CleanupRequired'
          ? 'failed'
          : 'success',
      request_id: requestId,
      delta: {
        server_id: a.server_id,
        attempt_id: a.id,
        enrollment_id: a.enrollment_id,
        generation: a.generation,
        state: a.state,
        stage: a.stage,
        error_code: a.error_code,
      },
    });
  }

  private async requestReceipt(tx: Tx, actor: IntentActor, requestId: string) {
    const rows = await tx.$queryRaw<{ attemptId: string; intent: string }[]>`
      SELECT attempt_id AS "attemptId", intent
      FROM onboarding_request_receipts
      WHERE actor_issuer=${actor.issuer}
        AND actor_subject=${actor.subject}
        AND request_id=${requestId}::uuid
    `;
    return rows[0] ?? null;
  }

  async recordIntent(
    serverId: string,
    actor: IntentActor,
    intent: DurableIntent,
    now: Date,
  ): Promise<AttemptSnapshot> {
    if (
      !isUuid(serverId) ||
      !intent ||
      !isUuid(intent.requestId) ||
      !isUuid(intent.presetVersionId) ||
      !HASH_PATTERN.test(intent.configurationVersion) ||
      !INTENT_KINDS.includes(intent.kind) ||
      !actor ||
      !isSafeText(actor.issuer, 128) ||
      !isSafeText(actor.subject, 128) ||
      (actor.display !== undefined && !isSafeText(actor.display, 128)) ||
      !validTime(now)
    ) {
      throw new ApiError('invalid_request');
    }

    return this.transaction(async (tx) => {
      await this.capacityLock(tx);
      await lockServer(tx, serverId);

      const receipt = await this.requestReceipt(tx, actor, intent.requestId);
      const old = await tx.onboardingAttempt.findUnique({
        where: {
          actor_issuer_actor_subject_request_id: {
            actor_issuer: actor.issuer,
            actor_subject: actor.subject,
            request_id: intent.requestId,
          },
        },
      });
      if (receipt || old) {
        const a = old ?? (await tx.onboardingAttempt.findUniqueOrThrow({ where: { id: receipt!.attemptId } }));
        if (
          a.server_id !== serverId ||
          (receipt?.intent ?? a.intent) !== intent.kind ||
          a.desired_preset_version_id !== intent.presetVersionId ||
          a.configuration_version !== intent.configurationVersion
        ) {
          throw new ApiError('conflict');
        }
        return this.snapshot(tx, a);
      }

      const s = await tx.server.findUniqueOrThrow({ where: { id: serverId } });
      if (s.archived_at) throw new ApiError('conflict');

      const previous = await tx.onboardingAttempt.findFirst({
        where: { server_id: serverId },
        orderBy: { generation: 'desc' },
      });
      const node = await tx.managedNodeBinding.findFirst({
        where: { server_id: serverId, state: { not: 'Retired' } },
      });
      const clock = await databaseNow(tx);

      if (previous?.lease_expires_at && +previous.lease_expires_at > +clock) {
        throw new ApiError('conflict');
      }

      if (intent.kind === 'decommission' && previous?.intent === 'decommission') {
        if (previous.stage === 'Retired') throw new ApiError('conflict');
        const a = await tx.onboardingAttempt.update({
          where: { id: previous.id },
          data: {
            stage: 'Decommissioning',
            error_code: null,
            next_run_at: clock,
            lease_owner: null,
            lease_expires_at: null,
            lease_version: { increment: 1 },
            updated_at: clock,
          },
        });
        await tx.decommissionProtocol.update({
          where: { attempt_id: a.id },
          data: { deadline: new Date(+clock + 1_800_000) },
        });
        await tx.$executeRaw`
          INSERT INTO onboarding_request_receipts(actor_issuer, actor_subject, request_id, attempt_id, intent)
          VALUES(${actor.issuer}, ${actor.subject}, ${intent.requestId}::uuid, ${a.id}::uuid, 'decommission')
        `;
        await this.appendAudit(tx, a, 'decommission_intent', actor, intent.requestId);
        return this.snapshot(tx, a);
      }

      if (
        intent.kind === 'regenerate-unused' &&
        previous?.intent === 'regenerate-unused' &&
        previous.stage === 'CleanupRequired'
      ) {
        if (
          node ||
          previous.actor_issuer !== actor.issuer ||
          previous.actor_subject !== actor.subject ||
          previous.activation_id ||
          previous.registered_at ||
          previous.command_intent ||
          previous.association_id ||
          previous.config_started_at ||
          previous.desired_preset_version_id !== intent.presetVersionId ||
          previous.configuration_version !== intent.configurationVersion ||
          (await tx.managedNodeBinding.count({ where: { server_id: serverId } })) ||
          (await tx.onboardingAttempt.count({ where: { lease_expires_at: { gt: clock } } })) >= 2
        ) {
          throw new ApiError('conflict');
        }
        const resumed = await tx.onboardingAttempt.update({
          where: { id: previous.id },
          data: {
            lease_owner: randomUUID(),
            lease_expires_at: new Date(+clock + 120_000),
            next_run_at: null,
            lease_version: { increment: 1 },
            updated_at: clock,
          },
        });
        await tx.$executeRaw`
          INSERT INTO onboarding_request_receipts(actor_issuer, actor_subject, request_id, attempt_id, intent)
          VALUES(${actor.issuer}, ${actor.subject}, ${intent.requestId}::uuid, ${resumed.id}::uuid, 'regenerate-unused')
        `;
        await this.appendAudit(tx, resumed, 'onboarding_intent', actor, intent.requestId);
        return this.snapshot(tx, resumed, 'Created');
      }

      if (intent.kind === 'retry-config') {
        if (
          !node ||
          node.state !== 'Active' ||
          !previous ||
          !['Failed', 'Success'].includes(previous.state) ||
          !terminalCommand(previous.command_observation as unknown as CommandObservation | null) ||
          !previous.command_intent
        ) {
          throw new ApiError('conflict');
        }
      }

      if (
        intent.kind === 'bootstrap' &&
        (node || (previous && (previous.stage !== 'Retired' || previous.next_run_at || previous.lease_owner)))
      ) {
        throw new ApiError('conflict');
      }

      if (
        intent.kind === 'decommission' &&
        (!previous ||
          (previous.command_intent &&
            !terminalCommand(previous.command_observation as unknown as CommandObservation | null)))
      ) {
        throw new ApiError('conflict');
      }

      if (
        intent.kind === 'regenerate-unused' &&
        (!previous ||
          node ||
          !['Pending', 'Failed', 'Expired'].includes(previous.state) ||
          ['Retired', 'CleanupRequired', 'Decommissioning', 'AwaitingBootstrap'].includes(previous.stage) ||
          previous.desired_preset_version_id !== intent.presetVersionId ||
          previous.registered_at ||
          previous.command_intent ||
          previous.config_started_at ||
          previous.association_id ||
          (await tx.managedNodeBinding.count({ where: { server_id: serverId } })))
      ) {
        throw new ApiError('conflict');
      }

      const preset = await tx.profileVersion.findFirst({
        where: { id: intent.presetVersionId, status: 'published', profile: { os: s.os } },
      });
      if (
        !preset ||
        (intent.kind !== 'decommission' &&
          !this.presetMatches(
            narrowChoice(s.os, PLATFORMS),
            preset.id,
            intent.configurationVersion,
            preset.checksum,
            preset.config,
          ))
      ) {
        throw new ApiError('provisioning_not_ready');
      }

      const createsActivation = ['bootstrap', 'regenerate-unused'].includes(intent.kind);
      if (createsActivation) {
        const slots = await tx.$queryRaw<{ n: number }[]>`
          SELECT count(DISTINCT server_id)::int AS n FROM (
            SELECT server_id FROM managed_node_bindings WHERE state<>'Retired'
            UNION
            SELECT a.server_id FROM onboarding_attempts a
            JOIN servers s ON s.id=a.server_id AND s.onboarding_generation=a.generation
            WHERE a.stage<>'Retired'
          ) reserved
        `;
        if (
          slots[0].n + (previous && previous.stage !== 'Retired' ? 0 : 1) > 5 ||
          (await tx.server.count({ where: { archived_at: null } })) > 5 ||
          (await tx.onboardingAttempt.count({ where: { lease_expires_at: { gt: clock } } })) >= 2
        ) {
          throw new ApiError('conflict');
        }
      }

      const registered = intent.kind === 'retry-config';
      const a = await tx.onboardingAttempt.create({
        data: {
          id: randomUUID(),
          server_id: serverId,
          enrollment_id:
            node?.enrollment_id ?? (intent.kind === 'decommission' ? previous!.enrollment_id : randomUUID()),
          generation: s.onboarding_generation + 1,
          intent: intent.kind,
          actor_issuer: actor.issuer,
          actor_subject: actor.subject,
          request_id: intent.requestId,
          desired_preset_version_id: preset.id,
          desired_preset_hash: preset.checksum,
          configuration_version: intent.configurationVersion,
          agent_metadata: node && previous?.agent_metadata ? toJson(previous.agent_metadata) : Prisma.DbNull,
          state: registered ? 'Registered' : 'Pending',
          stage: registered
            ? 'ApplyingConfig'
            : intent.kind === 'decommission'
              ? 'Decommissioning'
              : intent.kind === 'regenerate-unused'
                ? 'CleanupRequired'
                : 'CreatingActivation',
          error_code: intent.kind === 'regenerate-unused' ? 'cleanup_required' : null,
          registered_at: registered ? clock : null,
          configuration_deadline: registered ? new Date(+clock + 1_800_000) : null,
          registration_deadline: createsActivation ? new Date(+clock + 3_600_000) : null,
          next_run_at: intent.kind === 'regenerate-unused' ? null : clock,
          created_at: clock,
          updated_at: clock,
          lease_owner: createsActivation ? randomUUID() : null,
          lease_expires_at: createsActivation ? new Date(+clock + 120_000) : null,
        },
      });
      await tx.onboardingRequestReceipt.create({
        data: {
          actor_issuer: actor.issuer,
          actor_subject: actor.subject,
          request_id: intent.requestId,
          attempt_id: a.id,
          intent: intent.kind,
        },
      });
      await tx.server.update({
        where: { id: serverId },
        data: { onboarding_generation: a.generation, onboarding_state: a.state, updated_at: clock },
      });
      if (intent.kind === 'retry-config' || intent.kind === 'decommission') {
        await tx.managedNodeBinding.updateMany({
          where: { server_id: serverId, state: { not: 'Retired' } },
          data: {
            generation: a.generation,
            desired_preset_version_id: a.desired_preset_version_id,
            desired_preset_hash: a.desired_preset_hash,
            updated_at: clock,
            ...(intent.kind === 'decommission'
              ? { state: 'Decommissioning', monitoring_health: 'Unknown' }
              : {}),
          },
        });
      }

      if (registered) {
        await tx.managedNodeBinding.updateMany({
          where: { server_id: serverId, generation: a.generation, state: 'Active' },
          data: { monitoring_health: 'Unknown' },
        });
      }
      if (intent.kind === 'decommission') {
        await tx.decommissionProtocol.create({
          data: { attempt_id: a.id, deadline: new Date(+clock + 1_800_000), simple_phase: 'AwaitPrevious' },
        });
      }

      await this.appendAudit(
        tx,
        a,
        intent.kind === 'decommission' ? 'decommission_intent' : 'onboarding_intent',
        actor,
      );
      return this.snapshot(tx, a, 'Created');
    });
  }

  async current(serverId: string): Promise<AttemptSnapshot | null> {
    if (!isUuid(serverId)) throw new ApiError('invalid_request');
    return this.transaction(async (tx) => {
      const s = await tx.server.findUnique({ where: { id: serverId } });
      if (!s) throw new ApiError('not_found');
      const a = await tx.onboardingAttempt.findFirst({
        where: { server_id: serverId, generation: s.onboarding_generation },
      });
      return a ? this.snapshot(tx, a) : null;
    });
  }

  async regenerationSource(a: AttemptSnapshot): Promise<AttemptSnapshot | null> {
    return this.transaction(async (tx) => {
      const row = await tx.onboardingAttempt.findFirst({
        where: { server_id: a.serverId, generation: { lt: a.generation } },
        orderBy: { generation: 'desc' },
      });
      return row ? this.snapshot(tx, row) : null;
    });
  }

  async consumePreparedBootstrap(
    serverId: string,
    actor: IntentActor,
    intent: DurableIntent,
    now: Date,
  ): Promise<AttemptSnapshot | null> {
    if (
      !isUuid(serverId) ||
      !isUuid(intent.requestId) ||
      !isUuid(intent.presetVersionId) ||
      !HASH_PATTERN.test(intent.configurationVersion) ||
      intent.kind !== 'bootstrap' ||
      !validTime(now)
    ) {
      throw new ApiError('invalid_request');
    }

    return this.transaction(async (tx) => {
      await this.capacityLock(tx);
      await lockServer(tx, serverId);

      const receipt = await this.requestReceipt(tx, actor, intent.requestId);
      if (receipt) {
        const old = await tx.onboardingAttempt.findUniqueOrThrow({ where: { id: receipt.attemptId } });
        if (
          receipt.intent !== 'bootstrap' ||
          old.server_id !== serverId ||
          old.desired_preset_version_id !== intent.presetVersionId ||
          old.configuration_version !== intent.configurationVersion
        ) {
          throw new ApiError('conflict');
        }
        return this.snapshot(tx, old);
      }

      const s = await tx.server.findUniqueOrThrow({ where: { id: serverId } });
      if (s.archived_at) throw new ApiError('conflict');

      const a = await tx.onboardingAttempt.findFirst({
        where: { server_id: serverId, generation: s.onboarding_generation },
      });
      if (!a || a.stage !== 'AwaitingBootstrap') return null;

      const clock = await databaseNow(tx);
      if (
        a.intent !== 'regenerate-unused' ||
        a.actor_issuer !== actor.issuer ||
        a.actor_subject !== actor.subject ||
        a.state !== 'Pending' ||
        a.activation_id ||
        a.lease_owner ||
        a.next_run_at ||
        a.desired_preset_version_id !== intent.presetVersionId ||
        a.configuration_version !== intent.configurationVersion ||
        !/^unused-(?:deleted|denied)\.[a-f0-9-]{36}$/.test(a.retry_cursor ?? '') ||
        !a.registration_deadline ||
        +a.registration_deadline <= +clock ||
        (await tx.managedNodeBinding.count({ where: { server_id: serverId } })) ||
        (await tx.server.count({ where: { archived_at: null } })) > 5 ||
        (await tx.onboardingAttempt.count({ where: { lease_expires_at: { gt: clock } } })) >= 2
      ) {
        throw new ApiError('conflict');
      }

      const changed = await tx.onboardingAttempt.update({
        where: { id: a.id },
        data: {
          stage: 'CreatingActivation',
          error_code: null,
          next_run_at: clock,
          lease_owner: randomUUID(),
          lease_expires_at: new Date(+clock + 120_000),
          lease_version: { increment: 1 },
          updated_at: clock,
        },
      });
      await tx.$executeRaw`
        INSERT INTO onboarding_request_receipts(actor_issuer, actor_subject, request_id, attempt_id, intent)
        VALUES(${actor.issuer}, ${actor.subject}, ${intent.requestId}::uuid, ${a.id}::uuid, 'bootstrap')
      `;
      await this.appendAudit(tx, changed, 'onboarding_intent', actor, intent.requestId);
      return this.snapshot(tx, changed, 'Created');
    });
  }

  async finishUnusedRegeneration(
    a: AttemptSnapshot,
    outcome:
      | { kind: 'DeletedUnused'; activationId: string; sourceAttemptId: string }
      | { kind: 'DeniedAbsent'; sourceAttemptId: string }
      | { kind: 'CleanupRequired' },
    now: Date,
  ): Promise<'Applied' | 'Fenced'> {
    return this.transaction(async (tx) => {
      const row = await this.fenced(tx, a.id, a.generation, a.leaseVersion, a.leaseOwner, now);
      if (!row) return 'Fenced';
      if (row.intent !== 'regenerate-unused' || row.stage !== 'CleanupRequired') {
        throw new ApiError('conflict');
      }

      let marker: string | null = null;
      if (outcome.kind === 'DeletedUnused') {
        const old = await tx.onboardingAttempt.findFirst({
          where: { server_id: row.server_id, generation: { lt: row.generation } },
          orderBy: { generation: 'desc' },
        });
        if (
          !isUuid(outcome.activationId) ||
          !old ||
          old.id !== outcome.sourceAttemptId ||
          (old.activation_id && old.activation_id !== outcome.activationId) ||
          old.registered_at ||
          old.command_intent ||
          old.association_id ||
          old.config_started_at ||
          (await tx.managedNodeBinding.count({ where: { server_id: row.server_id } }))
        ) {
          throw new ApiError('conflict');
        }
        marker = `unused-deleted.${outcome.activationId}`;
      }

      if (outcome.kind === 'DeniedAbsent') {
        const old = await tx.onboardingAttempt.findFirst({
          where: { server_id: row.server_id, generation: { lt: row.generation } },
          orderBy: { generation: 'desc' },
        });
        if (
          !old ||
          old.id !== outcome.sourceAttemptId ||
          old.error_code !== 'permission_denied' ||
          old.activation_id ||
          old.registered_at ||
          old.command_intent ||
          old.association_id ||
          old.config_started_at ||
          (await tx.managedNodeBinding.count({ where: { server_id: row.server_id } }))
        ) {
          throw new ApiError('conflict');
        }
        marker = `unused-denied.${old.id}`;
      }

      const clock = await databaseNow(tx);
      const changed = await tx.onboardingAttempt.update({
        where: { id: row.id },
        data: {
          stage: marker ? 'AwaitingBootstrap' : 'CleanupRequired',
          error_code: marker ? null : 'cleanup_required',
          retry_cursor: marker,
          next_run_at: null,
          lease_owner: null,
          lease_expires_at: null,
          lease_version: { increment: 1 },
          updated_at: clock,
        },
      });
      await this.appendAudit(tx, changed, 'onboarding_transition');
      return 'Applied';
    });
  }

  async recordDecommission(
    serverId: string,
    actor: IntentActor,
    requestId: string,
  ): Promise<AttemptSnapshot> {
    const a = await this.current(serverId);
    if (!a?.configurationVersion) throw new ApiError('conflict');
    return this.recordIntent(
      serverId,
      actor,
      {
        kind: 'decommission',
        requestId,
        presetVersionId: a.presetVersionId,
        configurationVersion: a.configurationVersion,
      },
      new Date(),
    );
  }

  private async fenced(
    tx: Tx,
    id: string,
    generation: number,
    version: number,
    owner: string | null,
    now: Date,
  ): Promise<OnboardingAttempt | null> {
    const initial = await tx.onboardingAttempt.findUnique({
      where: { id },
      select: { server_id: true },
    });
    if (!initial) return null;
    await lockServer(tx, initial.server_id);
    const a = await tx.onboardingAttempt.findUniqueOrThrow({ where: { id } });
    const s = await tx.server.findUniqueOrThrow({ where: { id: a.server_id } });
    const clock = await databaseNow(tx);

    return s.archived_at ||
      a.stage === 'Retired' ||
      s.onboarding_generation !== generation ||
      a.generation !== generation ||
      a.lease_version !== version ||
      !owner ||
      a.lease_owner !== owner ||
      !a.lease_expires_at ||
      +a.lease_expires_at <= Math.max(+clock, +now)
      ? null
      : a;
  }

  async claimDue(limit: number, owner: string, now: Date): Promise<LeasedAttempt[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 2 || !isUuid(owner) || !validTime(now)) {
      throw new ApiError('invalid_request');
    }
    return this.transaction(async (tx) => {
      await this.capacityLock(tx);
      const clock = await databaseNow(tx);
      const activeLeases = await tx.onboardingAttempt.count({
        where: { lease_expires_at: { gt: clock } },
      });
      const slots = Math.min(limit, Math.max(0, 2 - activeLeases));
      if (!slots) return [];

      const servers = await tx.$queryRaw<{ id: string }[]>`
        SELECT s.id
        FROM servers s
        JOIN onboarding_attempts a
          ON a.server_id=s.id AND a.generation=s.onboarding_generation
        WHERE s.archived_at IS NULL
          AND a.stage NOT IN ('Retired','Failed','Expired','CleanupRequired')
          AND a.next_run_at<=${clock}
          AND (a.lease_expires_at IS NULL OR a.lease_expires_at<=${clock})
        ORDER BY a.next_run_at, a.id
        FOR UPDATE OF s SKIP LOCKED
        LIMIT ${slots}
      `;

      const result: LeasedAttempt[] = [];
      for (const s of servers) {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT a.id
          FROM onboarding_attempts a
          JOIN servers s
            ON s.id=a.server_id AND s.onboarding_generation=a.generation
          WHERE a.server_id=${s.id}::uuid
            AND a.next_run_at<=${clock}
            AND (a.lease_expires_at IS NULL OR a.lease_expires_at<=${clock})
          FOR UPDATE OF a SKIP LOCKED
        `;
        if (!rows.length) continue;
        const a = await tx.onboardingAttempt.update({
          where: { id: rows[0].id },
          data: {
            lease_owner: owner,
            lease_expires_at: new Date(+clock + 120_000),
            lease_version: { increment: 1 },
            updated_at: clock,
          },
        });
        result.push((await this.snapshot(tx, a)) as LeasedAttempt);
      }
      return result;
    });
  }

  async heartbeat(
    id: string,
    generation: number,
    version: number,
    owner: string,
    now: Date,
  ): Promise<LeasedAttempt | null> {
    return this.transaction(async (tx) => {
      const a = await this.fenced(tx, id, generation, version, owner, now);
      if (!a) return null;
      const clock = await databaseNow(tx);
      const changed = await tx.onboardingAttempt.update({
        where: { id },
        data: {
          lease_expires_at: new Date(+clock + 120_000),
          lease_version: { increment: 1 },
          updated_at: clock,
        },
      });
      return (await this.snapshot(tx, changed)) as LeasedAttempt;
    });
  }

  async beginCommand(
    a: LeasedAttempt,
    command: AgentCommand,
    previous: CommandObservation | null,
    now: Date,
  ): Promise<LeasedAttempt | null> {
    return this.transaction(async (tx) => {
      const row = await this.fenced(tx, a.id, a.generation, a.leaseVersion, a.leaseOwner, now);
      if (!row || row.command_intent) return null;

      const snap = await this.snapshot(tx, row);
      const b = snap.binding;
      const i = command.identity;
      const last = snap.previousCommand;

      if (
        !b ||
        snap.legacyReservation ||
        i.serverId !== row.server_id ||
        i.enrollmentId !== row.enrollment_id ||
        i.nodeId !== b.nodeId ||
        i.platform !== b.platform ||
        i.configurationVersion !== row.configuration_version ||
        !isUuid(i.operationId) ||
        i.operationId === row.enrollment_id ||
        (row.intent === 'decommission'
          ? command.kind !== 'Cleanup'
          : command.kind !== 'Configure' || row.state !== 'Registered') ||
        (last
          ? !terminalCommand(previous) ||
            (last.observation?.commandId !== null &&
              last.observation?.commandId !== undefined &&
              previous!.commandId !== last.observation.commandId) ||
            command.previousOperationId !== last.command.identity.operationId
          : command.previousOperationId !== null)
      ) {
        throw new ApiError('conflict');
      }

      const clock = await databaseNow(tx);
      const changed = await tx.onboardingAttempt.update({
        where: { id: row.id },
        data: {
          command_intent: toJson(command),
          ...(command.kind === 'Configure' ? { state: 'Configuring' } : {}),
          lease_expires_at: new Date(+clock + 120_000),
          lease_version: { increment: 1 },
          updated_at: clock,
        },
      });
      if (command.kind === 'Configure') {
        await tx.server.update({
          where: { id: changed.server_id },
          data: { onboarding_state: changed.state, updated_at: clock },
        });
      }
      await this.appendAudit(
        tx,
        changed,
        row.intent === 'decommission' ? 'decommission_transition' : 'onboarding_transition',
      );
      return (await this.snapshot(tx, changed)) as LeasedAttempt;
    });
  }

  async commitTransition(
    id: string,
    generation: number,
    version: number,
    t: Transition,
  ): Promise<'Applied' | 'Fenced'> {
    if (t.kind === 'Ignored') return 'Fenced';
    if (
      !isUuid(id) ||
      !validTime(t.at) ||
      ['Retired', 'AwaitingBootstrap'].includes(t.stage) ||
      !ONBOARDING_STATES.includes(t.state) ||
      !ONBOARDING_STAGES.includes(t.stage)
    ) {
      throw new ApiError('invalid_request');
    }

    return this.transaction(async (tx) => {
      const a = await this.fenced(tx, id, generation, version, t.owner, t.at);
      if (!a || a.enrollment_id !== t.enrollmentId) return 'Fenced';
      if (a.intent === 'decommission') throw new ApiError('conflict');

      const p = t.patch;
      if (
        a.state === 'Verifying' &&
        t.state === 'Success' &&
        (!p.verifiedObservation || t.monitoring?.health !== 'Fresh')
      ) {
        throw new ApiError('invalid_request');
      }

      const clock = await databaseNow(tx);
      let verifiedObservation: Prisma.InputJsonValue | undefined;
      if (p.verifiedObservation) {
        if (!verifiedEvidence(await this.snapshot(tx, a), p.verifiedObservation, clock, true)) {
          throw new ApiError('invalid_request');
        }
        const nextVerified = {
          identity: p.verifiedObservation.identity,
          commandId: p.verifiedObservation.commandId,
          finishedAt: p.verifiedObservation.finishedAt,
          resources: p.verifiedObservation.resources,
        };
        if (
          a.verified_observation !== null &&
          JSON.stringify(a.verified_observation) !== JSON.stringify(nextVerified)
        ) {
          throw new ApiError('conflict');
        }
        verifiedObservation = toJson(nextVerified);
      }

      const changed = await tx.onboardingAttempt.update({
        where: { id },
        data: {
          state: t.state,
          stage: t.stage,
          error_code: t.errorCode,
          next_run_at: t.nextRunAt,
          lease_owner: null,
          lease_expires_at: null,
          lease_version: { increment: 1 },
          updated_at: clock,
          ...(verifiedObservation === undefined ? {} : { verified_observation: verifiedObservation }),
          ...(p.activationId === undefined ? {} : { activation_id: p.activationId }),
          ...(p.activationExpiresAt === undefined ? {} : { activation_expires_at: p.activationExpiresAt }),
          ...(p.registeredAt === undefined ? {} : { registered_at: p.registeredAt }),
          ...(p.configurationDeadline === undefined
            ? {}
            : { configuration_deadline: p.configurationDeadline }),
          ...(p.configStartedAt === undefined ? {} : { config_started_at: p.configStartedAt }),
          ...(p.configAppliedAt === undefined ? {} : { config_applied_at: p.configAppliedAt }),
          ...(p.verificationDeadline === undefined
            ? {}
            : { verification_deadline: p.verificationDeadline }),
          ...(p.retryCount === undefined ? {} : { retry_count: p.retryCount }),
          ...(p.retryCursor === undefined ? {} : { retry_cursor: p.retryCursor }),
          ...(p.observation === undefined ? {} : { command_observation: toJson(p.observation) }),
          ...(p.agent === undefined ? {} : { agent_metadata: toJson(p.agent) }),
        },
      });
      if (changed.state !== a.state) {
        await tx.server.update({
          where: { id: changed.server_id },
          data: { onboarding_state: changed.state, updated_at: clock },
        });
      }

      if (t.binding) {
        const b = t.binding;
        if (
          b.serverId !== a.server_id ||
          b.enrollmentId !== a.enrollment_id ||
          b.generation !== generation ||
          b.presetHash !== a.desired_preset_hash ||
          b.state !== 'Active'
        ) {
          throw new ApiError('conflict');
        }
        const createdBinding = await tx.managedNodeBinding.create({
          data: {
            id: randomUUID(),
            server_id: a.server_id,
            enrollment_id: a.enrollment_id,
            generation,
            account_id: b.accountId,
            region: b.region,
            managed_node_id: b.nodeId,
            activation_id: b.activationId,
            platform: b.platform,
            desired_preset_version_id: a.desired_preset_version_id,
            desired_preset_hash: a.desired_preset_hash,
            state: 'Active',
          },
        });
        await tx.bindingAlertReceipt.create({
          data: { binding_id: createdBinding.id, generation },
        });
      }

      if (t.monitoring) {
        const m = t.monitoring;
        const count = await tx.managedNodeBinding.updateMany({
          where: { server_id: a.server_id, enrollment_id: a.enrollment_id, generation, state: 'Active' },
          data: {
            monitoring_health: m.health,
            last_observed_sample_at: m.lastObservedSampleAt,
            last_successful_query_at: m.lastSuccessfulQueryAt,
          },
        });
        if (count.count !== 1) throw new ApiError('conflict');
      }

      await this.appendAudit(tx, changed, 'onboarding_transition');
      return 'Applied';
    });
  }

  async cleanupState(a: LeasedAttempt, now: Date): Promise<CleanupState | null> {
    return this.transaction(async (tx) => {
      const row = await this.fenced(tx, a.id, a.generation, a.leaseVersion, a.leaseOwner, now);
      if (!row || row.intent !== 'decommission') return null;
      const p = await tx.decommissionProtocol.findUnique({ where: { attempt_id: a.id } });
      return p?.simple_phase
        ? {
            phase: p.simple_phase as CleanupState['phase'],
            deadline: p.deadline,
            deregisteredAt: p.node_deregistered_at,
          }
        : null;
    });
  }

  private async alertRemoval(tx: Tx, a: OnboardingAttempt): Promise<boolean> {
    const b = await tx.managedNodeBinding.findFirst({
      where: {
        server_id: a.server_id,
        generation: a.generation,
        enrollment_id: a.enrollment_id,
        state: { not: 'Retired' },
      },
    });
    if (!b) return false;

    const expected = createHash('sha256')
      .update(
        JSON.stringify({
          schemaVersion: 1,
          action: 'remove',
          bindingId: b.id,
          serverId: a.server_id,
          enrollmentId: a.enrollment_id,
          nodeId: b.managed_node_id,
          generation: a.generation,
        }),
      )
      .digest('hex');

    const r = await tx.bindingAlertReceipt.findUnique({ where: { binding_id: b.id } });
    const clock = await databaseNow(tx);
    return (
      !!r &&
      r.generation === a.generation &&
      r.state === 'Synced' &&
      r.desired_hash === expected &&
      !r.owned_uids.length &&
      !r.intent_uids.length &&
      !r.reconciliation_uids.length &&
      !!r.synced_at &&
      +r.synced_at >= +a.created_at &&
      +r.synced_at <= +clock
    );
  }

  async cleanupCheckpoint(
    a: LeasedAttempt,
    phase: CleanupState['phase'],
    now: Date,
    observation?: CommandObservation,
  ): Promise<'Applied' | 'Fenced'> {
    return this.transaction(async (tx) => {
      const row = await this.fenced(tx, a.id, a.generation, a.leaseVersion, a.leaseOwner, now);
      if (!row || row.intent !== 'decommission') return 'Fenced';

      const p = await tx.decommissionProtocol.findUniqueOrThrow({ where: { attempt_id: row.id } });
      const clock = await databaseNow(tx);
      if (+p.deadline <= +clock) phase = 'Paused';

      const old = p.simple_phase;
      if (
        phase === 'AwaitAlerts' &&
        (!observation ||
          observation.status !== 'Success' ||
          observation.serviceState !== 'stopped' ||
          observation.errorCode !== null ||
          !observation.finishedAt ||
          !row.command_intent)
      ) {
        throw new ApiError('conflict');
      }
      if (phase === 'DeregisterUncertain' && (old !== 'AwaitAlerts' || !(await this.alertRemoval(tx, row)))) {
        phase = 'AwaitAlerts';
      }
      if (phase === 'Complete' && (old !== 'DeregisterUncertain' || !(await this.alertRemoval(tx, row)))) {
        throw new ApiError('conflict');
      }

      await tx.decommissionProtocol.update({
        where: { attempt_id: row.id },
        data: { simple_phase: phase, ...(phase === 'Complete' ? { node_deregistered_at: clock } : {}) },
      });

      const changed = await tx.onboardingAttempt.update({
        where: { id: row.id },
        data: {
          stage: phase === 'Paused' ? 'CleanupRequired' : 'Decommissioning',
          error_code: phase === 'Paused' ? 'cleanup_required' : null,
          ...(observation ? { command_observation: toJson(observation) } : {}),
          next_run_at: phase === 'Paused' ? null : new Date(+clock + 30_000),
          lease_owner: null,
          lease_expires_at: null,
          lease_version: { increment: 1 },
          updated_at: clock,
        },
      });
      await tx.managedNodeBinding.updateMany({
        where: { server_id: row.server_id, generation: row.generation, state: { not: 'Retired' } },
        data: {
          state: phase === 'Paused' ? 'CleanupRequired' : 'Decommissioning',
          monitoring_health: 'Unknown',
          updated_at: clock,
        },
      });
      await this.appendAudit(tx, changed, 'decommission_transition');
      return 'Applied';
    });
  }

  async beginDeregister(a: LeasedAttempt, now: Date): Promise<LeasedAttempt | null> {
    return this.transaction(async (tx) => {
      const row = await this.fenced(tx, a.id, a.generation, a.leaseVersion, a.leaseOwner, now);
      if (!row || row.intent !== 'decommission') return null;

      const p = await tx.decommissionProtocol.findUniqueOrThrow({ where: { attempt_id: row.id } });
      const o = row.command_observation as unknown as CommandObservation | null;
      if (
        p.simple_phase !== 'AwaitAlerts' ||
        +p.deadline <= +(await databaseNow(tx)) ||
        !o ||
        o.status !== 'Success' ||
        o.serviceState !== 'stopped' ||
        !(await this.alertRemoval(tx, row))
      ) {
        return null;
      }

      await tx.decommissionProtocol.update({
        where: { attempt_id: row.id },
        data: { simple_phase: 'DeregisterUncertain' },
      });
      const clock = await databaseNow(tx);
      const changed = await tx.onboardingAttempt.update({
        where: { id: row.id },
        data: {
          lease_expires_at: new Date(+clock + 120_000),
          lease_version: { increment: 1 },
          updated_at: clock,
        },
      });
      return (await this.snapshot(tx, changed)) as LeasedAttempt;
    });
  }

  async finalizeDecommission(a: LeasedAttempt, now: Date): Promise<'Applied' | 'Fenced'> {
    return this.transaction(async (tx) => {
      const row = await this.fenced(tx, a.id, a.generation, a.leaseVersion, a.leaseOwner, now);
      if (!row || row.intent !== 'decommission') return 'Fenced';

      const p = await tx.decommissionProtocol.findUniqueOrThrow({ where: { attempt_id: row.id } });
      const o = row.command_observation as unknown as CommandObservation | null;
      if (
        p.simple_phase !== 'Complete' ||
        !p.node_deregistered_at ||
        !o ||
        o.status !== 'Success' ||
        o.serviceState !== 'stopped' ||
        !(await this.alertRemoval(tx, row))
      ) {
        throw new ApiError('conflict');
      }

      const clock = await databaseNow(tx);
      const count = await tx.managedNodeBinding.updateMany({
        where: {
          server_id: row.server_id,
          enrollment_id: row.enrollment_id,
          generation: row.generation,
          state: { in: ['Decommissioning', 'CleanupRequired'] },
        },
        data: { state: 'Retired', retired_at: clock, monitoring_health: 'Unknown', updated_at: clock },
      });
      if (count.count !== 1) throw new ApiError('conflict');

      const changed = await tx.onboardingAttempt.update({
        where: { id: row.id },
        data: {
          stage: 'Retired',
          error_code: null,
          next_run_at: null,
          lease_owner: null,
          lease_expires_at: null,
          lease_version: { increment: 1 },
          updated_at: clock,
        },
      });
      await this.appendAudit(tx, changed, 'decommission_transition');
      return 'Applied';
    });
  }
}
