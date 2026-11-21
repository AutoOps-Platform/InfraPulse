import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, LinkButton } from '@grafana/ui';
import { api, errorMessage } from '../api/client';
import { buildDashboardUrl, buildRuleUrl } from '../api/dashboard';
import { downloadBootstrap } from '../api/download';
import type { AwsServer, BootstrapIntent, OnboardingProgress, RetryIntent } from '../api/types';
import { useAdmin } from '../components/Common';
import { OnboardingStatus, useOnboardingProgress } from '../components/OnboardingStatus';

type Operation = 'download' | RetryIntent['mode'] | 'decommission';
function receiptKey(p: OnboardingProgress) {
  return JSON.stringify([p.serverId, p.attemptId, p.enrollmentId, p.generation, p.state, p.stage, p.bindingState,
    p.agent.nodeId, p.availability.available, p.availability.configurationVersion, p.alertSync.generation,
    p.alertSync.state, p.alertSync.desiredHash, p.alertSync.syncedAt]);
}

export function VmOnboarding({ server, refreshInventory }: { server?: AwsServer; refreshInventory: () => void }) {
  const admin = useAdmin();
  const status = useOnboardingProgress(server?.id);
  const p = status.progress;
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [confirmDecommission, setConfirmDecommission] = useState(false);
  const lock = useRef<{ kind: Operation; intent: BootstrapIntent } | undefined>(undefined);
  const downloadedGenerations = useRef(new Set<number>());
  const controller = useRef<AbortController | undefined>(undefined);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timeout.current !== undefined) clearTimeout(timeout.current);
      controller.current?.abort();
    };
  }, []);
  const latest = p && !status.error ? receiptKey(p) : undefined;
  const coherent = Boolean(latest && server && latest === receiptKey(server.onboarding));
  const mismatch = server && !coherent ? latest : undefined;
  const refreshedMismatch = useRef<string | undefined>(undefined);
  const inspecting = useRef(false);
  useEffect(() => {
    if (coherent) refreshedMismatch.current = undefined;
    if (!mismatch || inspecting.current || refreshedMismatch.current === mismatch) return;
    refreshedMismatch.current = mismatch;
    refreshInventory();
  }, [coherent, mismatch, refreshInventory]);
  const blocked = !coherent || !admin || Boolean(server?.archived_at) || !p || pending || status.reading || Boolean(status.error) || Boolean(failure);
  // AwaitingBootstrap is also the genuine B4 *prepared* recovery generation.
  // No blanket non-retired-history block: backend enforces actor/generation CAS.
  const canDownload = p?.availability.available && p.state === 'Pending' && p.stage === 'AwaitingBootstrap' && p.bindingState === null && !downloadedGenerations.current.has(p.generation);
  const canRegenerate = Boolean(p?.availability.available && p.attemptId && p.bindingState === null && ['Pending', 'Failed', 'Expired'].includes(p.state) && ['AwaitingRegistration', 'ReconcilingActivation', 'Failed', 'Expired', 'CleanupRequired'].includes(p.stage));
  const canRetryConfig = p?.availability.available && p.bindingState === 'Active' && ['Success', 'Failed'].includes(p.state) && !['Decommissioning', 'CleanupRequired', 'Retired'].includes(p.stage);
  const canDecommission = Boolean(p?.attemptId && !['Decommissioning', 'Retired'].includes(p.stage));
  const execute = async (kind: Operation) => {
    if (!server || blocked || lock.current || !p || (kind !== 'decommission' && !p.availability.available) || (kind === 'download' && !canDownload) || (kind === 'regenerate-unused' && !canRegenerate) || (kind === 'retry-config' && !canRetryConfig) || (kind === 'decommission' && (!canDecommission || !confirmDecommission))) return;
    // Synchronous intent fence precedes the first await. Never regenerate this
    // UUID on a timeout, AbortError or ambiguous response; no automatic POSTs.
    const intent = { requestId: crypto.randomUUID() };
    lock.current = { kind, intent };
    const abort = new AbortController();
    controller.current = abort;
    setPending(true);
    setFailure(undefined);
    setNotice(undefined);
    timeout.current = setTimeout(() => abort.abort(), 30000);
    if (kind === 'download') downloadedGenerations.current.add(p.generation);
    try {
      if (kind === 'download') {
        await downloadBootstrap(server.id, intent, abort.signal);
        if (!mounted.current) return;
        setNotice('Browser download requested. Saving and local execution are not observed by this page. No attachment replay is available.');
        await status.refresh();
      } else {
        const result = kind === 'decommission'
          ? await api.decommission(server.id, intent, abort.signal)
          : await api.retryOnboarding(server.id, { ...intent, mode: kind }, abort.signal);
        if (!mounted.current) return;
        status.accept(result);
        setNotice(kind === 'regenerate-unused'
          ? 'Recovery result recorded. Only Pending / AwaitingBootstrap permits a NEW deliberate download below; no download starts automatically. The backend requires the same recovery actor and current generation.'
          : kind === 'decommission'
            ? 'Decommission intent accepted, not a cleanup or Retired receipt. Inspect persisted progress.'
            : 'Configuration retry accepted for the registered node; no activation was regenerated.');
      }
      if (mounted.current) { lock.current = undefined; setConfirmDecommission(false); }
    } catch (error: unknown) {
      if (mounted.current) setFailure(`Outcome unknown; this intent will not be replayed. ${errorMessage(error)} Read persisted progress before a NEW deliberate recovery operation. A lost download cannot be retrieved.`);
      // Keep the intent fence after every failure; only an explicit successful
      // GET inspection permits a new action. Same-generation download stays spent.
    } finally {
      if (timeout.current !== undefined) clearTimeout(timeout.current);
      if (mounted.current) setPending(false);
    }
  };
  const inspect = async () => {
    if (inspecting.current) return;
    inspecting.current = true;
    try {
      const result = await status.refresh();
      if (mounted.current && result && !pending) {
        lock.current = undefined;
        setFailure(undefined);
        refreshedMismatch.current = receiptKey(result);
        refreshInventory();
      }
    } finally {
      inspecting.current = false;
    }
  };
  // Stay mounted when only the same VM's authoritative inventory is reloading.
  if (!server) return null;
  const metrics = coherent ? buildDashboardUrl(server) : undefined;
  return <>
    <h2>Onboarding</h2>
    {!admin && <p>Read-only. A Management Admin can download bootstrap and request recovery.</p>}
    <Button variant="secondary" disabled={pending || status.reading} onClick={() => { void inspect(); }}>Refresh progress</Button>
    <p>{status.pollState}</p>
    {status.reading && <p>Reading persisted progress…</p>}
    {status.error && <Alert severity="error" title="Progress unavailable — metrics Unknown">{status.error}</Alert>}
    {p && <OnboardingStatus progress={p} configuration={coherent ? server.configuration : undefined} unavailable={Boolean(status.error)} />}
    {p && !status.error && !coherent && <p>Configuration and monitoring links are unavailable until the current inventory receipt agrees.</p>}
    {metrics && <LinkButton href={metrics}>Open metrics</LinkButton>}
    {coherent && server.alertRuleUids.length > 0 && <details>
      <summary>Alert rules for the current receipt</summary>
      {server.alertRuleUids.map(uid => <LinkButton key={uid} variant="secondary" href={buildRuleUrl(uid)}>Rule {uid}</LinkButton>)}
    </details>}
    {admin && !server.archived_at && <>
      <Button disabled={blocked || !canDownload} onClick={() => { void execute('download'); }}>{pending ? 'Operation in progress…' : 'Download one-time bootstrap file'}</Button>
      <p>Keep the file private. Run the saved file only on this intended {server.os} host, as {server.os === 'linux' ? 'root' : 'Administrator in elevated PowerShell under local execution policy'}. Do not share its activation values or clear lifecycle markers to re-register. Remove the file after use.</p>
    </>}
    {p?.stage === 'AwaitingBootstrap' && p.attemptId && <p>This is a prepared unused-activation recovery. The Admin who requested recovery must use a new deliberate download click for this current generation.</p>}
    {admin && !server.archived_at && <details>
      <summary>Advanced recovery</summary>
      <p>Recovery cannot reuse a registered activation. Retry configuration for an Active node. A cleanup request is not proof of completion.</p>
      <Button variant="secondary" disabled={blocked || !canRegenerate} onClick={() => { void execute('regenerate-unused'); }}>Request unused-activation recovery</Button>{' '}
      <Button variant="secondary" disabled={blocked || !canRetryConfig} onClick={() => { void execute('retry-config'); }}>Retry configuration of registered node</Button>
      <p><Checkbox label="I intend asynchronous decommission (or explicit CleanupRequired retry); this does not assert cleanup completion" checked={confirmDecommission} disabled={blocked || !canDecommission} onChange={(event) => setConfirmDecommission(event.currentTarget.checked)} /></p>
      <Button variant="destructive" disabled={blocked || !canDecommission || !confirmDecommission} onClick={() => { void execute('decommission'); }}>Request decommission / cleanup retry</Button>
    </details>}
    {failure && <Alert severity="warning" title="Mutation result uncertain — inspect, do not replay">{failure}</Alert>}
    {notice && <Alert severity="info" title="Operation receipt">{notice}</Alert>}
    <p>A request receipt, downloaded file, SSM registration, configuration result and independent CloudWatch metrics are separate evidence. Alert sync remains required until an operator current-generation receipt.</p>
  </>;
}
