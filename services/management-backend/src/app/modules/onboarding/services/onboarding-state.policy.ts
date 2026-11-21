import { Injectable } from '@nestjs/common';
import {
  terminalCommand,
  type AgentCommand,
  type AgentMetadata,
  type CommandObservation,
  type NativeResource,
  type WorkflowIdentity,
} from '../../../../integrations/aws/aws.port.js';
import {
  ONBOARDING_ERROR_CODES,
  type BindingState,
  type MonitoringHealth,
  type OnboardingErrorCode,
  type OnboardingStage,
  type OnboardingState,
  type Platform,
} from '../dto/onboarding.dto.js';
import type { BootstrapAssetsPort } from './bootstrap.service.js';
import { isoTime, validTime, type MetricVerifierPort } from './metric-verifier.service.js';

export interface Clock {
  readonly now: () => Date;
}

export interface Scheduler {
  readonly schedule: (task: () => void, delayMs: number) => () => void;
}

export type CommandFactory = (
  attempt: AttemptSnapshot,
  kind: AgentCommand['kind'],
) => AgentCommand | null;

export type PresetMatcher = (
  platform: Platform,
  id: string,
  revision: string,
  checksum: string,
  config: unknown,
) => boolean;

export const systemClock: Clock = { now: () => new Date() };

