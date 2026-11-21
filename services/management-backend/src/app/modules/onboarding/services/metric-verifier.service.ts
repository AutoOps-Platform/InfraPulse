import type {
  AwsContractBinding,
  AwsPort,
  BindingIdentity,
  CommandObservation,
  Dimension,
  MetricQuery,
  MetricReadResult,
  NativeResource,
} from '../../../../integrations/aws/aws.port.js';
import type { BindingState, MonitoringHealth } from '../dto/onboarding.dto.js';
import type {
  AttemptSnapshot,
  BindingSnapshot,
  VerifiedMetricEvidence,
} from './onboarding-state.policy.js';

export const METRIC_GROUPS = ['cpu', 'memory', 'disk', 'network'] as const;

export class MetricContractError extends Error {
  constructor() {
    super('contract_unqualified');
  }
}

const rejectContract = (): never => {
  throw new MetricContractError();
};

export function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return rejectContract();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((k) => !Object.hasOwn(record, k))) {
    return rejectContract();
  }
  return record;
}

export const validTime = (value: unknown): value is Date =>
  value instanceof Date &&
  Number.isFinite(+value) &&
  value.getUTCFullYear() >= 1970 &&
  value.getUTCFullYear() <= 9999;

export const isoTime = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  validTime(new Date(value)) &&
  new Date(value).toISOString() === value;

export function normalizeDimensions(items: Dimension[]): Dimension[] {
  if (!Array.isArray(items) || items.length > 13) return rejectContract();
  const rows = items.map((d) => {
    exact(d, ['name', 'value']);
    if (
      typeof d.name !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(d.name) ||
      typeof d.value !== 'string' ||
      !/^[\x20-\x7e]{1,256}$/.test(d.value)
    ) {
      return rejectContract();
    }
    return { name: d.name, value: d.value };
  });
  if (new Set(rows.map((d) => d.name)).size !== rows.length) return rejectContract();
  return rows.sort((x, y) => x.name.localeCompare(y.name));
}

export function sameDimensions(a: Dimension[], b: Dimension[]): boolean {
  return JSON.stringify(normalizeDimensions(a)) === JSON.stringify(normalizeDimensions(b));
}

export function sameDimensionNames(a: Dimension[], b: Dimension[]): boolean {
  const left = normalizeDimensions(a).map((d) => d.name);
  const right = normalizeDimensions(b).map((d) => d.name);
  return JSON.stringify(left) === JSON.stringify(right);
}

export function assertBinding(contract: AwsContractBinding, b: BindingIdentity): void {
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  if (
    !b ||
    !uuid.test(b.serverId) ||
    !uuid.test(b.enrollmentId) ||
    !uuid.test(b.activationId) ||
    !/^mi-[a-f0-9]{17}$/.test(b.nodeId) ||
    !Number.isInteger(b.generation) ||
    b.generation < 1 ||
    b.accountId !== contract.accountId ||
    b.region !== contract.region ||
    !validTime(b.configStartedAt) ||
    !contract.presets.some((p) => p.platform === b.platform && p.hash === b.presetHash)
  ) {
    rejectContract();
  }
}

export function buildQueries(
  contract: AwsContractBinding,
  binding: BindingIdentity,
  resources: { id: string; dimensions: Dimension[]; kind?: NativeResource['kind'] }[],
): MetricQuery[] {
  assertBinding(contract, binding);
  const preset = contract.presets.find(
    (p) => p.platform === binding.platform && p.hash === binding.presetHash,
  )!;
  if (
    !Array.isArray(resources) ||
    resources.length > 32 ||
    resources.length !== preset.resources.length ||
    new Set(resources.map((r) => r.id)).size !== resources.length
  ) {
    rejectContract();
  }
  for (const expected of preset.resources) {
    const found = resources.find((r) => r.id === expected.id);
    if (!found || (found.kind !== undefined && found.kind !== expected.kind) || !sameDimensionNames(found.dimensions, expected.dimensions)) {
      rejectContract();
    }
  }
  if (!METRIC_GROUPS.every((group) => preset.metrics.some((m) => m.group === group))) {
    rejectContract();
  }

  return [...preset.metrics]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((metric, index) => ({
      id: `m${index}`,
      key: metric.key,
      binding,
      dimensions: metric.dimensions.map((d) => ({
        name: d.name,
        value:
          d.value === '${ServerId}'
            ? binding.serverId
            : d.value === '${ManagedNodeId}'
              ? binding.nodeId
              : d.value === '${EnrollmentId}'
                ? binding.enrollmentId
                : resources.find((r) => r.id === metric.resourceId)?.dimensions.find((x) => x.name === d.name)?.value ??
                  rejectContract(),
      })),
    }));
}

