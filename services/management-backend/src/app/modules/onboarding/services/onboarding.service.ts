import { Injectable, Optional } from '@nestjs/common';
import { emptyAgent } from '../../../../integrations/aws/aws.port.js';
import { ApiError } from '../../../common/errors.js';
import { HASH_PATTERN, isUuid } from '../../../common/pagination.js';
import type { UserPrincipal } from '../../auth/guards/auth.guard.js';
import { ServersService } from '../../servers/services/servers.service.js';
import type {
  BootstrapAttachment,
  BootstrapIntent,
  OnboardingProgress,
  RetryIntent,
} from '../dto/onboarding.dto.js';
import {
  OnboardingRepository,
  type IntentActor,
} from '../repositories/onboarding.repository.js';
import {
  assertBootstrapAttachment,
  renderBootstrap,
  type BootstrapAssetsPort,
  type QualifiedBootstrapAssets,
} from './bootstrap.service.js';
import { DecommissionService, type DecommissionIntentPort } from './decommission.service.js';
import {
  OnboardingRuntime,
  decide,
  systemClock,
  type AttemptSnapshot,
  type Clock,
  type Transition,
} from './onboarding-state.policy.js';
import { OnboardingWorker } from './onboarding-worker.service.js';

export type VerifiedActor = UserPrincipal;

export interface OnboardingServiceOptions {
  assets?: BootstrapAssetsPort;
  decommission?: DecommissionIntentPort;
  clock?: Clock;
}

function requireAdmin(actor: VerifiedActor): IntentActor {
  if (!actor || actor.kind !== 'user' || actor.role !== 'Admin') {
    throw new ApiError('forbidden');
  }
  return {
    issuer: actor.issuer,
    subject: actor.subject,
    ...(actor.display === undefined ? {} : { display: actor.display }),
  };
}

function validateIntent(serverId: string, intent: BootstrapIntent, retry = false): void {
  if (
    !isUuid(serverId) ||
    !intent ||
    !isUuid(intent.requestId) ||
    Object.keys(intent).sort().join(',') !== (retry ? 'mode,requestId' : 'requestId')
  ) {
    throw new ApiError('invalid_request');
  }
}

@Injectable()
export class OnboardingService {
  private readonly clock: Clock;
  private readonly assetsPort?: BootstrapAssetsPort;
  private readonly decommissionPort?: DecommissionIntentPort;

  constructor(
    private readonly store: OnboardingRepository,
    private readonly worker: OnboardingWorker,
    private readonly servers: ServersService,
    @Optional() runtime?: OnboardingRuntime,
    @Optional() decommission?: DecommissionService,
  ) {
    this.clock = runtime?.clock ?? systemClock;
    this.assetsPort = runtime?.bootstrapAssets;
    this.decommissionPort = decommission;
  }

  static fromOptions(
    store: OnboardingRepository,
    worker: OnboardingWorker,
    servers: ServersService,
    options: OnboardingServiceOptions,
  ): OnboardingService {
    const service = new OnboardingService(store, worker, servers);
    Object.assign(service, {
      clock: options.clock ?? systemClock,
      assetsPort: options.assets,
      decommissionPort: options.decommission,
    });
    return service;
  }

  async progress(serverId: string): Promise<OnboardingProgress> {
    const server = await this.servers.get(serverId);
    const current = await this.store.current(serverId);
    const availability = this.assetsPort?.availability(server.os as 'linux' | 'windows') ?? {
      available: false,
      configurationVersion: null,
      reason: 'release_missing' as const,
    };
    return {
      ...server.onboarding,
      availability,
      agent: current?.agent ?? emptyAgent(),
    };
  }

