import React, { useState } from 'react';
import { Alert, Button, LinkButton, useStyles2 } from '@grafana/ui';
import { api, appPath } from '../api/client';
import type { Agent, Filters, Page, Server } from '../api/types';
import { useResource } from '../hooks/useApi';
import { LoadState, Table, time } from '../components/Common';
import { getStyles } from '../styles';

async function scan<T>(
  read: (filters: Filters, signal: AbortSignal) => Promise<Page<T>>,
  filters: Filters,
  signal: AbortSignal
) {
  const rows: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    if (signal.aborted) {
      throw new DOMException('Cancelled', 'AbortError');
    }
    const result = await read({ ...filters, limit: 100, cursor }, signal);
    rows.push(...result.items);
    if (!result.next_cursor) {
      return { rows, partial: false };
    }
    cursor = result.next_cursor;
  }
  return { rows, partial: true };
}
export default function Overview() {
  const [scanId, setScanId] = useState(0);
  const s = useStyles2(getStyles);
  const inventory = useResource(`inventory:${scanId}`, async (signal) => {
    const started = new Date().toISOString();
    const [servers, agents] = await Promise.all([
      scan<Server>(api.servers, { archive: 'false' }, signal),
      scan<Agent>(api.agents, {}, signal),
    ]);
    return { servers, agents, started, ended: new Date().toISOString() };
  });
  const principal = useResource('overview-me', api.me);
  const counts = { Online: 0, Stale: 0, Offline: 0, Unknown: 0 };
  inventory.data?.servers.rows.forEach((server) => {
    counts[server.telemetry.status]++;
  });
  const lifecycle = { active: 0, disabled: 0, retired: 0 };
  const versions = new Map<string, number>();
  inventory.data?.agents.rows.forEach((agent) => {
    lifecycle[agent.lifecycle]++;
    const version = agent.version ?? 'Not reported';
    versions.set(version, (versions.get(version) ?? 0) + 1);
  });
  return (
    <>
      <h1>Overview</h1>
      <p>
        Management inventory and conservative telemetry evidence. No dashboard or lifecycle field is an all-system
        health check.
      </p>
      <LoadState {...principal}>
        {principal.data && (
          <Alert severity="info" title="Management API reachable">
            Verified /me response: {principal.data.role}. This proves Management reachability only, not Gateway,
            Prometheus, Agent or host health.
          </Alert>
        )}
      </LoadState>
      <div className={s.row}>
        <Button variant="secondary" disabled={inventory.loading} onClick={() => setScanId((id) => id + 1)}>
          Rescan inventory
        </Button>
        <LinkButton href={appPath('install')}>Onboard a Server</LinkButton>
      </div>
      <LoadState {...inventory}>
        {inventory.data && (
          <>
            <Alert
              severity={inventory.data.servers.partial || inventory.data.agents.partial ? 'warning' : 'info'}
              title={
                inventory.data.servers.partial || inventory.data.agents.partial
                  ? 'Partial inventory — lower-bound counts only'
                  : 'Completed bounded inventory scan'
              }
            >
              Scan {time(inventory.data.started)} to {time(inventory.data.ended)}; not an atomic snapshot. Each family
              is capped at 100 pages × 100 rows. Changes during pagination may affect counts.{' '}
              {inventory.data.servers.partial && 'Server scan truncated. '}
              {inventory.data.agents.partial && 'Agent scan truncated.'}
            </Alert>
            <div className={s.grid}>
              <section className={s.card}>
                <h2>
                  Unarchived Servers {inventory.data.servers.partial ? '≥' : ''}
                  {inventory.data.servers.rows.length}
                </h2>
                {Object.entries(counts).map(([label, count]) => (
                  <p key={label}>
                    {label}: {count}
                    {inventory.data?.servers.partial ? ' (observed subset)' : ''}
                  </p>
                ))}
              </section>
              <section className={s.card}>
                <h2>
                  Agents {inventory.data.agents.partial ? '≥' : ''}
                  {inventory.data.agents.rows.length}
                </h2>
                {Object.entries(lifecycle).map(([label, count]) => (
                  <p key={label}>
                    {label}: {count}
                    {inventory.data?.agents.partial ? ' (observed subset)' : ''}
                  </p>
                ))}
                <p>Active means authorized lifecycle, not installed or Online.</p>
              </section>
            </div>
            <Table
              caption="Agent-reported versions — reports, not independent attestations"
              headings={['Reported version', 'Observed count']}
            >
              {Array.from(versions.entries()).map(([version, count]) => (
                <tr key={version}>
                  <td>{version}</td>
                  <td>{count}</td>
                </tr>
              ))}
            </Table>
            {inventory.data.servers.rows.length === 0 && inventory.data.agents.rows.length === 0 && (
              <Alert severity="info" title="Inventory is empty">
                Add a Server to begin onboarding.
              </Alert>
            )}
            <Table
              caption="Telemetry source evidence for scanned unarchived Servers"
              headings={['Server', 'Status', 'Source health', 'Evidence as of', 'Confidence']}
            >
              {inventory.data.servers.rows.map((server) => (
                <tr key={server.id}>
                  <td>
                    <a href={`${appPath('servers')}?server=${encodeURIComponent(server.id)}`}>{server.name}</a>
                  </td>
                  <td>{server.telemetry.status}</td>
                  <td>{server.telemetry.source_health}</td>
                  <td>{time(server.telemetry.status_as_of)}</td>
                  <td>{server.telemetry.confidence_reason}</td>
                </tr>
              ))}
            </Table>
          </>
        )}
      </LoadState>
    </>
  );
}
