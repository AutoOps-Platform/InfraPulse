import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button } from '@grafana/ui';
import { api, errorMessage } from '../api/client';
import type { ConfigurationObservation, OnboardingErrorCode, OnboardingProgress } from '../api/types';
import { time } from './Common';

const POLL_MS = 10000;
const VIEW_LIMIT_MS = 60 * 60 * 1000;
const terminal = (p: OnboardingProgress) => ['Success', 'Failed', 'Expired'].includes(p.state) || ['CleanupRequired', 'Retired'].includes(p.stage);
const reasons: Record<OnboardingErrorCode, string> = {
  activation_ambiguous: 'Activation outcome is ambiguous; inspect persisted progress before unused-activation recovery.',
  activation_expired: 'The activation expired. Only a confirmed unused activation can be regenerated.',
  activation_unavailable: 'Activation creation or reconciliation is unavailable. Do not replay a download.',
  registration_conflict: 'Registration identity conflicts. Operator investigation is required.',
  platform_mismatch: 'The registered platform does not match inventory. Operator investigation is required.',
  configuration_failed: 'Managed-node configuration failed. A registered Active node may use retry-config.',
  configuration_timeout: 'Configuration did not finish within its deadline; inspect before retry-config.',
  verification_timeout: 'Metric verification did not finish within its deadline. Configuration is not metric evidence.',
  metrics_unavailable: 'Metric evidence could not be read. This is not evidence that the host is Offline.',
  permission_denied: 'A required backend permission was denied. An operator must correct it.',
  contract_unqualified: 'Required protected assets or native contracts are not qualified; installation is unavailable.',
  cleanup_required: 'Cleanup is uncertain. The capacity slot remains reserved; manual operator recovery is required.',
  dependency_unavailable: 'A required dependency is unavailable. Inspect persisted progress; do not replay mutations.',
  superseded: 'This attempt was superseded by a later generation.',
};
export function alertSyncCurrent(p: OnboardingProgress): boolean {
  return p.bindingState === 'Active' && p.alertSync.state === 'Synced' && p.alertSync.generation === p.generation && p.alertSync.desiredHash !== null && p.alertSync.syncedAt !== null;
}
const observed = (value: string | null) => value ?? 'Chưa xác minh';
const observedTime = (value: string | null) => value === null ? 'Chưa xác minh' : time(value);
export function OnboardingStatus({ progress: p, configuration, unavailable = false, compact = false }: { progress: OnboardingProgress; configuration?: ConfigurationObservation; unavailable?: boolean; compact?: boolean }) {
  const health = unavailable ? 'Unknown' : p.monitoring.health;
  const synced = !unavailable && alertSyncCurrent(p);
  if (compact) return <span>{p.state} / {p.stage} · Metrics {health} · {synced ? 'Alert receipt current' : 'Alert sync required'}</span>;
  return (
    <section aria-label="AWS onboarding status">
      <h2>Onboarding: {p.state}</h2>
      <p>Stage: {p.stage} · Generation: {p.generation} · Binding: {p.bindingState ?? 'None'}</p>
      <p>Activation expiry: {observedTime(p.expiresAt)} · Next backend work: {observedTime(p.nextRunAt)}</p>
      <p>Onboarding availability: {p.availability.available ? 'Release ready for this OS' : 'release_missing — bootstrap/retry disabled'}</p>
      <dl>
        <dt>Observed hostname / IP</dt><dd>{observed(p.agent.hostname)} / {observed(p.agent.ipAddress)}</dd>
        <dt>Observed OS version / mi-ID</dt><dd>{observed(p.agent.osVersion)} / {observed(p.agent.nodeId)}</dd>
        <dt>SSM status / agent version / last ping</dt><dd>{observed(p.agent.ssmStatus)} / {observed(p.agent.ssmAgentVersion)} / {observedTime(p.agent.ssmLastPingAt)}</dd>
        <dt>CloudWatch version / service</dt><dd>{observed(p.agent.cloudWatchVersion)} / {observed(p.agent.cloudWatchServiceState)}</dd>
        <dt>Metadata observed at</dt><dd>{observedTime(p.agent.observedAt)}</dd>
        <dt>Configuration revision</dt><dd>{observed(configuration?.version ?? null)}</dd>
        <dt>AWS command status</dt><dd>{observed(configuration?.status ?? null)}</dd>
        <dt>Command requested / started / finished</dt><dd>{observedTime(configuration?.requestedAt ?? null)} / {observedTime(configuration?.startedAt ?? null)} / {observedTime(configuration?.finishedAt ?? null)}</dd>
      </dl>
      {p.errorCode && <Alert severity="warning" title={p.errorCode}>{reasons[p.errorCode]}</Alert>}
      {(p.stage === 'CleanupRequired' || p.bindingState === 'CleanupRequired') && <Alert severity="warning" title="CleanupRequired — slot reserved">No cleanup receipt is asserted here. An operator must investigate the protected lifecycle; this page cannot clear markers or mark cleanup complete.</Alert>}
      <h3>Independent metrics health: {health}</h3>
      <p>Last observed sample: {observedTime(p.monitoring.lastObservedSampleAt)} · Last successful query: {observedTime(p.monitoring.lastSuccessfulQueryAt)}</p>
      <p>Onboarding Success is a stored result, not current metrics health. Unknown/query errors do not mean Offline.</p>
      <h3>{synced ? 'Alert receipt current' : 'Alert sync required'}</h3>
      <p>Alert sync: {p.alertSync.state} · Receipt generation: {p.alertSync.generation} · Synced at: {observedTime(p.alertSync.syncedAt)}</p>
      {!synced && <p>An operator must synchronize alerts and record a receipt for the current generation. This app cannot perform alert synchronization or use an Admin fallback.</p>}
    </section>
  );
}

