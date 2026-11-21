import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  AWS_PORT,
  terminalCommand,
  unknownCommand,
  type ActivationIntent,
  type AgentMetadata,
  type AwsPort,
  type CommandObservation,
  type CreateActivationResult,
} from '../../../../integrations/aws/aws.port.js';
import {
  OnboardingRepository,
  type LeasedAttempt,
  type OnboardingStore,
} from '../repositories/onboarding.repository.js';
import { DecommissionService, type CleanupResult } from './decommission.service.js';
import {
  observeHealthyQuery,
  type HealthyQueryEvidence,
  type MetricVerifierPort,
} from './metric-verifier.service.js';
import {
  OnboardingRuntime,
  decide,
  type AttemptSnapshot,
  type Clock,
  type CommandFactory,
  type SafeReceipt,
  type Scheduler,
} from './onboarding-state.policy.js';

export {
  OnboardingRuntime,
  systemClock,
  timeoutScheduler,
  type Clock,
  type CommandFactory,
  type Scheduler,
} from './onboarding-state.policy.js';
export type { MetricVerifierPort } from './metric-verifier.service.js';

export interface ReconcilerOptions {
  accountId: string;
  region: 'ap-southeast-1';
  clock: Clock;
  scheduler: Scheduler;
  verifier: MetricVerifierPort;
  command: CommandFactory;
  decommission?: DecommissionService;
  jitter?: () => number;
}

export interface RunSummary {
  claimed: number;
  applied: number;
  fenced: number;
  errors: number;
}

type ReceiptPayload = SafeReceipt extends infer E
  ? E extends SafeReceipt
    ? Omit<E, 'generation' | 'enrollmentId'>
    : never
  : never;

const emptySummary = (): RunSummary => ({ claimed: 0, applied: 0, fenced: 0, errors: 0 });

@Injectable()
export class OnboardingWorker implements OnModuleInit, OnModuleDestroy {
  private readonly owner = randomUUID();
  private stopped = false;
  private started = false;
  private active: Promise<RunSummary> | null = null;
  private cancelLoop: (() => void) | null = null;
  private readonly outbound = new Set<AbortController>();
  private readonly options: ReconcilerOptions;

  constructor(
    private readonly store: OnboardingRepository,
    @Inject(AWS_PORT) private readonly aws: AwsPort,
    runtime: OnboardingRuntime,
    @Optional() decommission?: DecommissionService,
  ) {
    if (!/^\d{12}$/.test(runtime.accountId) || runtime.region !== 'ap-southeast-1') {
      throw new Error('Invalid onboarding runtime.');
    }
    this.options = {
      accountId: runtime.accountId,
      region: runtime.region,
      clock: runtime.clock,
      scheduler: runtime.scheduler,
      verifier: runtime.verifier,
      command: runtime.command,
      decommission,
      jitter: runtime.jitter,
    };
  }

  static fromOptions(
    store: OnboardingStore,
    aws: AwsPort,
    options: ReconcilerOptions,
  ): OnboardingWorker {
    const worker = new OnboardingWorker(
      store as OnboardingRepository,
      aws,
      new OnboardingRuntime({
        accountId: options.accountId,
        region: options.region,
        clock: options.clock,
        scheduler: options.scheduler,
        verifier: options.verifier,
        command: options.command,
        jitter: options.jitter,
      }),
      options.decommission,
    );
    Object.assign(worker, { options });
    return worker;
  }

  async createActivationOnce(intent: ActivationIntent): Promise<CreateActivationResult> {
    let sent = false;
    if (this.stopped || this.outbound.size >= 2) return { kind: 'Invalid', code: 'conflict' };
    try {
      return await this.bounded((s) => {
        sent = true;
        return this.aws.createActivation(intent, s);
      }, 2500);
    } catch {
      return { kind: sent ? 'Ambiguous' : 'Invalid', code: sent ? 'timeout' : 'aborted' };
    }
  }