export type QueryStatus = 'Complete' | 'Partial' | 'Unavailable' | 'Never';

export interface MonitoringSnapshot {
  health: MonitoringHealth;
  lastObservedSampleAt: Date | null;
  lastSuccessfulQueryAt: Date | null;
}

export function classifyHealth(input: {
  now: Date;
  lastObservedSampleAt: Date | null;
  lastSuccessfulQueryAt: Date | null;
  queryStatus: QueryStatus;
  bindingState: BindingState;
}): MonitoringHealth {
  const { now, lastObservedSampleAt: sample, lastSuccessfulQueryAt: query } = input;
  if (
    input.bindingState !== 'Active' ||
    input.queryStatus !== 'Complete' ||
    !validTime(now) ||
    !validTime(sample) ||
    !validTime(query) ||
    +query > +now ||
    +sample > +now + 30_000 ||
    +sample > +query + 30_000
  ) {
    return 'Unknown';
  }
  const age = +now - +sample;
  return age <= 300_000 ? 'Fresh' : age <= 900_000 ? 'Stale' : 'Offline';
}

export function observeHealthyQuery(
  binding: BindingSnapshot,
  queriedAt: Date,
  sampleAt: Date | null,
  now: Date,
): MonitoringSnapshot {
  const previousSample = validTime(binding.lastObservedSampleAt)
    ? binding.lastObservedSampleAt
    : null;
  const previousQuery = validTime(binding.lastSuccessfulQueryAt)
    ? binding.lastSuccessfulQueryAt
    : null;

  if (
    !validTime(now) ||
    !validTime(queriedAt) ||
    +queriedAt > +now ||
    +queriedAt < +now - 30_000 ||
    (sampleAt !== null &&
      (!validTime(sampleAt) || +sampleAt > +queriedAt + 30_000 || +sampleAt > +now + 30_000))
  ) {
    return {
      health: 'Unknown',
      lastObservedSampleAt: previousSample,
      lastSuccessfulQueryAt: previousQuery,
    };
  }

  const sample =
    sampleAt === null
      ? previousSample
      : new Date(Math.max(+sampleAt, +(previousSample ?? 0)));
  const query = new Date(Math.max(+queriedAt, +(previousQuery ?? 0)));
  return {
    health: classifyHealth({
      now,
      lastObservedSampleAt: sample,
      lastSuccessfulQueryAt: query,
      queryStatus: 'Complete',
      bindingState: binding.state,
    }),
    lastObservedSampleAt: sample,
    lastSuccessfulQueryAt: query,
  };
}

export interface HealthyQueryEvidence {
  queriedAt: Date;
  lastObservedSampleAt: Date | null;
}

export type VerificationResult =
  | { kind: 'Verified'; evidence: VerifiedMetricEvidence; observation: HealthyQueryEvidence }
  | { kind: 'Pending'; observation: HealthyQueryEvidence }
  | { kind: 'Invalid'; reason: 'contract_unqualified' }
  | { kind: 'Unavailable'; reason: 'permission_denied' | 'metrics_unavailable' };

export interface VerificationInput {
  contract: AwsContractBinding;
  binding: BindingIdentity;
  attempt: AttemptSnapshot;
  observation: CommandObservation;
  queryResult: MetricReadResult;
  queriedAt: Date;
  now: Date;
}

export type VerifierOutcome =
  | { kind: 'Verified' | 'Observed'; evidence: VerifiedMetricEvidence }
  | ({ kind: 'HealthyQuery' } & HealthyQueryEvidence)
  | { kind: 'Pending' }
  | { kind: 'Unavailable'; code: string };

export interface MetricVerifierPort {
  readonly verify: (
    attempt: AttemptSnapshot,
    observation: CommandObservation,
    queriedAt: Date,
    signal: AbortSignal,
  ) => Promise<VerifierOutcome>;
}

