import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, Button, Field, Input, LinkButton, useStyles2 } from '@grafana/ui';
import { api, ApiError, appPath, isUuid } from '../api/client';
import type { Server } from '../api/types';
import { useCursor, useResource } from '../hooks/useApi';
import { Choice, LoadState, osOptions, Pager, Table, TelemetryView, time, useAdmin } from '../components/Common';
import { ServerForm } from '../components/ServerForm';
import { Confirm } from '../components/Confirm';
import { getStyles } from '../styles';

export function ServerDetail({ id, onChanged }: { id: string; onChanged?: () => void }) {
  const detail = useResource(`server:${id}`, (signal) => api.server(id, signal));
  const assignment = useResource(`assignment:${id}`, async (signal) => {
    try {
      return await api.assignment(id, signal);
    } catch (failure: unknown) {
      if (failure instanceof ApiError && failure.status === 404) {
        return null;
      }
      throw failure;
    }
  });
  const agents = useCursor({ server: id }, api.agents);
  const [edit, setEdit] = useState(false);
  const [archive, setArchive] = useState(false);
  const admin = useAdmin();
  const s = useStyles2(getStyles);
  const refresh = () => {
    detail.retry();
    assignment.retry();
    agents.retry();
    onChanged?.();
  };
  return (
    <section className={s.card}>
      <h2>Server detail</h2>
      <LoadState {...detail}>
        {detail.data && (
          <>
            <h3>{detail.data.name}</h3>
            <dl>
              <dt>Authoritative Server ID</dt>
              <dd>{detail.data.id}</dd>
              <dt>OS / Environment</dt>
              <dd>
                {detail.data.os} / {detail.data.environment}
              </dd>
              <dt>Archived</dt>
              <dd>{detail.data.archived_at ? time(detail.data.archived_at) : 'No'}</dd>
              <dt>Updated</dt>
              <dd>{time(detail.data.updated_at)}</dd>
            </dl>
            <pre className={s.code}>{JSON.stringify(detail.data.metadata, null, 2)}</pre>
            <TelemetryView telemetry={detail.data.telemetry} />
            <div className={s.row}>
              <Button variant="secondary" onClick={refresh}>
                Refresh detail
              </Button>
              {admin && !detail.data.archived_at && (
                <>
                  <Button variant="secondary" onClick={() => setEdit(true)}>
                    Edit Server
                  </Button>
                  <Button variant="destructive" onClick={() => setArchive(true)}>
                    Archive Server
                  </Button>
                </>
              )}
              <LinkButton href={`${appPath('install')}?server=${encodeURIComponent(id)}`} variant="secondary">
                Onboarding
              </LinkButton>
              <LinkButton href={`${appPath('profiles')}?server=${encodeURIComponent(id)}`} variant="secondary">
                Choose profile
              </LinkButton>
              <LinkButton href={`${appPath('monitoring')}?server=${encodeURIComponent(id)}`} variant="secondary">
                View monitoring
              </LinkButton>
            </div>
            {edit && <ServerForm server={detail.data} onClose={() => setEdit(false)} onSaved={refresh} />}
            {archive && (
              <Confirm
                title="Archive Server permanently?"
                warning="This disables the Server's Agents and revokes their credentials atomically. History remains; there is no restore UI. Gateway authentication cache may remain valid up to 30 seconds; in-flight decisions are not cancelled."
                operation={() => api.archiveServer(id)}
                onDone={refresh}
                onClose={() => setArchive(false)}
              />
            )}
          </>
        )}
      </LoadState>
      <h3>Desired assignment</h3>
      <LoadState {...assignment}>
        {assignment.data ? (
          <p>
            Exact profile version: {assignment.data.profile_version_id} · assigned {time(assignment.data.assigned_at)}
          </p>
        ) : (
          <Alert severity="info" title="No profile assigned">
            An assignment 404 is expected for an unassigned Server. Choose an OS-compatible published version before
            provisioning.
          </Alert>
        )}
      </LoadState>
      <h3>Registered Agents</h3>
      <LoadState {...agents} empty={agents.data?.items.length === 0}>
        <Table
          caption="Agent lifecycle and reported configuration are distinct from desired assignment"
          headings={['Agent', 'Lifecycle', 'Version', 'Configuration report', 'Metrics']}
        >
          {agents.data?.items.map((agent) => (
            <tr key={agent.id}>
              <td>
                <a href={`${appPath('agents')}?server=${encodeURIComponent(id)}&agent=${encodeURIComponent(agent.id)}`}>
                  {agent.id}
                </a>
              </td>
              <td>{agent.lifecycle}</td>
              <td>{agent.version ?? 'Not reported'}</td>
              <td>
                Last report: {agent.last_config_report_result ?? 'Not reported'} at {time(agent.last_config_report_at)}
                <br />
                Applied version: {agent.last_applied_profile_version_id ?? 'Not reported'} at{' '}
                {time(agent.last_applied_at)}
              </td>
              <td>
                {agent.telemetry.status}
                <br />
                Seen {time(agent.last_metric_seen_at)}
              </td>
            </tr>
          ))}
        </Table>
      </LoadState>
      <Pager {...agents} nextCursor={agents.data?.next_cursor} />
    </section>
  );
}
export default function Servers() {
  const [params, setParams] = useSearchParams();
  const selected = params.get('server') ?? '';
  const [name, setName] = useState('');
  const [os, setOs] = useState('');
  const [environment, setEnvironment] = useState('');
  const [archive, setArchive] = useState('false');
  const [create, setCreate] = useState(false);
  const admin = useAdmin();
  const s = useStyles2(getStyles);
  const list = useCursor({ name, os, environment, archive }, api.servers);
  const select = (server: Server) => setParams({ server: server.id });
  return (
    <>
      <h1>Servers</h1>
      <p>Inventory name search matches a literal prefix, not a substring. Filters reset opaque pagination.</p>
      <div className={s.row}>
        <Field label="Name prefix">
          <Input
            aria-label="Name prefix"
            value={name}
            maxLength={128}
            onChange={(e) => setName(e.currentTarget.value)}
          />
        </Field>
        <Choice label="OS filter" value={os} options={osOptions} onChange={setOs} />
        <Field label="Exact environment">
          <Input
            aria-label="Exact environment"
            value={environment}
            maxLength={64}
            onChange={(e) => setEnvironment(e.currentTarget.value)}
          />
        </Field>
        <Choice
          label="Archive filter"
          value={archive}
          options={[
            { label: 'Unarchived', value: 'false' },
            { label: 'Archived', value: 'true' },
            { label: 'All', value: '' },
          ]}
          onChange={setArchive}
        />
        <Button variant="secondary" onClick={list.retry} disabled={list.loading}>
          Refresh
        </Button>
        {admin && <Button onClick={() => setCreate(true)}>Add Server</Button>}
      </div>
      <LoadState {...list} empty={list.data?.items.length === 0}>
        <Table
          caption="Server inventory"
          headings={['Name', 'Server ID', 'OS / environment', 'Telemetry', 'Archived', 'Detail']}
        >
          {list.data?.items.map((server) => (
            <tr key={server.id}>
              <td>{server.name}</td>
              <td>{server.id}</td>
              <td>
                {server.os} / {server.environment}
              </td>
              <td>
                {server.telemetry.status}
                <br />
                {server.telemetry.source_health}
                <br />
                {time(server.telemetry.status_as_of)}
              </td>
              <td>{server.archived_at ? 'Yes' : 'No'}</td>
              <td>
                <Button variant="secondary" size="sm" onClick={() => select(server)}>
                  Open detail
                </Button>
              </td>
            </tr>
          ))}
        </Table>
      </LoadState>
      <Pager {...list} nextCursor={list.data?.next_cursor} />
      {selected &&
        (isUuid(selected) ? (
          <ServerDetail key={selected} id={selected} onChanged={list.retry} />
        ) : (
          <Alert severity="error" title="Invalid Server ID">
            Choose a Server from Management inventory.
          </Alert>
        ))}
      {create && (
        <ServerForm
          onClose={() => setCreate(false)}
          onSaved={(server) => {
            list.retry();
            select(server);
          }}
        />
      )}
    </>
  );
}
