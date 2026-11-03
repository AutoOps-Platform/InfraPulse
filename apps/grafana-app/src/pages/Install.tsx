import React, { useState } from 'react';
import { Alert, Button, Checkbox, LinkButton, useStyles2 } from '@grafana/ui';
import { api, ApiError, appPath } from '../api/client';
import { useResource } from '../hooks/useApi';
import { useSelection } from '../hooks/useSelection';
import { LoadState, TelemetryView, useAdmin } from '../components/Common';
import { ServerForm } from '../components/ServerForm';
import { AgentPicker, ServerPicker } from '../components/Pickers';
import { ProfileBrowser } from '../components/ProfileBrowser';
import { Confirm } from '../components/Confirm';
import { IssueCredential } from '../components/IssueCredential';
import { ExistingKeyPreview } from '../components/SecretModal';
import type { Agent, Server } from '../api/types';
import { getStyles } from '../styles';

function Onboarding({
  server,
  agent,
  onAgent,
}: {
  server: Server;
  agent?: Agent;
  onAgent: (agent: Agent | undefined) => void;
}) {
  const [register, setRegister] = useState(false);
  const [agentRevision, setAgentRevision] = useState(0);
  const [acceptedVersion, setAcceptedVersion] = useState('');
  const [paste, setPaste] = useState(false);
  const admin = useAdmin();
  const s = useStyles2(getStyles);
  const desired = useResource(`onboarding-assignment:${server.id}`, async (signal) => {
    try {
      const assignment = await api.assignment(server.id, signal);
      const version = await api.version(assignment.profile_version_id);
      return { assignment, version };
    } catch (failure: unknown) {
      if (failure instanceof ApiError && failure.status === 404) {
        return null;
      }
      throw failure;
    }
  });
  const ready = Boolean(
    desired.data &&
      desired.data.version.id === desired.data.assignment.profile_version_id &&
      desired.data.version.status === 'published' &&
      desired.data.version.config.os === server.os &&
      acceptedVersion === desired.data.version.id &&
      !server.archived_at &&
      agent?.server_id === server.id &&
      agent.lifecycle === 'active'
  );
  return (
    <>
      <section className={s.card}>
        <h2>2. Register or select one active Agent</h2>
        <p>
          Server OS is authoritative: <strong>{server.os}</strong>. Identity is assigned by Management, never by the
          installer or URL.
        </p>
        {server.archived_at && (
          <Alert severity="warning" title="Archived Server">
            Select an unarchived Server before onboarding.
          </Alert>
        )}
        {admin && (
          <Button disabled={Boolean(server.archived_at)} onClick={() => setRegister(true)}>
            Register one active Telegraf Agent
          </Button>
        )}
        <AgentPicker
          key={`${server.id}:${agentRevision}`}
          server={server}
          value={agent}
          onChange={onAgent}
          activeOnly
        />
        {register && (
          <Confirm
            title="Register Agent on this Server?"
            warning={`Register a new active Telegraf Agent for ${server.name} (${server.id}, ${server.os}). Only one active Agent per Server is allowed; 409 means inspect current Agents rather than blindly retry. Registration is not installation or Online.`}
            operation={async () => {
              const result = await api.registerAgent(server.id);
              onAgent(result);
            }}
            onDone={() => setAgentRevision((id) => id + 1)}
            onClose={() => setRegister(false)}
          />
        )}
      </section>
      <section className={s.card}>
        <h2>3. Assign an exact compatible published profile</h2>
        <LoadState {...desired}>
          {desired.data ? (
            <>
              <p>
                Desired version: <strong>{desired.data.version.id}</strong> · v{desired.data.version.version} ·{' '}
                {desired.data.version.status}
                <br />
                OS: {desired.data.version.config.os}
                <br />
                Checksum: {desired.data.version.checksum}
              </p>
              <Checkbox
                label="I reviewed and choose this exact desired published version for onboarding."
                disabled={desired.data.version.status !== 'published' || desired.data.version.config.os !== server.os}
                checked={acceptedVersion === desired.data.version.id}
                onChange={(e) => setAcceptedVersion(e.currentTarget.checked ? (desired.data?.version.id ?? '') : '')}
              />
            </>
          ) : (
            <Alert severity="info" title="No profile assigned">
              Use the published-version browser below to assign a compatible exact version before issuing a key.
            </Alert>
          )}
        </LoadState>
        <Button
          variant="secondary"
          onClick={() => {
            setAcceptedVersion('');
            desired.retry();
          }}
        >
          Refresh desired assignment
        </Button>
        <ProfileBrowser
          server={server}
          onAssigned={() => {
            setAcceptedVersion('');
            desired.retry();
          }}
        />
      </section>
      <section className={s.card}>
        <h2>4. Issue once, preview, then install locally</h2>
        <p>
          All three credential scopes are required. The one-time key modal allows actual provisioning preview without
          placing the key in commands. Preview records a receipt only; it does not apply configuration or prove
          installation.
        </p>
        {!admin && (
          <Alert severity="warning" title="Admin required">
            Ask an Admin to register, assign and issue credentials. Backend RBAC remains authoritative.
          </Alert>
        )}
        {admin && agent && ready ? (
          <>
            <IssueCredential
              key={`${server.id}:${agent.id}:${desired.data?.version.id}`}
              server={server}
              agent={agent}
              provisioning
              expectedProfile={
                desired.data
                  ? { versionId: desired.data.version.id, checksum: desired.data.version.checksum }
                  : undefined
              }
              onChanged={() => undefined}
            />
            <Button variant="secondary" onClick={() => setPaste(true)}>
              Explicitly use an existing securely held key for preview
            </Button>
            {paste && (
              <ExistingKeyPreview
                server={server}
                agent={agent}
                expectedProfile={
                  desired.data
                    ? { versionId: desired.data.version.id, checksum: desired.data.version.checksum }
                    : undefined
                }
                onClose={() => setPaste(false)}
              />
            )}
          </>
        ) : (
          <Alert severity="info" title="Finish selection and assignment">
            Select an active Agent and explicitly accept an OS-compatible published version before credential issuance
            or preview.
          </Alert>
        )}
      </section>
      {agent && (
        <section className={s.card}>
          <h2>5. Observe actual telemetry</h2>
          <TelemetryView telemetry={agent.telemetry} />
          <p>
            This is the last Management response for the selected Agent, not refreshed installation proof. Open
            monitoring and refresh authoritative telemetry after actual local installation.
          </p>
          <LinkButton
            href={`${appPath('monitoring')}?${new URLSearchParams({ server: server.id, agent: agent.id }).toString()}`}
          >
            View monitoring for these IDs
          </LinkButton>
        </section>
      )}
    </>
  );
}
export default function Install() {
  const selection = useSelection();
  const [create, setCreate] = useState(false);
  const admin = useAdmin();
  const s = useStyles2(getStyles);
  return (
    <>
      <h1>Install / onboarding</h1>
      <p>
        Register inventory → select Agent → assign published profile → issue once → preview actual provisioning → run a
        reviewed local installer → observe metrics. No step here claims installed/applied/Online.
      </p>
      {selection.invalid && (
        <Alert severity="error" title="Invalid selection">
          Choose authoritative records below.
        </Alert>
      )}
      <LoadState {...selection.initial} />
      <section className={s.card}>
        <h2>1. Add or select a Server</h2>
        <div className={s.row}>
          {admin && <Button onClick={() => setCreate(true)}>Add Server</Button>}
          <LinkButton variant="secondary" href={appPath('servers')}>
            Server inventory
          </LinkButton>
        </div>
        <ServerPicker value={selection.server} onChange={selection.setServer} />
      </section>
      {create && <ServerForm onClose={() => setCreate(false)} onSaved={selection.setServer} />}
      {selection.server && (
        <Onboarding
          key={selection.server.id}
          server={selection.server}
          agent={selection.agent}
          onAgent={selection.setAgent}
        />
      )}
    </>
  );
}
