import React, { useState } from 'react';
import { Alert, Button, useStyles2 } from '@grafana/ui';
import { api } from '../api/client';
import type { Agent, Provisioning, PublicSettings, Server } from '../api/types';
import { useAction, useResource } from '../hooks/useApi';
import { ActionState, LoadState } from './Common';
import { getStyles } from '../styles';

export function trustedSettings(settings: PublicSettings): boolean {
  try {
    const control = new URL(settings.agentControlUrl);
    const gateway = new URL(settings.gatewayOrigin);
    return (
      control.protocol === 'https:' &&
      gateway.protocol === 'https:' &&
      !control.username &&
      !control.password &&
      !control.search &&
      !control.hash &&
      control.pathname === '/' &&
      !gateway.username &&
      !gateway.password &&
      !gateway.search &&
      !gateway.hash &&
      gateway.pathname === '/'
    );
  } catch {
    return false;
  }
}
function Instructions({ server, settings }: { server: Server; settings: PublicSettings }) {
  const s = useStyles2(getStyles);
  // Values are operator-configured public HTTPS URLs. Shell escaping is still required.
  const sh = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  const ps = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const command =
    server.os === 'linux'
      ? `sudo bash ./install.sh --management-url ${sh(settings.agentControlUrl)} --gateway-origin ${sh(settings.gatewayOrigin)} --telegraf-binary /trusted/path/telegraf --telegraf-sha256 '<INDEPENDENTLY_VERIFIED_BINARY_SHA256>'`
      : `.\\install.ps1 -ManagementUrl ${ps(settings.agentControlUrl)} -GatewayOrigin ${ps(settings.gatewayOrigin)} -TelegrafBinary 'C:\\trusted\\telegraf.exe' -TelegrafSha256 '<INDEPENDENTLY_VERIFIED_BINARY_SHA256>' -PromptKey`;
  return (
    <>
      <h3>Reviewed local installation</h3>
      <Alert severity="warning" title="Template is NOT ready to run">
        Replace the trusted local binary path and independently verified SHA256 placeholder. Independently distribute
        and review the installer bundle and official Telegraf 1.38.2. No download endpoint or pipe-to-shell is implied.
      </Alert>
      <p>
        Requires Python 3.11+ and {server.os === 'linux' ? 'root with systemd' : 'Windows Administrator privileges'}.
        The installer prompts for the key without putting it on the command line. Enter it only in that hidden prompt.
      </p>
      <pre className={s.code}>{command}</pre>
      <p>
        {server.os === 'linux'
          ? 'For a private CA, use --management-ca /trusted/path/management-ca.pem and/or --gateway-ca /trusted/path/gateway-ca.pem.'
          : "For a private CA, use -ManagementCa 'C:\\trusted\\management-ca.pem' and/or -GatewayCa 'C:\\trusted\\gateway-ca.pem'."}{' '}
        Verify CA trust and the same pinned configured origins; never disable TLS verification or use
        insecureSkipVerify. Keep the credential out of scripts, shell history and arguments.
      </p>
    </>
  );
}
export type ExpectedProfile = { versionId: string; checksum: string };
export function ProvisioningPreview({
  server,
  agent,
  getKey,
  clearKey,
  expectedProfile,
}: {
  server: Server;
  agent: Agent;
  getKey: () => string;
  clearKey?: () => void;
  expectedProfile?: ExpectedProfile;
}) {
  const settings = useResource('public-settings', api.settings);
  const [preview, setPreview] = useState<Provisioning>();
  const [invalid, setInvalid] = useState(false);
  const [profileConflict, setProfileConflict] = useState<{ versionId: string; checksum: string }>();
  const action = useAction();
  const s = useStyles2(getStyles);
  const validSettings = Boolean(settings.data && trustedSettings(settings.data));
  const fetchPreview = () => {
    if (profileConflict) {
      return;
    }
    setPreview(undefined);
    setInvalid(false);
    const key = getKey();
    if (!key) {
      setInvalid(true);
      return;
    }
    void action.run(
      async () => {
        try {
          const result = await api.provisioning(key, server.id, agent.id);
          const expected = settings.data;
          if (
            !expected ||
            !trustedSettings(expected) ||
            result.server_id !== server.id ||
            result.agent_id !== agent.id ||
            result.os !== server.os ||
            result.profile.config.os !== server.os ||
            result.ingestion.identity_headers['X-Server-ID'] !== server.id ||
            result.ingestion.identity_headers['X-Agent-ID'] !== agent.id ||
            new URL(result.ingestion.base_url).origin !== new URL(expected.gatewayOrigin).origin ||
            result.ingestion.base_url !== expected.gatewayOrigin
          ) {
            throw new Error('Untrusted provisioning selection or origin');
          }
          return result;
        } finally {
          clearKey?.();
        }
      },
      (result) => {
        if (
          expectedProfile &&
          (result.profile.version_id !== expectedProfile.versionId ||
            result.profile.checksum !== expectedProfile.checksum)
        ) {
          setProfileConflict({ versionId: result.profile.version_id, checksum: result.profile.checksum });
          return;
        }
        setPreview(result);
      }
    );
  };
  return (
    <section>
      <h3>Provisioning receipt preview</h3>
      <LoadState {...settings}>
        {settings.data &&
          (validSettings ? (
            <p>
              Management control: {settings.data.agentControlUrl}
              <br />
              Pinned Gateway origin: {settings.data.gatewayOrigin}
            </p>
          ) : (
            <Alert severity="error" title="Public settings are not trusted HTTPS origins">
              Ask the operator to fix plugin settings. There is no insecure fallback.
            </Alert>
          ))}
      </LoadState>
      <p>
        This deliberately calls the actual Agent provisioning endpoint through the adapter. It records a receipt, not
        installed, applied, running or Online. A 409 does not produce a substitute preview.
      </p>
      <Button
        variant="secondary"
        disabled={!validSettings || action.pending || Boolean(profileConflict)}
        onClick={fetchPreview}
      >
        {action.pending ? 'Fetching…' : 'Fetch actual provisioning preview'}
      </Button>
      {invalid && (
        <Alert severity="warning" title="A key is required">
          No old secret can be retrieved. Explicitly enter an existing key or issue a new one.
        </Alert>
      )}
      <ActionState {...action} />
      {profileConflict && (
        <Alert severity="error" title="Desired profile changed after your review">
          Actual provisioning returned version {profileConflict.versionId} with checksum {profileConflict.checksum},
          which differs from your accepted version/checksum. No installer instructions are shown. Save the one-time key
          securely, close this dialog, refresh desired assignment and explicitly review/accept it again; then use the
          existing-key password preview. Do not issue another key or blindly retry to resolve this conflict.
        </Alert>
      )}
      {preview && (
        <>
          <dl>
            <dt>Server / Agent</dt>
            <dd>
              {preview.server_id} / {preview.agent_id}
            </dd>
            <dt>Published profile / exact version</dt>
            <dd>
              {preview.profile.id} / {preview.profile.version_id} (v{preview.profile.version})
            </dd>
            <dt>Checksum</dt>
            <dd>{preview.profile.checksum}</dd>
            <dt>Actual ingestion destination</dt>
            <dd>
              {preview.ingestion.base_url}
              {preview.ingestion.path}
            </dd>
          </dl>
          <pre className={s.code}>{JSON.stringify(preview.profile.config, null, 2)}</pre>
          {settings.data && <Instructions server={server} settings={settings.data} />}
        </>
      )}
    </section>
  );
}
