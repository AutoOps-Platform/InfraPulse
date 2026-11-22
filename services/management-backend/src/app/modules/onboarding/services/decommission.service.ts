import { Injectable } from '@nestjs/common';
import {
  terminalCommand,
  unknownCommand,
  type AgentCommand,
  type CommandObservation,
  type MutationResult,
  type NodeIdentity,
} from '../../../../integrations/aws/aws.port.js';
import { ApiError } from '../../../common/errors.js';
import type { UserPrincipal } from '../../auth/guards/auth.guard.js';
import { ServersService } from '../../servers/services/servers.service.js';
import type { BootstrapIntent, OnboardingProgress } from '../dto/onboarding.dto.js';
import {
  OnboardingRepository,
  type LeasedAttempt,
} from '../repositories/onboarding.repository.js';
import { OnboardingRuntime, type CommandFactory } from './onboarding-state.policy.js';

export interface CleanupState {
  phase:
    | 'AwaitPrevious'
    | 'AwaitCommand'
    | 'AwaitAlerts'
    | 'DeregisterUncertain'
    | 'Complete'
    | 'Paused';
  deadline: Date;
  deregisteredAt: Date | null;
}

export interface CleanupAction {
  operation: 'Send' | 'Read' | 'Deregister';
  attempt: LeasedAttempt;
  command: AgentCommand | null;
  node: Pick<NodeIdentity, 'nodeId' | 'activationId' | 'serverId' | 'enrollmentId' | 'platform'>;
  deadline: Date;
}

export type CleanupResult =
  | { operation: 'Read'; result: CommandObservation }
  | { operation: 'Send' | 'Deregister'; result: MutationResult };

export interface DecommissionIntentPort {
  readonly request: (
    serverId: string,
    intent: BootstrapIntent,
    actor: UserPrincipal,
  ) => Promise<OnboardingProgress>;
}

@Injectable()
export class DecommissionService implements DecommissionIntentPort {
  private readonly command: CommandFactory;

  constructor(
    private readonly store: OnboardingRepository,
    private readonly servers: ServersService,
    runtime: OnboardingRuntime,
  ) {
    this.command = runtime.command;
  }

  readonly request = (
    serverId: string,
    intent: BootstrapIntent,
    actor: UserPrincipal,
  ): Promise<OnboardingProgress> => this.requestDecommission(serverId, intent, actor);

  async requestDecommission(
    serverId: string,
    intent: BootstrapIntent,
    actor: UserPrincipal,
  ): Promise<OnboardingProgress> {
    if (!actor || actor.kind !== 'user' || actor.role !== 'Admin') {
      throw new ApiError('forbidden');
    }
    if (!intent || Object.keys(intent).join(',') !== 'requestId') {
      throw new ApiError('invalid_request');
    }

    const a = await this.store.recordDecommission(
      serverId,
      {
        issuer: actor.issuer,
        subject: actor.subject,
        ...(actor.display === undefined ? {} : { display: actor.display }),
      },
      intent.requestId,
    );
    return { ...(await this.servers.get(serverId)).onboarding, agent: a.agent };
  }

  async reconcileDecommission(
    a: LeasedAttempt,
    now: Date,
    previous: CommandObservation | null,
  ): Promise<CleanupAction | null> {
    const state = await this.store.cleanupState(a, now);
    const b = a.binding;
    if (
      !state ||
      !b?.activationId ||
      a.legacyReservation ||
      b.generation !== a.generation ||
      b.enrollmentId !== a.enrollmentId ||
      b.platform !== a.platform ||
      +state.deadline <= +now
    ) {
      if (state) await this.store.cleanupCheckpoint(a, 'Paused', now);
      return null;
    }

    const node = {
      nodeId: b.nodeId,
      activationId: b.activationId,
      serverId: a.serverId,
      enrollmentId: a.enrollmentId,
      platform: a.platform,
    };

    if (state.phase === 'Complete') {
      await this.store.finalizeDecommission(a, now);
      return null;
    }
    if (state.phase === 'DeregisterUncertain' || state.phase === 'Paused') {
      await this.store.cleanupCheckpoint(a, 'Paused', now);
      return null;
    }
    if (state.phase === 'AwaitAlerts') {
      const leased = await this.store.beginDeregister(a, now);
      if (!leased) {
        await this.store.cleanupCheckpoint(a, 'AwaitAlerts', now);
        return null;
      }
      return { operation: 'Deregister', attempt: leased, command: a.command, node, deadline: state.deadline };
    }

    if (a.command) {
      return { operation: 'Read', attempt: a, command: a.command, node, deadline: state.deadline };
    }
    if (a.previousCommand && !terminalCommand(previous)) {
      await this.store.cleanupCheckpoint(a, 'AwaitPrevious', now);
      return null;
    }

    const command = this.command(a, 'Cleanup');
    if (!command) {
      await this.store.cleanupCheckpoint(a, 'Paused', now);
      return null;
    }
    const leased = await this.store.beginCommand(a, command, previous, now);
    return leased
      ? { operation: 'Send', attempt: leased, command, node, deadline: state.deadline }
      : null;
  }

  async accept(
    action: CleanupAction,
    outcome: CleanupResult,
    now: Date,
  ): Promise<'Applied' | 'Fenced'> {
    if (outcome.operation !== action.operation) {
      throw new ApiError('invalid_request');
    }
    if (outcome.operation === 'Read') {
      const o = outcome.result;
      if (
        o.status === 'Success' &&
        o.serviceState === 'stopped' &&
        o.errorCode === null &&
        o.finishedAt
      ) {
        return this.store.cleanupCheckpoint(action.attempt, 'AwaitAlerts', now, o);
      }
      return this.store.cleanupCheckpoint(
        action.attempt,
        ['Failed', 'Cancelled', 'TimedOut'].includes(o.status) ? 'Paused' : 'AwaitCommand',
        now,
        o,
      );
    }
    if (outcome.operation === 'Send') {
      return this.store.cleanupCheckpoint(
        action.attempt,
        'AwaitCommand',
        now,
        unknownCommand(outcome.result.kind === 'Known' ? (outcome.result.commandId ?? null) : null),
      );
    }
    return this.store.cleanupCheckpoint(
      action.attempt,
      outcome.result.kind === 'Known' ? 'Complete' : 'Paused',
      now,
    );
  }
}