  async recoverUnusedActivation(
    attempt: AttemptSnapshot,
    source: { intent: ActivationIntent; activationId: string | null; definitelyDenied: boolean },
  ): Promise<
    | { kind: 'DeletedUnused'; activationId: string; leaseVersion: number }
    | { kind: 'DeniedAbsent'; leaseVersion: number }
    | { kind: 'CleanupRequired'; leaseVersion: number }
  > {
    let leaseVersion = attempt.leaseVersion;
    const cleanup = () => ({ kind: 'CleanupRequired' as const, leaseVersion });
    if (
      attempt.intent !== 'regenerate-unused' ||
      attempt.stage !== 'CleanupRequired' ||
      attempt.state !== 'Pending' ||
      !attempt.leaseOwner ||
      source.intent.serverId !== attempt.serverId ||
      source.intent.generation >= attempt.generation
    ) {
      return cleanup();
    }

    try {
      return await this.bounded(async (s) => {
        const found = await this.aws.findActivations(source.intent, s);
        if (!s.aborted && found.kind === 'None' && source.activationId === null && source.definitelyDenied) {
          const fenced = await this.store.heartbeat(
            attempt.id,
            attempt.generation,
            leaseVersion,
            attempt.leaseOwner!,
            this.options.clock.now(),
          );
          return fenced && !s.aborted
            ? { kind: 'DeniedAbsent' as const, leaseVersion: fenced.leaseVersion }
            : cleanup();
        }
        if (s.aborted || found.kind !== 'One') return cleanup();

        const a = found.activation;
        if (
          (source.activationId !== null && a.id !== source.activationId) ||
          a.serverId !== source.intent.serverId ||
          a.enrollmentId !== source.intent.enrollmentId ||
          a.generation !== source.intent.generation ||
          a.platform !== source.intent.platform ||
          +a.expiresAt !== +source.intent.expiresAt ||
          a.registrations !== 0
        ) {
          return cleanup();
        }

        const nodes = await this.aws.findNodesByActivation(a.id, s);
        if (s.aborted || nodes.kind !== 'None') return cleanup();

        const fenced = await this.store.heartbeat(
          attempt.id,
          attempt.generation,
          leaseVersion,
          attempt.leaseOwner!,
          this.options.clock.now(),
        );
        if (!fenced || s.aborted) return cleanup();
        leaseVersion = fenced.leaseVersion;

        const deleted = await this.aws.deleteUnusedActivation(a.id, s);
        return !s.aborted && deleted.kind === 'Known'
          ? { kind: 'DeletedUnused', activationId: a.id, leaseVersion }
          : cleanup();
      }, 2500);
    } catch {
      return cleanup();
    }
  }

  runOnce(now = this.options.clock.now()): Promise<RunSummary> {
    if (this.stopped) return Promise.resolve(emptySummary());
    if (this.active) return this.active;
    if (!Number.isFinite(+now)) return Promise.reject(new Error('Invalid onboarding clock.'));
    const task = this.run(new Date(now));
    this.active = task;
    void task.finally(() => {
      if (this.active === task) this.active = null;
    });
    return task;
  }

  private event(a: AttemptSnapshot, payload: ReceiptPayload): SafeReceipt {
    return { ...payload, generation: a.generation, enrollmentId: a.enrollmentId } as SafeReceipt;
  }