  private async loadQualifiedAssets(serverId: string): Promise<QualifiedBootstrapAssets> {
    const server = await this.servers.get(serverId);
    if (server.archived_at !== null) throw new ApiError('conflict');
    if (!this.assetsPort) throw new ApiError('provisioning_not_ready');

    try {
      const os = server.os;
      if (os !== 'linux' && os !== 'windows') throw new Error();
      if (!this.assetsPort.availability(os).available) throw new Error();
      const assets = await this.assetsPort.load(os);
      if (
        !assets ||
        assets.platform !== os ||
        !isUuid(assets.presetVersionId) ||
        !HASH_PATTERN.test(assets.presetHash) ||
        !Buffer.isBuffer(assets.template)
      ) {
        throw new Error();
      }
      const checked = renderBootstrap(
        {
          serverId,
          enrollmentId: serverId,
          generation: 1,
          platform: os,
          activationId: serverId,
          activationCode: 'PreflightOnly',
          region: 'ap-southeast-1',
          presetHash: assets.presetHash,
        },
        assets,
      );
      checked.bytes.fill(0);
      return { ...assets, template: Buffer.from(assets.template) };
    } catch {
      throw new ApiError('provisioning_not_ready');
    }
  }

  async bootstrap(
    serverId: string,
    intent: BootstrapIntent,
    actor: VerifiedActor,
  ): Promise<BootstrapAttachment> {
    validateIntent(serverId, intent);
    const identity = requireAdmin(actor);
    const assets = await this.loadQualifiedAssets(serverId);
    const durable = {
      kind: 'bootstrap' as const,
      requestId: intent.requestId,
      presetVersionId: assets.presetVersionId,
      configurationVersion: assets.configurationVersion,
    };

    let attempt = await this.store.consumePreparedBootstrap(
      serverId,
      identity,
      durable,
      this.clock.now(),
    );
    attempt ??= await this.store.recordIntent(serverId, identity, durable, this.clock.now());
    if (attempt.disposition !== 'Created') throw new ApiError('secret_already_issued');

    if (
      !attempt.leaseOwner ||
      attempt.platform !== assets.platform ||
      attempt.presetHash !== assets.presetHash ||
      attempt.presetVersionId !== assets.presetVersionId ||
      attempt.configurationVersion !== assets.configurationVersion
    ) {
      throw new ApiError('provisioning_not_ready');
    }

    const leased = await this.store.heartbeat(
      attempt.id,
      attempt.generation,
      attempt.leaseVersion,
      attempt.leaseOwner,
      this.clock.now(),
    );
    if (!leased || !leased.registrationDeadline) throw new ApiError('conflict');
    attempt = leased;

    const result = await this.worker.createActivationOnce({
      serverId,
      enrollmentId: attempt.enrollmentId,
      generation: attempt.generation,
      platform: attempt.platform,
      expiresAt: attempt.registrationDeadline!,
    });
    if (result.kind !== 'Known') {
      await this.reconcile(
        attempt,
        result.kind === 'Denied' ? 'permission_denied' : 'activation_unavailable',
      );
      throw new ApiError('provisioning_not_ready');
    }

    let attachment: BootstrapAttachment;
    try {
      if (
        !isUuid(result.id) ||
        !(result.expiresAt instanceof Date) ||
        +result.expiresAt !== +attempt.registrationDeadline!
      ) {
        throw new Error();
      }
      attachment = renderBootstrap(
        {
          serverId,
          enrollmentId: attempt.enrollmentId,
          generation: attempt.generation,
          platform: attempt.platform,
          activationId: result.id,
          activationCode: result.code,
          region: 'ap-southeast-1',
          presetHash: attempt.presetHash,
        },
        assets,
      );
      assertBootstrapAttachment(serverId, attempt.platform, attachment);
    } catch {
      await this.reconcile(attempt, 'activation_unavailable');
      throw new ApiError('provisioning_not_ready');
    }

    const transition = decide(
      attempt,
      {
        kind: 'ActivationFound',
        generation: attempt.generation,
        enrollmentId: attempt.enrollmentId,
        activationId: result.id,
        expiresAt: result.expiresAt,
      },
      this.clock.now(),
    );

    try {
      if (
        transition.kind !== 'Apply' ||
        transition.stage !== 'AwaitingRegistration' ||
        (await this.store.commitTransition(
          attempt.id,
          attempt.generation,
          attempt.leaseVersion,
          transition,
        )) !== 'Applied'
      ) {
        throw new ApiError('conflict');
      }
    } catch (error) {
      attachment.bytes.fill(0);
      throw error instanceof ApiError ? error : new ApiError('dependency_unavailable');
    }

    return attachment;
  }