function isCurrentObservation(
  a: AttemptSnapshot,
  b: BindingIdentity,
  o: CommandObservation,
): boolean {
  const c = a.command;
  const stored = a.binding;
  return (
    !!c &&
    c.kind === 'Configure' &&
    !!stored &&
    stored.state === 'Active' &&
    a.currentGeneration === a.generation &&
    ['Verifying', 'Success'].includes(a.state) &&
    stored.serverId === a.serverId &&
    stored.enrollmentId === a.enrollmentId &&
    stored.generation === a.generation &&
    stored.nodeId === b.nodeId &&
    stored.activationId === b.activationId &&
    stored.platform === a.platform &&
    stored.presetHash === a.presetHash &&
    b.serverId === a.serverId &&
    b.enrollmentId === a.enrollmentId &&
    b.generation === a.generation &&
    b.accountId === stored.accountId &&
    b.region === stored.region &&
    b.platform === a.platform &&
    b.presetHash === a.presetHash &&
    c.identity.serverId === a.serverId &&
    c.identity.nodeId === b.nodeId &&
    c.identity.enrollmentId === a.enrollmentId &&
    c.identity.configurationVersion === a.configurationVersion &&
    o.status === 'Success' &&
    o.errorCode === null &&
    o.serviceState === 'running' &&
    !!o.commandId &&
    o.commandId === a.observation?.commandId &&
    isoTime(o.finishedAt) &&
    validTime(a.configAppliedAt) &&
    Date.parse(o.finishedAt) === +a.configAppliedAt &&
    +b.configStartedAt === +a.configAppliedAt &&
    Array.isArray(o.resources)
  );
}

export function verifyRequiredMetrics(input: VerificationInput): VerificationResult {
  const { contract, binding: b, attempt: a, observation: o, queryResult: result, queriedAt, now } =
    input;
  try {
    if (
      !validTime(now) ||
      !validTime(queriedAt) ||
      +queriedAt > +now ||
      +queriedAt < +now - 30_000 ||
      !isCurrentObservation(a, b, o)
    ) {
      return { kind: 'Invalid', reason: 'contract_unqualified' };
    }
    assertBinding(contract, b);
    const queries = buildQueries(contract, b, o.resources!);
    if (result.kind !== 'Complete') {
      return {
        kind: 'Unavailable',
        reason: result.code === 'permission_denied' ? 'permission_denied' : 'metrics_unavailable',
      };
    }
    exact(result, ['kind', 'series']);
    if (
      !Array.isArray(result.series) ||
      result.series.length !== queries.length ||
      new Set(result.series.map((s) => s.id)).size !== queries.length
    ) {
      return { kind: 'Invalid', reason: 'contract_unqualified' };
    }

    const preset = contract.presets.find(
      (p) => p.platform === b.platform && p.hash === b.presetHash,
    )!;
    const byGroup: Record<(typeof METRIC_GROUPS)[number], number[][]> = {
      cpu: [],
      memory: [],
      disk: [],
      network: [],
    };
    const latest: number[] = [];
    let sufficient = true;
    let count = 0;

    for (const query of queries) {
      const series = result.series.find((s) => s.id === query.id);
      const spec = preset.metrics.find((m) => m.key === query.key)!;
      if (!series) throw new Error();
      exact(series, ['id', 'dimensions', 'points']);
      if (!sameDimensions(series.dimensions, query.dimensions) || !Array.isArray(series.points) || series.points.length > 1000) {
        throw new Error();
      }
      const fresh: number[] = [];
      const observed: number[] = [];
      const seen = new Set<number>();
      for (const point of series.points) {
        if (++count > 1000) throw new Error();
        exact(point, ['timestamp', 'value']);
        if (!isoTime(point.timestamp) || typeof point.value !== 'number' || !Number.isFinite(point.value)) {
          throw new Error();
        }
        const ts = Date.parse(point.timestamp);
        if (seen.has(ts)) throw new Error();
        seen.add(ts);
        if (ts < Date.parse(o.finishedAt!) || ts > +queriedAt + 30_000 || ts > +now + 30_000) {
          continue;
        }
        observed.push(ts);
        if (ts >= +queriedAt - 300_000 && ts >= +now - 300_000) fresh.push(ts);
      }
      if (observed.length) latest.push(Math.max(...observed));
      if (
        !fresh.length ||
        (['cpu', 'memory'].includes(spec.group) &&
          (fresh.length < 2 || Math.max(...fresh) - Math.min(...fresh) < 60_000))
      ) {
        sufficient = false;
      }
      byGroup[spec.group].push(fresh);
    }

    const observation: HealthyQueryEvidence = {
      queriedAt: new Date(queriedAt),
      lastObservedSampleAt:
        latest.length === queries.length ? new Date(Math.min(...latest)) : null,
    };
    if (!sufficient || !METRIC_GROUPS.every((g) => byGroup[g].length)) {
      return { kind: 'Pending', observation };
    }

    const groups = Object.fromEntries(
      METRIC_GROUPS.map((group) => {
        const least = byGroup[group].reduce((x, y) =>
          Math.max(...x) <= Math.max(...y) ? x : y,
        );
        const last = Math.max(...least);
        const first = Math.min(...least);
        return [group, (group === 'cpu' || group === 'memory' ? [first, last] : [last]).map((t) => new Date(t))];
      }),
    ) as VerifiedMetricEvidence['groups'];

    return {
      kind: 'Verified',
      observation,
      evidence: {
        identity: a.command!.identity,
        commandId: o.commandId!,
        finishedAt: o.finishedAt!,
        queriedAt: new Date(queriedAt),
        resources: o.resources!,
        groups,
      },
    };
  } catch {
    return { kind: 'Invalid', reason: 'contract_unqualified' };
  }
}

