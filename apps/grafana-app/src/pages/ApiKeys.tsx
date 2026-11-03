import React, { useState } from 'react';
import { Alert, Button, useStyles2 } from '@grafana/ui';
import { api } from '../api/client';
import type { Credential } from '../api/types';
import { useCursor } from '../hooks/useApi';
import { useSelection } from '../hooks/useSelection';
import { LoadState, Pager, Table, time, useAdmin } from '../components/Common';
import { AgentPicker, ServerPicker } from '../components/Pickers';
import { IssueCredential } from '../components/IssueCredential';
import { Confirm } from '../components/Confirm';
import { getStyles } from '../styles';

function CredentialManagement() {
  const selection = useSelection();
  const [rotate, setRotate] = useState<Credential>();
  const [revoke, setRevoke] = useState<Credential>();
  const s = useStyles2(getStyles);
  const list = useCursor({ server: selection.server?.id, agent: selection.agent?.id }, api.credentials);
  const selectedRotation =
    rotate && rotate.agent_id === selection.agent?.id && rotate.server_id === selection.server?.id ? rotate : undefined;
  return (
    <>
      <p>
        Admin-only metadata and reveal-once issuance. Backend RBAC is authoritative; the /me role is only a UI hint.
      </p>
      {selection.invalid && (
        <Alert severity="error" title="Invalid selection">
          Choose actual inventory records below.
        </Alert>
      )}
      <LoadState {...selection.initial} />
      <ServerPicker
        value={selection.server}
        includeArchived
        onChange={(server) => {
          selection.setServer(server);
          setRotate(undefined);
        }}
      />
      {selection.server && (
        <AgentPicker
          key={selection.server.id}
          server={selection.server}
          value={selection.agent}
          onChange={(agent) => {
            selection.setAgent(agent);
            setRotate(undefined);
          }}
        />
      )}
      <div className={s.row}>
        <Button variant="secondary" onClick={list.retry} disabled={list.loading}>
          Refresh credential metadata
        </Button>
        {selectedRotation && (
          <Button variant="secondary" onClick={() => setRotate(undefined)}>
            Cancel rotation selection
          </Button>
        )}
      </div>
      <LoadState {...list} empty={list.data?.items.length === 0}>
        <Table
          caption="Safe credential metadata — no plaintext recovery"
          headings={[
            'Credential / prefix',
            'Server / Agent',
            'Status / deadlines',
            'Scopes',
            'Operation / rotation',
            'Actions',
          ]}
        >
          {list.data?.items.map((row) => (
            <tr key={row.id}>
              <td>
                {row.id}
                <br />
                {row.public_prefix}
              </td>
              <td>
                {row.server_id}
                <br />
                {row.agent_id}
              </td>
              <td>
                {row.status}
                <br />
                Expires {time(row.expires_at)}
                <br />
                Retires {time(row.retire_at)}
                <br />
                Revoked {time(row.revoked_at)}
              </td>
              <td>{row.scopes.join(', ')}</td>
              <td>
                {row.issuance_request_id}
                <br />
                Predecessor {row.rotated_from_id ?? 'None'}
              </td>
              <td>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={
                    !selection.server ||
                    !selection.agent ||
                    row.agent_id !== selection.agent.id ||
                    row.server_id !== selection.server.id ||
                    row.status === 'revoked' ||
                    row.status === 'expired' ||
                    row.status === 'inactive'
                  }
                  onClick={() => setRotate(row)}
                >
                  Select rotation
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={row.status === 'revoked'}
                  onClick={() => setRevoke(row)}
                >
                  Revoke
                </Button>
              </td>
            </tr>
          ))}
        </Table>
      </LoadState>
      <Pager {...list} nextCursor={list.data?.next_cursor} />
      <p>
        Select the matching Server and Agent to issue or rotate. Rotation selection never automatically issues or
        updates an Agent.
      </p>
      {selection.server && selection.agent && (
        <IssueCredential
          key={`${selection.server.id}:${selection.agent.id}:${selectedRotation?.id ?? 'issue'}`}
          server={selection.server}
          agent={selection.agent}
          rotate={selectedRotation}
          onChanged={list.retry}
        />
      )}
      {revoke && (
        <Confirm
          title="Revoke Agent credential permanently?"
          warning={`Credential ${revoke.id} will not be usable again. Gateway positive authentication cache can last up to 30 seconds; in-flight decisions are not cancelled. This does not remove stored metrics.`}
          operation={() => api.revokeCredential(revoke.id)}
          onDone={list.retry}
          onClose={() => setRevoke(undefined)}
        />
      )}
    </>
  );
}
export default function ApiKeys() {
  const admin = useAdmin();
  return (
    <>
      <h1>API keys</h1>
      {admin ? (
        <CredentialManagement />
      ) : (
        <Alert severity="warning" title="Admin required">
          Credential metadata, issuance, rotation and revocation are restricted to backend-verified Admin users. No
          credential requests are made by this page for other roles.
        </Alert>
      )}
    </>
  );
}