  private async reconcile(
    attempt: AttemptSnapshot,
    errorCode: 'permission_denied' | 'activation_unavailable',
  ): Promise<void> {
    const now = this.clock.now();
    const transition: Transition = {
      kind: 'Apply',
      generation: attempt.generation,
      enrollmentId: attempt.enrollmentId,
      owner: attempt.leaseOwner,
      at: now,
      state: 'Pending',
      stage: 'ReconcilingActivation',
      errorCode,
      nextRunAt: new Date(+now + 30_000),
      patch: {},
    };
    await this.store.commitTransition(
      attempt.id,
      attempt.generation,
      attempt.leaseVersion,
      transition,
    );
  }

  async retry(
    serverId: string,
    intent: RetryIntent,
    actor: VerifiedActor,
  ): Promise<OnboardingProgress> {
    validateIntent(serverId, intent, true);
    const identity = requireAdmin(actor);
    if (!['retry-config', 'regenerate-unused'].includes(intent.mode)) {
      throw new ApiError('invalid_request');
    }
    const previous = await this.store.current(serverId);
    if (!previous) throw new ApiError('conflict');
    const assets = await this.loadQualifiedAssets(serverId);

    const attempt = await this.store.recordIntent(
      serverId,
      identity,
      {
        kind: intent.mode,
        requestId: intent.requestId,
        presetVersionId: assets.presetVersionId,
        configurationVersion: assets.configurationVersion,
      },
      this.clock.now(),
    );
    if (intent.mode === 'retry-config' || attempt.disposition !== 'Created') {
      return this.progress(serverId);
    }
    await this.regenerate(attempt);
    return this.progress(serverId);
  }

  private async regenerate(attempt: AttemptSnapshot): Promise<void> {
    const source = await this.store.regenerationSource(attempt);
    if (!source || !source.registrationDeadline || !attempt.leaseOwner) {
      await this.store.finishUnusedRegeneration(
        attempt,
        { kind: 'CleanupRequired' },
        this.clock.now(),
      );
      return;
    }

    const outcome = await this.worker.recoverUnusedActivation(attempt, {
      activationId: source.activationId,
      definitelyDenied: source.errorCode === 'permission_denied',
      intent: {
        serverId: source.serverId,
        enrollmentId: source.enrollmentId,
        generation: source.generation,
        platform: source.platform,
        expiresAt: source.registrationDeadline,
      },
    });
    const fenced = { ...attempt, leaseVersion: outcome.leaseVersion };
    await this.store.finishUnusedRegeneration(
      fenced,
      outcome.kind === 'DeletedUnused'
        ? {
            kind: 'DeletedUnused',
            activationId: outcome.activationId,
            sourceAttemptId: source.id,
          }
        : outcome.kind === 'DeniedAbsent'
          ? { kind: 'DeniedAbsent', sourceAttemptId: source.id }
          : { kind: 'CleanupRequired' },
      this.clock.now(),
    );
  }

  async decommission(
    serverId: string,
    intent: BootstrapIntent,
    actor: VerifiedActor,
  ): Promise<OnboardingProgress> {
    validateIntent(serverId, intent);
    requireAdmin(actor);
    if (!this.decommissionPort) throw new ApiError('dependency_unavailable');
    const progress = await this.decommissionPort.request(serverId, intent, actor);
    if (progress.serverId !== serverId) throw new ApiError('dependency_unavailable');
    return this.progress(serverId);
  }
}