// Per mounted selected-server view: persisted GETs only, visible 10s cadence,
// finite 60m deadline, no overlapping reads, and no mutation/replay machinery.
export function useOnboardingProgress(serverId: string | undefined) {
  const [progress, setProgress] = useState<OnboardingProgress>();
  const [error, setError] = useState<string>();
  const [reading, setReading] = useState(false);
  const [pollState, setPollState] = useState('Starting');
  const readRef = useRef<(manual: boolean) => Promise<OnboardingProgress | undefined>>(async () => undefined);
  const acceptRef = useRef<(p: OnboardingProgress) => void>(() => undefined);
  useEffect(() => {
    if (serverId === undefined) return;
    let mounted = true;
    const deadline = performance.now() + VIEW_LIMIT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let readTimer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let inFlight: Promise<OnboardingProgress | undefined> | undefined;
    let current: OnboardingProgress | undefined;
    let revision = 0;
    const clear = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
    const schedule = () => {
      clear();
      if (!mounted) return;
      if (performance.now() >= deadline) { setPollState('60-minute polling limit reached; manual reads only'); return; }
      if (current && terminal(current)) { setPollState('Terminal/manual-recovery state; manual reads only'); return; }
      if (document.visibilityState !== 'visible') { setPollState('Paused while hidden'); return; }
      setPollState('Visible GET polling every 10 seconds');
      timer = setTimeout(() => { void read(false); }, Math.min(POLL_MS, deadline - performance.now()));
    };
    const read = (manual: boolean): Promise<OnboardingProgress | undefined> => {
      clear();
      if (!mounted) return Promise.resolve(undefined);
      if (inFlight) return manual ? inFlight.then(() => read(true)) : inFlight;
      if (!manual && (document.visibilityState !== 'visible' || performance.now() >= deadline || (current && terminal(current)))) { schedule(); return Promise.resolve(undefined); }
      const requestRevision = revision;
      controller = new AbortController();
      const readController = controller;
      const signal = readController.signal;
      const readTimeout = setTimeout(() => readController.abort(), manual ? 30000 : Math.min(30000, Math.max(1, deadline - performance.now())));
      readTimer = readTimeout;
      setReading(true);
      inFlight = (async () => {
        try {
          const result = await api.onboarding(serverId, signal);
          if (!mounted || signal.aborted || requestRevision !== revision) return undefined;
          current = result;
          setProgress(result);
          setError(undefined);
          return result;
        } catch (failure: unknown) {
          if (mounted && requestRevision === revision) setError(errorMessage(failure));
          return undefined;
        } finally {
          clearTimeout(readTimeout);
          readTimer = undefined;
          inFlight = undefined;
          if (mounted) { setReading(false); schedule(); }
        }
      })();
      return inFlight;
    };
    readRef.current = read;
    acceptRef.current = (result) => {
      if (!mounted || result.serverId !== serverId) return;
      revision++;
      current = result;
      setProgress(result);
      setError(undefined);
      schedule();
    };
    const visible = () => { schedule(); };
    document.addEventListener('visibilitychange', visible);
    setProgress(undefined);
    setError(undefined);
    setReading(false);
    void read(false);
    return () => {
      mounted = false;
      clear();
      if (readTimer !== undefined) clearTimeout(readTimer);
      controller?.abort();
      readRef.current = async () => undefined;
      acceptRef.current = () => undefined;
      document.removeEventListener('visibilitychange', visible);
    };
  }, [serverId]);
  const refresh = useCallback(() => readRef.current(true), []);
  const accept = useCallback((p: OnboardingProgress) => acceptRef.current(p), []);
  return { progress, error, reading, pollState, refresh, accept };
}
export function OnboardingReadView({ serverId }: { serverId: string }) {
  const status = useOnboardingProgress(serverId);
  return <>
    <Button variant="secondary" disabled={status.reading} onClick={() => { void status.refresh(); }}>Refresh persisted progress (GET)</Button>
    <p>{status.pollState}</p>
    {status.reading && <p>Reading persisted progress…</p>}
    {status.error && <Alert severity="error" title="Progress unavailable — metrics Unknown">{status.error}</Alert>}
    {status.progress && <OnboardingStatus progress={status.progress} unavailable={Boolean(status.error)} />}
  </>;
}
