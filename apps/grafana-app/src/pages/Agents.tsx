import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, Button, Field, Input, LinkButton, useStyles2 } from '@grafana/ui';
import { api, appPath, isUuid } from '../api/client';
import type { Agent } from '../api/types';
import { useCursor, useResource } from '../hooks/useApi';
import { Choice, LoadState, Pager, Table, TelemetryView, time, useAdmin } from '../components/Common';
import { Confirm } from '../components/Confirm';
import { getStyles } from '../styles';

function AgentDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const detail = useResource(`agent:${id}`, (signal) => api.agent(id, signal));
  const [transition, setTransition] = useState<'enable' | 'disable' | 'retire'>();
  const admin = useAdmin();
  const s = useStyles2(getStyles);
  return (
    <section className={s.card}>
      <h2>Agent detail</h2>
      <LoadState {...detail}>
        {detail.data && (
          <>
            <dl>
              <dt>Agent ID</dt>
              <dd>{detail.data.id}</dd>
              <dt>Immutable Server link</dt>
              <dd>
                <a href={`${appPath('servers')}?server=${encodeURIComponent(detail.data.server_id)}`}>
                  {detail.data.server_id}
                </a>
              </dd>
              <dt>OS at registration</dt>
              <dd>{detail.data.os_at_registration}</dd>
              <dt>Lifecycle</dt>
              <dd>{detail.data.lifecycle}</dd>
              <dt>Reported version</dt>
              <dd>
                {detail.data.version ?? 'Not reported'} · source {detail.data.version_source ?? 'Not reported'} ·{' '}
                {time(detail.data.version_reported_at)}
              </dd>
              <dt>Last reported applied version</dt>
              <dd>
                {detail.data.last_applied_profile_version_id ?? 'Not reported'} · {time(detail.data.last_applied_at)}
              </dd>
              <dt>Last configuration report</dt>
              <dd>
                {detail.data.last_config_report_result ?? 'Not reported'} · {time(detail.data.last_config_report_at)}
              </dd>
            </dl>
            <p>Versions/configuration reports are Agent statements, not installation or binary attestations.</p>
            <TelemetryView telemetry={detail.data.telemetry} />
            <div className={s.row}>
              <Button variant="secondary" onClick={detail.retry}>
                Refresh detail
              </Button>
              <LinkButton
                variant="secondary"
                href={`${appPath('monitoring')}?${new URLSearchParams({ server: detail.data.server_id, agent: detail.data.id }).toString()}`}
              >
                View monitoring
              </LinkButton>
              {admin && detail.data.lifecycle !== 'retired' && (
                <>
                  <Button
                    variant="secondary"
                    onClick={() => setTransition(detail.data?.lifecycle === 'active' ? 'disable' : 'enable')}
                  >
                    {detail.data.lifecycle === 'active' ? 'Disable Agent' : 'Enable Agent'}
                  </Button>
                  <Button variant="destructive" onClick={() => setTransition('retire')}>
                    Retire Agent
                  </Button>
                </>
              )}
            </div>
            {transition && (
              <Confirm
                title={`${transition} Agent?`}
                warning={
                  transition === 'enable'
                    ? 'Enable changes lifecycle only. Previously revoked credentials remain revoked; issue a new key deliberately. This does not install or mark the Agent Online.'
                    : `${transition === 'retire' ? 'Retirement is terminal. ' : ''}This revokes Agent credentials atomically. Gateway positive authentication cache may last up to 30 seconds; in-flight decisions are not cancelled.`
                }
                operation={() => api.transitionAgent(id, transition)}
                onDone={() => {
                  detail.retry();
                  onChanged();
                }}
                onClose={() => setTransition(undefined)}
              />
            )}
          </>
        )}
      </LoadState>
    </section>
  );
}
export default function Agents() {
  const [params, setParams] = useSearchParams();
  const initialServer = params.get('server') ?? '';
  const [server, setServer] = useState(isUuid(initialServer) ? initialServer : '');
  const [lifecycle, setLifecycle] = useState('');
  const valid = !server || isUuid(server);
  const s = useStyles2(getStyles);
  const list = useCursor<Agent>({ server, lifecycle }, api.agents, valid);
  const selected = params.get('agent') ?? '';
  return (
    <>
      <h1>Agents</h1>
      <p>
        Lifecycle controls authorization. Online status comes only from telemetry. Missing version means Not reported.
      </p>
      <div className={s.row}>
        <Field
          label="Exact Server UUID"
          invalid={!valid}
          error={!valid ? 'Enter a canonical lowercase UUID or clear this filter.' : undefined}
        >
          <Input aria-label="Exact Server UUID" value={server} onChange={(e) => setServer(e.currentTarget.value)} />
        </Field>
        <Choice
          label="Lifecycle filter"
          value={lifecycle}
          onChange={setLifecycle}
          options={[
            { label: 'All lifecycles', value: '' },
            { label: 'Active', value: 'active' },
            { label: 'Disabled', value: 'disabled' },
            { label: 'Retired (terminal)', value: 'retired' },
          ]}
        />
        <Button variant="secondary" disabled={!valid || list.loading} onClick={list.retry}>
          Refresh
        </Button>
      </div>
      {valid && (
        <>
          <LoadState {...list} empty={list.data?.items.length === 0}>
            <Table
              caption="Registered Agents"
              headings={['Agent', 'Server', 'Lifecycle', 'Reported version', 'Telemetry / last metric', 'Detail']}
            >
              {list.data?.items.map((agent) => (
                <tr key={agent.id}>
                  <td>{agent.id}</td>
                  <td>
                    <a href={`${appPath('servers')}?server=${encodeURIComponent(agent.server_id)}`}>
                      {agent.server_id}
                    </a>
                  </td>
                  <td>{agent.lifecycle}</td>
                  <td>{agent.version ?? 'Not reported'}</td>
                  <td>
                    {agent.telemetry.status} · {agent.telemetry.source_health}
                    <br />
                    {time(agent.last_metric_seen_at)}
                  </td>
                  <td>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setParams({ agent: agent.id, server: agent.server_id })}
                    >
                      Open detail
                    </Button>
                  </td>
                </tr>
              ))}
            </Table>
          </LoadState>
          <Pager {...list} nextCursor={list.data?.next_cursor} />
        </>
      )}
      {selected &&
        (isUuid(selected) ? (
          <AgentDetail key={selected} id={selected} onChanged={list.retry} />
        ) : (
          <Alert severity="error" title="Invalid Agent ID">
            Choose an Agent from Management inventory.
          </Alert>
        ))}
    </>
  );
}