  private async run(now: Date): Promise<RunSummary> {
    const result = emptySummary();
    try {
      const available = 2 - this.outbound.size;
      if (available <= 0) return result;
      const rows = (await this.store.claimDue(available, this.owner, now)).slice(0, available);
      result.claimed = rows.length;

      await Promise.all(
        rows.map(async (initial) => {
          let a = initial;
          try {
            if (this.stopped) {
              result.fenced++;
              return;
            }
            if (a.intent === 'decommission') {
              const service = this.options.decommission;
              if (!service) throw new Error();
              let previous: CommandObservation | null = null;
              if (!a.command && a.previousCommand) {
                previous = await this.bounded((s) =>
                  this.aws.readCommand(
                    a.previousCommand!.command,
                    a.previousCommand!.observation?.commandId ?? null,
                    s,
                  ),
                );
              }
              const action = await service.reconcileDecommission(a, now, previous);
              if (!action) {
                result.applied++;
                return;
              }
              let outcome: CleanupResult;
              try {
                outcome = await this.bounded(
                  async (s) => {
                    if (action.operation === 'Send') {
                      return { operation: 'Send', result: await this.aws.sendCommand(action.command!, s) };
                    }
                    if (action.operation === 'Read') {
                      return {
                        operation: 'Read',
                        result: await this.aws.readCommand(
                          action.command!,
                          action.attempt.observation?.commandId ?? null,
                          s,
                        ),
                      };
                    }
                    return { operation: 'Deregister', result: await this.aws.deregisterNode(action.node, s) };
                  },
                  Math.min(10_000, Math.max(1, +action.deadline - +this.options.clock.now())),
                );
              } catch {
                outcome =
                  action.operation === 'Read'
                    ? {
                        operation: 'Read',
                        result: unknownCommand(action.attempt.observation?.commandId ?? null),
                      }
                    : { operation: action.operation, result: { kind: 'Ambiguous', code: 'timeout' } };
              }
              if (this.stopped) {
                result.fenced++;
                return;
              }
              const committed = await service.accept(action, outcome, this.options.clock.now());
              result[committed === 'Applied' ? 'applied' : 'fenced']++;
              return;
            }

            let receipt: SafeReceipt;
            let metricAt: Date | null = null;
            let healthy: HealthyQueryEvidence | null = null;
            const poll = () => this.event(a, { kind: 'Poll' });
            const preflight = decide(a, poll(), now);
            if (preflight.kind === 'Ignored') {
              result.fenced++;
              return;
            }

            if (
              preflight.state === 'Failed' ||
              preflight.state === 'Expired' ||
              preflight.stage === 'CleanupRequired'
            ) {
              receipt = poll();
            } else if (a.state === 'Pending') {
              receipt = await this.registration(a);
            } else if (a.state === 'Registered' && !a.command) {
              const command = this.options.command(a, 'Configure');
              let previous: CommandObservation | null = null;
              if (a.previousCommand) {
                previous = await this.bounded((s) =>
                  this.aws.readCommand(
                    a.previousCommand!.command,
                    a.previousCommand!.observation?.commandId ?? null,
                    s,
                  ),
                );
              }
              if (!command || a.legacyReservation || (a.previousCommand && !terminalCommand(previous))) {
                receipt = this.event(a, { kind: 'Failure', code: 'cleanup_required', transient: true });
              } else {
                const leased = await this.store.beginCommand(
                  a,
                  command,
                  previous,
                  this.options.clock.now(),
                );
                if (!leased) {
                  result.fenced++;
                  return;
                }
                a = leased;
                let id: string | null = null;
                try {
                  const sent = await this.bounded((s) => this.aws.sendCommand(command, s));
                  if (sent.kind === 'Known') id = sent.commandId;
                } catch {
                  /* durable once-only intent remains */
                }
                receipt = this.event(a, {
                  kind: 'CommandObserved',
                  observation: unknownCommand(id),
                  agent: null,
                });
              }
            } else if (a.state === 'Configuring' || a.state === 'Registered') {
              if (!a.command) {
                receipt = this.event(a, { kind: 'Failure', code: 'configuration_failed', transient: false });
              } else {
                const observation = await this.bounded((s) =>
                  this.aws.readCommand(a.command!, a.observation?.commandId ?? null, s),
                );
                let agent: AgentMetadata | null = null;
                if (a.binding?.activationId) {
                  try {
                    agent = await this.bounded((s) =>
                      this.aws.observeNode(
                        {
                          nodeId: a.binding!.nodeId,
                          activationId: a.binding!.activationId!,
                          serverId: a.serverId,
                          enrollmentId: a.enrollmentId,
                          platform: a.platform,
                        },
                        s,
                      ),
                    );
                  } catch {
                    /* no fabricated metadata */
                  }
                }
                if (observation.cloudWatchVersion !== null || observation.serviceState !== null) {
                  agent = {
                    ...(agent ?? a.agent),
                    cloudWatchVersion: observation.cloudWatchVersion,
                    cloudWatchServiceState: observation.serviceState,
                  };
                }
                receipt = this.event(a, { kind: 'CommandObserved', observation, agent });
              }
            } else {
              const previousPoll =
                a.retryCursor && /^metric\.\d{13}$/.test(a.retryCursor)
                  ? Number(a.retryCursor.slice(7))
                  : 0;
              if (previousPoll + 60_000 > +now || !a.observation) {
                receipt = poll();
              } else {
                metricAt = this.options.clock.now();
                const v = await this.bounded((s) =>
                  this.options.verifier.verify(a, a.observation!, metricAt!, s),
                );
                if (v.kind === 'Verified' || v.kind === 'Observed') {
                  receipt = this.event(a, {
                    kind: a.state === 'Success' ? 'Observed' : 'Verified',
                    evidence: v.evidence,
                  });
                } else if (v.kind === 'HealthyQuery') {
                  healthy = v;
                  receipt = poll();
                } else {
                  receipt = this.event(a, { kind: 'QueryFailed' });
                }
              }
            }

            if (this.stopped) {
              result.fenced++;
              return;
            }
            const at = this.options.clock.now();
            const t = decide(a, receipt, at);
            if (t.kind === 'Apply') {
              if (healthy && a.binding) {
                t.monitoring = observeHealthyQuery(
                  a.binding,
                  healthy.queriedAt,
                  healthy.lastObservedSampleAt,
                  at,
                );
              } else if (
                t.monitoring &&
                (receipt.kind === 'Verified' || receipt.kind === 'Observed') &&
                a.binding
              ) {
                t.monitoring = observeHealthyQuery(
                  a.binding,
                  receipt.evidence.queriedAt,
                  t.monitoring.lastObservedSampleAt,
                  at,
                );
              }
              if (metricAt) {
                t.patch.retryCursor = `metric.${+metricAt}`;
                if (t.nextRunAt) {
                  t.nextRunAt = new Date(Math.max(+t.nextRunAt, +metricAt + 60_000));
                }
              }
              const jitter = this.options.jitter?.() ?? Math.floor(Math.random() * 1001);
              if (t.nextRunAt) {
                t.nextRunAt = new Date(
                  +t.nextRunAt + Math.max(0, Math.min(1000, Number.isFinite(jitter) ? jitter : 0)),
                );
              }
            }

            const committed = await this.store.commitTransition(a.id, a.generation, a.leaseVersion, t);
            result[committed === 'Applied' ? 'applied' : 'fenced']++;
          } catch {
            try {
              const t = decide(
                a,
                this.event(a, {
                  kind: ['Success', 'Verifying'].includes(a.state) ? 'QueryFailed' : 'Poll',
                }),
                this.options.clock.now(),
              );
              await this.store.commitTransition(a.id, a.generation, a.leaseVersion, t);
            } catch {
              /* lease will expire without discarding intent */
            }
            result.errors++;
          }
        }),
      );
    } catch {
      result.errors++;
    }
    return result;
  }

