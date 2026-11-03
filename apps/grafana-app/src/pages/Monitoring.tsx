import React from 'react';
import { config } from '@grafana/runtime';
import { Alert, Button, LinkButton, useStyles2 } from '@grafana/ui';
import { api, ApiError, isUuid } from '../api/client';
import { useSelection } from '../hooks/useSelection';
import { useResource } from '../hooks/useApi';
import { AgentPicker, ServerPicker } from '../components/Pickers';
import { LoadState, TelemetryView, time } from '../components/Common';
import { getStyles } from '../styles';

export default function Monitoring() {
  const selection = useSelection();
  const s = useStyles2(getStyles);
  const selected = Boolean(selection.server && selection.agent && selection.agent.server_id === selection.server.id);
  const evidence = useResource(
    `monitoring:${selection.server?.id ?? ''}:${selection.agent?.id ?? ''}`,
    async (signal) => {
      const [server, agent] = await Promise.all([
        api.server(selection.server!.id, signal),
        api.agent(selection.agent!.id, signal),
      ]);
      if (agent.server_id !== server.id) {
        throw new Error('Selection mismatch');
      }
      let assignment = null;
      try {
        assignment = await api.assignment(server.id, signal);
      } catch (failure: unknown) {
        if (!(failure instanceof ApiError && failure.status === 404)) {
          throw failure;
        }
      }
      const version = assignment ? await api.version(assignment.profile_version_id) : undefined;
      return { server, agent, assignment, version };
    },
    selected
  );
  const actual = evidence.data;
  const dashboardUrl =
    actual &&
    isUuid(actual.server.id) &&
    isUuid(actual.agent.id) &&
    actual.agent.server_id === actual.server.id &&
    actual.agent.os_at_registration === actual.server.os
      ? `${config.appSubUrl}/d/${actual.server.os === 'linux' ? 'infrapulse-linux-host' : 'infrapulse-windows-host'}?${new URLSearchParams({ 'var-server_id': actual.server.id, 'var-agent_id': actual.agent.id }).toString()}`
      : undefined;
  return (
    <>
      <h1>Monitoring</h1>
      <p>
        Open the existing OS dashboard for an authoritative Server/Agent pair. No independent charts or credentials are
        embedded in dashboard URLs.
      </p>
      {selection.invalid && (
        <Alert severity="error" title="Invalid selection">
          Select actual records below; no dashboard URL is built from unverified IDs.
        </Alert>
      )}
      <LoadState {...selection.initial} />
      <ServerPicker value={selection.server} includeArchived onChange={selection.setServer} />
      {selection.server && (
        <AgentPicker
          key={selection.server.id}
          server={selection.server}
          value={selection.agent}
          onChange={selection.setAgent}
        />
      )}
      <div className={s.row}>
        <Button variant="secondary" disabled={!selected || evidence.loading} onClick={evidence.retry}>
          Refresh authoritative telemetry
        </Button>
        {dashboardUrl ? (
          <LinkButton href={dashboardUrl}>Open {actual?.server.os} host dashboard</LinkButton>
        ) : (
          <Button disabled>Choose a verified Server and Agent to open monitoring</Button>
        )}
      </div>
      {actual && actual.agent.os_at_registration !== actual.server.os && (
        <Alert severity="warning" title="Historical Agent OS does not match current Server OS">
          This Agent was registered for {actual.agent.os_at_registration}, but the Server is now {actual.server.os}. The
          dashboard link is blocked to avoid displaying the wrong OS dashboard. Choose an Agent whose registered OS
          matches the current Server OS; historical telemetry evidence remains visible below.
        </Alert>
      )}
      {selected && (
        <LoadState {...evidence}>
          {actual && (
            <>
              <div className={s.grid}>
                <section>
                  <h2>Server evidence</h2>
                  <p>
                    {actual.server.name} · {actual.server.id} · {actual.server.os}
                  </p>
                  <TelemetryView telemetry={actual.server.telemetry} />
                </section>
                <section>
                  <h2>Selected Agent evidence</h2>
                  <p>
                    {actual.agent.id} · lifecycle {actual.agent.lifecycle} · reported version{' '}
                    {actual.agent.version ?? 'Not reported'}
                  </p>
                  <TelemetryView telemetry={actual.agent.telemetry} />
                </section>
              </div>
              <section className={s.card}>
                <h2>Desired vs Agent-reported configuration</h2>
                <p>
                  Desired version: {actual.assignment?.profile_version_id ?? 'Not assigned'}
                  <br />
                  Last reported applied: {actual.agent.last_applied_profile_version_id ?? 'Not reported'} at{' '}
                  {time(actual.agent.last_applied_at)}
                  <br />
                  Last report result: {actual.agent.last_config_report_result ?? 'Not reported'} at{' '}
                  {time(actual.agent.last_config_report_at)}
                </p>
                {actual.version && (
                  <>
                    <p>Desired published config checksum: {actual.version.checksum}</p>
                    <ul>
                      {Object.entries(actual.version.config.metric_groups).map(([group, enabled]) => (
                        <li key={group}>
                          {group}: {enabled ? 'enabled in desired profile' : 'disabled in desired profile'}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <p>
                  Desired configuration is not proof of applied configuration. Agent reports are not independent
                  installation attestations.
                </p>
              </section>
            </>
          )}
        </LoadState>
      )}
      <Alert severity="info" title="Interpreting no data">
        A dashboard with no samples can mean a query/time-range mismatch, a profile-disabled metric group, or metrics
        not yet received. “Not seen” means no authenticated successful metric receipt was reported, not that the machine
        is powered off. Source gaps/staleness may make status Unknown. Dashboard availability is not host uptime;
        backend telemetry with source health and evidence timestamps is authoritative for these status labels.
      </Alert>
    </>
  );
}