export class MetricVerifier implements MetricVerifierPort {
  constructor(
    private readonly aws: AwsPort,
    private readonly contract: AwsContractBinding,
    private readonly clock: { now(): Date } = { now: () => new Date() },
  ) {}

  readonly verify = async (
    a: AttemptSnapshot,
    o: CommandObservation,
    queriedAt: Date,
    signal: AbortSignal,
  ): Promise<VerifierOutcome> => {
    try {
      const stored = a.binding;
      if (!stored?.activationId || !isoTime(o.finishedAt) || !o.resources) {
        return { kind: 'Unavailable', code: 'contract_unqualified' };
      }
      const b: BindingIdentity = {
        serverId: a.serverId,
        enrollmentId: a.enrollmentId,
        generation: a.generation,
        platform: a.platform,
        nodeId: stored.nodeId,
        activationId: stored.activationId,
        accountId: stored.accountId,
        region: stored.region,
        presetHash: a.presetHash,
        configStartedAt: new Date(o.finishedAt),
      };
      if (!isCurrentObservation(a, b, o)) {
        return { kind: 'Unavailable', code: 'contract_unqualified' };
      }

      const queries = buildQueries(this.contract, b, o.resources);
      const window = {
        start: new Date(Math.max(Date.parse(o.finishedAt), +queriedAt - 300_000)),
        end: new Date(+queriedAt + 30_000),
      };
      let result: MetricReadResult = { kind: 'Complete', series: [] };
      for (let offset = 0; offset < queries.length; offset += 100) {
        if (signal.aborted) return { kind: 'Unavailable', code: 'metrics_unavailable' };
        const batch = await this.aws.readMetrics(queries.slice(offset, offset + 100), window, signal);
        if (batch.kind !== 'Complete') {
          result = batch;
          break;
        }
        result.series.push(...batch.series);
      }
      if (signal.aborted) return { kind: 'Unavailable', code: 'metrics_unavailable' };

      const checked = verifyRequiredMetrics({
        contract: this.contract,
        binding: b,
        attempt: a,
        observation: o,
        queryResult: result,
        queriedAt,
        now: this.clock.now(),
      });
      if (checked.kind === 'Verified') {
        return { kind: a.state === 'Success' ? 'Observed' : 'Verified', evidence: checked.evidence };
      }
      if (checked.kind === 'Pending') {
        return { kind: 'HealthyQuery', ...checked.observation };
      }
      return {
        kind: 'Unavailable',
        code: checked.kind === 'Invalid' ? 'contract_unqualified' : checked.reason,
      };
    } catch {
      return { kind: 'Unavailable', code: 'metrics_unavailable' };
    }
  };
}