  private async registration(a: LeasedAttempt): Promise<SafeReceipt> {
    const poll = this.event(a, { kind: 'Poll' });
    if (!a.activationId) {
      if (!a.registrationDeadline) return poll;
      const m = await this.bounded((s) =>
        this.aws.findActivations(
          {
            serverId: a.serverId,
            enrollmentId: a.enrollmentId,
            generation: a.generation,
            platform: a.platform,
            expiresAt: a.registrationDeadline!,
          },
          s,
        ),
      );
      if (m.kind !== 'One') return poll;
      if (
        m.activation.serverId !== a.serverId ||
        m.activation.enrollmentId !== a.enrollmentId ||
        m.activation.generation !== a.generation ||
        m.activation.platform !== a.platform ||
        +m.activation.expiresAt !== +a.registrationDeadline
      ) {
        return this.event(a, { kind: 'Failure', code: 'registration_conflict', transient: false });
      }
      return this.event(a, {
        kind: 'ActivationFound',
        activationId: m.activation.id,
        expiresAt: m.activation.expiresAt,
      });
    }

    const match = await this.bounded((s) => this.aws.findNodesByActivation(a.activationId!, s));
    if (match.kind !== 'One') return poll;
    const n = match.node;
    if (
      n.serverId !== a.serverId ||
      n.enrollmentId !== a.enrollmentId ||
      n.generation !== a.generation ||
      n.activationId !== a.activationId
    ) {
      return this.event(a, { kind: 'Failure', code: 'registration_conflict', transient: false });
    }
    return this.event(a, {
      kind: 'Registered',
      nodeId: n.nodeId,
      activationId: n.activationId,
      platform: n.platform,
      accountId: this.options.accountId,
      region: this.options.region,
      agent: n.metadata,
    });
  }

  private async bounded<T>(work: (s: AbortSignal) => Promise<T>, timeoutMs = 10_000): Promise<T> {
    if (this.stopped || this.outbound.size >= 2) throw new Error('Onboarding capacity occupied.');
    const c = new AbortController();
    this.outbound.add(c);
    const raw = Promise.resolve().then(() => {
      if (c.signal.aborted) throw new Error('Onboarding aborted.');
      return work(c.signal);
    });
    void raw.then(
      () => this.outbound.delete(c),
      () => this.outbound.delete(c),
    );
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('Onboarding aborted.'));
      c.signal.addEventListener('abort', onAbort, { once: true });
    });
    const cancel = this.options.scheduler.schedule(() => c.abort(), timeoutMs);
    try {
      return await Promise.race([raw, aborted]);
    } finally {
      cancel();
      c.signal.removeEventListener('abort', onAbort);
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    const next = () => {
      if (this.stopped) return;
      this.cancelLoop = this.options.scheduler.schedule(() => {
        this.cancelLoop = null;
        void this.runOnce().finally(next);
      }, 1000);
    };
    next();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    this.cancelLoop?.();
    this.cancelLoop = null;
    for (const c of this.outbound) c.abort();
    await this.active;
  }

  onModuleInit(): void {
    this.start();
  }

  onModuleDestroy(): Promise<void> {
    return this.stop();
  }
}
