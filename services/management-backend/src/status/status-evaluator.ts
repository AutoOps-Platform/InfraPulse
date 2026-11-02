import type { StatusDto } from './status.dto.js';

export type SourceObservation = {
  boot_started_at: Date;
  activated_at: Date;
  snapshot_end: Date | null;
  received_at: Date | null;
  coverage_start: Date | null;
  coverage_end: Date | null;
  gap: boolean;
  pending_deadline: Date | null;
};
export type StatusInput = {
  lifecycle: string | null;
  last_metric_seen_at: Date | null;
  now: Date;
  source: SourceObservation | null;
};
// No clock reads or DB/cache access: age is measured at the completed snapshot.
export function evaluateStatus(input: StatusInput): StatusDto {
  const { source, now, last_metric_seen_at: seen } = input;
  const asOf = source?.snapshot_end ?? null;
  const expired = !!source?.pending_deadline && source.pending_deadline <= now;
  const invalidClock =
    !!source &&
    !!asOf &&
    !!source.received_at &&
    (asOf.getTime() > now.getTime() + 5000 ||
      source.received_at > now ||
      asOf < source.activated_at);
  const fresh =
    !!asOf &&
    !!source?.received_at &&
    !invalidClock &&
    now.getTime() - asOf.getTime() <= 30000 &&
    now.getTime() - source.received_at.getTime() <= 30000;
  const gap = !!source && (source.gap || expired);
  const source_health: StatusDto['source_health'] =
    !asOf || !source?.received_at
      ? 'unavailable'
      : !fresh
        ? 'stale'
        : gap
          ? 'gap'
          : 'healthy';
  const result = (
    status: StatusDto['status'],
    confidence_reason: StatusDto['confidence_reason'],
  ): StatusDto => ({
    status,
    confidence_reason,
    source_health,
    last_metric_seen_at: seen?.toISOString() ?? null,
    status_as_of: asOf?.toISOString() ?? null,
  });
  if (input.lifecycle === null) return result('Unknown', 'no_active_agent');
  if (input.lifecycle !== 'active')
    return result('Unknown', 'lifecycle_inactive');
  if (!seen) return result('Unknown', 'never_seen');
  if (!source || !asOf || !source.received_at)
    return result('Unknown', 'source_unavailable');
  if (invalidClock || seen > asOf) return result('Unknown', 'clock_skew');
  if (!fresh) return result('Unknown', 'source_stale');
  const age = asOf.getTime() - seen.getTime();
  if (age <= 90000)
    return seen < source.boot_started_at
      ? result('Unknown', 'before_boot')
      : result('Online', 'recent_success');
  if (gap) return result('Unknown', 'coverage_gap');
  const lookback = age <= 300000 ? 90000 : 300000;
  if (
    !source.coverage_start ||
    !source.coverage_end ||
    source.coverage_start < source.activated_at ||
    source.coverage_end < asOf ||
    asOf.getTime() - source.coverage_start.getTime() < lookback
  )
    return result('Unknown', 'insufficient_coverage');
  return age <= 300000
    ? result('Stale', 'continuous_90s')
    : result('Offline', 'continuous_300s');
}