export const timeoutScheduler: Scheduler = {
  schedule(task, delay) {
    const timer = setTimeout(task, delay);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

@Injectable()
export class OnboardingRuntime {
  readonly accountId: string;
  readonly region: 'ap-southeast-1';
  readonly verifier: MetricVerifierPort;
  readonly command: CommandFactory;
  readonly presetMatches: PresetMatcher;
  readonly bootstrapAssets?: BootstrapAssetsPort;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly jitter?: () => number;

  constructor(init: {
    accountId: string;
    region: 'ap-southeast-1';
    verifier: MetricVerifierPort;
    command: CommandFactory;
    presetMatches?: PresetMatcher;
    bootstrapAssets?: BootstrapAssetsPort;
    clock?: Clock;
    scheduler?: Scheduler;
    jitter?: () => number;
  }) {
    this.accountId = init.accountId;
    this.region = init.region;
    this.verifier = init.verifier;
    this.command = init.command;
    this.presetMatches = init.presetMatches ?? (() => false);
    this.bootstrapAssets = init.bootstrapAssets;
    this.clock = init.clock ?? systemClock;
    this.scheduler = init.scheduler ?? timeoutScheduler;
    this.jitter = init.jitter;
  }
}

export interface BindingSnapshot {
  id: string;
  serverId: string;
  enrollmentId: string;
  generation: number;
  accountId: string;
  region: string;
  nodeId: string;
  activationId: string | null;
  platform: Platform;
  presetHash: string;
  state: BindingState;
  monitoringHealth: MonitoringHealth;
  lastObservedSampleAt: Date | null;
  lastSuccessfulQueryAt: Date | null;
}

export interface PreviousCommand {
  command: AgentCommand;
  observation: CommandObservation | null;
}

export interface AttemptSnapshot {
  id: string;
  serverId: string;
  enrollmentId: string;
  generation: number;
  currentGeneration: number;
  intent: 'bootstrap' | 'retry-config' | 'regenerate-unused' | 'decommission';
  platform: Platform;
  state: OnboardingState;
  stage: OnboardingStage;
  presetVersionId: string;
  presetHash: string;
  configurationVersion: string | null;
  activationId: string | null;
  activationExpiresAt: Date | null;
  registeredAt: Date | null;
  configStartedAt: Date | null;
  configAppliedAt: Date | null;
  registrationDeadline: Date | null;
  configurationDeadline: Date | null;
  verificationDeadline: Date | null;
  errorCode: OnboardingErrorCode | null;
  retryCount: number;
  retryCursor: string | null;
  nextRunAt: Date | null;
  createdAt: Date;
  leaseOwner: string | null;
  leaseVersion: number;
  leaseExpiresAt: Date | null;
  binding: BindingSnapshot | null;
  command: AgentCommand | null;
  observation: CommandObservation | null;
  previousCommand: PreviousCommand | null;
  legacyReservation: boolean;
  agent: AgentMetadata;
  disposition: 'Created' | 'Existing';
}

export interface VerifiedMetricEvidence {
  identity: WorkflowIdentity;
  commandId: string;
  finishedAt: string;
  queriedAt: Date;
  resources: NativeResource[];
  groups: { cpu: Date[]; memory: Date[]; disk: Date[]; network: Date[] };
}

type Fence = { generation: number; enrollmentId: string };

export type SafeReceipt = Fence &
  (
    | { kind: 'Poll' | 'QueryFailed' }
    | { kind: 'ActivationFound'; activationId: string; expiresAt: Date }
    | {
        kind: 'Registered';
        nodeId: string;
        activationId: string;
        platform: Platform;
        accountId: string;
        region: string;
        agent: AgentMetadata;
      }
    | { kind: 'CommandObserved'; observation: CommandObservation; agent: AgentMetadata | null }
    | { kind: 'Verified' | 'Observed'; evidence: VerifiedMetricEvidence }
    | { kind: 'Failure'; code: OnboardingErrorCode; transient: boolean }
  );

export interface ReceiptPatch {
  activationId?: string;
  activationExpiresAt?: Date;
  registeredAt?: Date;
  configStartedAt?: Date;
  configAppliedAt?: Date;
  configurationDeadline?: Date;
  verificationDeadline?: Date;
  retryCount?: number;
  retryCursor?: string | null;
  observation?: CommandObservation;
  agent?: AgentMetadata;
  verifiedObservation?: VerifiedMetricEvidence;
}

export type Transition =
  | { kind: 'Ignored' }
  | {
      kind: 'Apply';
      generation: number;
      enrollmentId: string;
      owner: string | null;
      at: Date;
      state: OnboardingState;
      stage: OnboardingStage;
      errorCode: OnboardingErrorCode | null;
      nextRunAt: Date | null;
      patch: ReceiptPatch;
      binding?: Omit<
        BindingSnapshot,
        'id' | 'monitoringHealth' | 'lastObservedSampleAt' | 'lastSuccessfulQueryAt'
      >;
      monitoring?: {
        health: MonitoringHealth;
        lastObservedSampleAt: Date | null;
        lastSuccessfulQueryAt: Date | null;
      };
    };

export function currentBinding(a: AttemptSnapshot): boolean {
  const b = a.binding;
  return (
    !!b &&
    b.state === 'Active' &&
    b.serverId === a.serverId &&
    b.enrollmentId === a.enrollmentId &&
    b.generation === a.generation &&
    b.platform === a.platform &&
    b.presetHash === a.presetHash
  );
}

export function verifiedEvidence(
  a: AttemptSnapshot,
  e: VerifiedMetricEvidence,
  now: Date,
  fresh: boolean,
): boolean {
  const c = a.command;
  const o = a.observation;
  if (
    !currentBinding(a) ||
    !c ||
    c.kind !== 'Configure' ||
    !o ||
    o.status !== 'Success' ||
    !isoTime(o.finishedAt) ||
    !o.resources ||
    !e ||
    JSON.stringify(e.identity) !== JSON.stringify(c.identity) ||
    e.commandId !== o.commandId ||
    e.finishedAt !== o.finishedAt ||
    JSON.stringify(e.resources) !== JSON.stringify(o.resources) ||
    !validTime(e.queriedAt) ||
    +e.queriedAt > +now ||
    +e.queriedAt < +now - 30_000 ||
    !e.groups ||
    Object.keys(e.groups).sort().join(',') !== 'cpu,disk,memory,network'
  ) {
    return false;
  }

  for (const key of ['cpu', 'memory', 'disk', 'network'] as const) {
    const points = e.groups[key];
    if (
      !Array.isArray(points) ||
      !points.length ||
      points.length > 100 ||
      points.some(
        (p) =>
          !validTime(p) ||
          +p < Date.parse(o.finishedAt!) ||
          (fresh && +p < +now - 300_000) ||
          +p > +now + 30_000 ||
          +p > +e.queriedAt + 30_000,
      )
    ) {
      return false;
    }
    if (
      (key === 'cpu' || key === 'memory') &&
      (points.length < 2 || Math.max(...points.map(Number)) - Math.min(...points.map(Number)) < 60_000)
    ) {
      return false;
    }
  }
  return true;
}

export function decide(a: AttemptSnapshot, e: SafeReceipt, now: Date): Transition {
  if (!validTime(now)) throw new Error('Invalid onboarding clock.');
  const ignored: Transition = { kind: 'Ignored' };

  if (
    !e ||
    a.currentGeneration !== a.generation ||
    e.generation !== a.generation ||
    e.enrollmentId !== a.enrollmentId ||
    ['Retired', 'Decommissioning', 'CleanupRequired'].includes(a.stage) ||
    ['Failed', 'Expired'].includes(a.state)
  ) {
    return ignored;
  }

  const base = (patch: Partial<Extract<Transition, { kind: 'Apply' }>> = {}): Transition => ({
    kind: 'Apply',
    generation: a.generation,
    enrollmentId: a.enrollmentId,
    owner: a.leaseOwner,
    at: new Date(now),
    state: a.state,
    stage: a.stage,
    errorCode: a.errorCode,
    nextRunAt: new Date(+now + (['Success', 'Verifying'].includes(a.state) ? 60_000 : 30_000)),
    patch: {},
    ...patch,
  });

  const failure = (code: OnboardingErrorCode, expired = false): Transition =>
    base({
      state: expired ? 'Expired' : 'Failed',
      stage: expired ? 'Expired' : 'Failed',
      errorCode: code,
      nextRunAt: null,
    });

  const deadline =
    a.state === 'Pending'
      ? a.registrationDeadline
      : a.state === 'Verifying'
        ? a.verificationDeadline
        : ['Registered', 'Configuring'].includes(a.state)
          ? a.configurationDeadline
          : null;

  if (deadline && +now >= +deadline) {
    if (a.command && !terminalCommand(a.observation)) {
      return base({ stage: 'CleanupRequired', errorCode: 'cleanup_required', nextRunAt: null });
    }
    return failure(
      a.state === 'Pending'
        ? 'activation_expired'
        : a.state === 'Verifying'
          ? 'verification_timeout'
          : 'configuration_timeout',
      a.state === 'Pending',
    );
  }

  switch (e.kind) {
    case 'Poll':
      return base({
        stage: a.stage === 'CreatingActivation' ? 'ReconcilingActivation' : a.stage,
      });

    case 'ActivationFound':
      if (
        a.state !== 'Pending' ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(e.activationId) ||
        !validTime(e.expiresAt) ||
        +e.expiresAt > +a.createdAt + 3_600_000 ||
        (a.activationId !== null && a.activationId !== e.activationId)
      ) {
        return ignored;
      }
      if (+e.expiresAt <= +now) return failure('activation_expired', true);
      return base({
        stage: 'AwaitingRegistration',
        errorCode: null,
        patch: { activationId: e.activationId, activationExpiresAt: e.expiresAt },
      });

    case 'Registered':
      if (
        a.state !== 'Pending' ||
        a.stage !== 'AwaitingRegistration' ||
        e.activationId !== a.activationId ||
        !/^mi-[a-f0-9]{17}$/.test(e.nodeId)
      ) {
        return ignored;
      }
      if (e.platform !== a.platform) return failure('platform_mismatch');
      return base({
        state: 'Registered',
        stage: 'ApplyingConfig',
        errorCode: null,
        patch: {
          registeredAt: now,
          configurationDeadline: new Date(+now + 1_800_000),
          agent: e.agent,
        },
        binding: {
          serverId: a.serverId,
          enrollmentId: a.enrollmentId,
          generation: a.generation,
          accountId: e.accountId,
          region: e.region,
          nodeId: e.nodeId,
          activationId: e.activationId,
          platform: a.platform,
          presetHash: a.presetHash,
          state: 'Active',
        },
      });

    case 'CommandObserved': {
      const o = e.observation;
      if (
        !a.command ||
        a.command.kind !== 'Configure' ||
        !currentBinding(a) ||
        (a.observation?.commandId && o.commandId !== a.observation.commandId)
      ) {
        return ignored;
      }
      const patch: ReceiptPatch = { observation: o, ...(e.agent ? { agent: e.agent } : {}) };
      if (
        o.status === 'Success' &&
        o.errorCode === null &&
        o.serviceState === 'running' &&
        isoTime(o.finishedAt) &&
        Date.parse(o.finishedAt) <= +now + 30_000 &&
        o.resources
      ) {
        return base({
          state: 'Verifying',
          stage: 'VerifyingMetrics',
          errorCode: null,
          patch: {
            ...patch,
            ...(isoTime(o.startedAt) ? { configStartedAt: new Date(o.startedAt) } : {}),
            configAppliedAt: new Date(o.finishedAt),
            verificationDeadline: new Date(Date.parse(o.finishedAt) + 900_000),
          },
        });
      }
      if (['Failed', 'Cancelled', 'TimedOut'].includes(o.status)) {
        return base({
          state: 'Failed',
          stage: 'Failed',
          errorCode: 'configuration_failed',
          nextRunAt: null,
          patch,
        });
      }
      return base({ state: 'Configuring', stage: 'ApplyingConfig', patch });
    }

    case 'Verified':
    case 'Observed': {
      if (
        !['Verifying', 'Success'].includes(a.state) ||
        !verifiedEvidence(a, e.evidence, now, e.kind === 'Verified')
      ) {
        return ignored;
      }
      const latest = Math.min(
        ...Object.values(e.evidence.groups).map((pts) => Math.max(...pts.map(Number))),
      );
      return base({
        state: 'Success',
        stage: 'Complete',
        errorCode: null,
        patch: e.kind === 'Verified' ? { verifiedObservation: e.evidence } : {},
        monitoring: {
          health: +now - latest <= 300_000 ? 'Fresh' : +now - latest <= 900_000 ? 'Stale' : 'Offline',
          lastObservedSampleAt: new Date(Math.max(latest, +(a.binding!.lastObservedSampleAt ?? 0))),
          lastSuccessfulQueryAt: e.evidence.queriedAt,
        },
      });
    }

    case 'Failure':
      if (!ONBOARDING_ERROR_CODES.includes(e.code)) return ignored;
      if (a.state === 'Success') {
        return base({
          monitoring: {
            health: 'Unknown',
            lastObservedSampleAt: a.binding?.lastObservedSampleAt ?? null,
            lastSuccessfulQueryAt: a.binding?.lastSuccessfulQueryAt ?? null,
          },
        });
      }
      if (a.command && !terminalCommand(a.observation)) return base({ errorCode: e.code });
      return e.transient
        ? base({ errorCode: e.code, patch: { retryCount: Math.min(a.retryCount + 1, 100) } })
        : failure(e.code);

    case 'QueryFailed':
      return base({
        monitoring: a.binding
          ? {
              health: 'Unknown',
              lastObservedSampleAt: a.binding.lastObservedSampleAt,
              lastSuccessfulQueryAt: a.binding.lastSuccessfulQueryAt,
            }
          : undefined,
      });
  }
}
