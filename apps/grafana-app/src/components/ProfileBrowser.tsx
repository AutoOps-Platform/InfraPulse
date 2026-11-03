import React, { useState } from 'react';
import { Alert, Button, useStyles2 } from '@grafana/ui';
import { api } from '../api/client';
import type { Profile, ProfileVersion, Server } from '../api/types';
import { useCursor } from '../hooks/useApi';
import { Choice, LoadState, osOptions, Pager, Table, time, useAdmin } from './Common';
import { Confirm } from './Confirm';
import { getStyles } from '../styles';

function Versions({
  profile,
  server,
  onAssigned,
}: {
  profile: Profile;
  server?: Server;
  onAssigned?: (version: ProfileVersion) => void;
}) {
  const versions = useCursor({ status: 'published' }, (filters, signal) => api.versions(profile.id, filters, signal));
  const [selected, setSelected] = useState<ProfileVersion>();
  const [confirm, setConfirm] = useState(false);
  const [assigned, setAssigned] = useState<string>();
  const admin = useAdmin();
  const s = useStyles2(getStyles);
  const compatible = Boolean(
    server &&
      !server.archived_at &&
      server.os === profile.os &&
      !profile.retired_at &&
      selected?.status === 'published' &&
      selected.config.os === server.os
  );
  return (
    <section className={s.card}>
      <h3>{profile.name} · published versions</h3>
      <p>{profile.description}</p>
      <LoadState {...versions} empty={versions.data?.items.length === 0}>
        <Table
          caption="Paginated immutable published history (no latest-version guessing)"
          headings={['Version', 'Version ID', 'Published', 'Inspect']}
        >
          {versions.data?.items.map((version) => (
            <tr key={version.id}>
              <td>{version.version}</td>
              <td>{version.id}</td>
              <td>{time(version.published_at)}</td>
              <td>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setSelected(version);
                    setAssigned(undefined);
                  }}
                >
                  Inspect exact version
                </Button>
              </td>
            </tr>
          ))}
        </Table>
      </LoadState>
      <Pager {...versions} nextCursor={versions.data?.next_cursor} />
      {selected && (
        <>
          <h4>Read-only published configuration v{selected.version}</h4>
          <p>Version UUID: {selected.id}</p>
          <p>Canonical config checksum: {selected.checksum}</p>
          <pre className={s.code}>{JSON.stringify(selected.config, null, 2)}</pre>
          {server && (
            <p>
              Target: {server.name} · {server.id} · authoritative OS {server.os}
            </p>
          )}
          {admin ? (
            <Button disabled={!compatible} onClick={() => setConfirm(true)}>
              Assign this exact published version
            </Button>
          ) : (
            <p>Admin is required for assignment; backend enforces RBAC.</p>
          )}
          {!server && <p>Select an unarchived Server to assign this version.</p>}
          {server && !compatible && (
            <Alert severity="warning" title="Assignment unavailable">
              Choose an unarchived Server with the same OS as the nonretired profile.
            </Alert>
          )}
          {assigned && (
            <Alert severity="success" title="Desired assignment saved">
              {assigned}. This does not mean provisioned, applied or Online.
            </Alert>
          )}
          {confirm && server && (
            <Confirm
              title="Change desired monitoring profile?"
              warning={`Assign immutable version ${selected.id} (v${selected.version}) to Server ${server.id}. Existing reported applied configuration is separate.`}
              operation={() => api.assignProfile(server.id, selected.id)}
              onDone={() => {
                setAssigned(selected.id);
                onAssigned?.(selected);
              }}
              onClose={() => setConfirm(false)}
            />
          )}
        </>
      )}
    </section>
  );
}
export function ProfileBrowser({
  server,
  onAssigned,
}: {
  server?: Server;
  onAssigned?: (version: ProfileVersion) => void;
}) {
  const [os, setOs] = useState('');
  const [selected, setSelected] = useState<Profile>();
  const s = useStyles2(getStyles);
  const effectiveOs = server?.os ?? os;
  const profiles = useCursor({ os: effectiveOs, retired: 'false', status: 'published' }, api.profiles);
  // Selection is scoped to the authoritative server OS and current filter.
  const visibleProfile = selected && (!effectiveOs || selected.os === effectiveOs) ? selected : undefined;
  return (
    <>
      <div className={s.row}>
        {server ? (
          <p>
            Compatible profiles for Server OS: <strong>{server.os}</strong>
          </p>
        ) : (
          <Choice
            label="Profile OS filter"
            value={os}
            options={osOptions}
            onChange={(value) => {
              setOs(value);
              setSelected(undefined);
            }}
          />
        )}
        <Button variant="secondary" disabled={profiles.loading} onClick={profiles.retry}>
          Refresh profiles
        </Button>
      </div>
      <LoadState {...profiles} empty={profiles.data?.items.length === 0}>
        <Table
          caption="Nonretired profiles with published versions"
          headings={['Profile', 'OS', 'Profile ID', 'Versions']}
        >
          {profiles.data?.items.map((profile) => (
            <tr key={profile.id}>
              <td>
                {profile.name}
                <br />
                {profile.slug}
              </td>
              <td>{profile.os}</td>
              <td>{profile.id}</td>
              <td>
                <Button size="sm" variant="secondary" onClick={() => setSelected(profile)}>
                  Browse versions
                </Button>
              </td>
            </tr>
          ))}
        </Table>
      </LoadState>
      <Pager {...profiles} nextCursor={profiles.data?.next_cursor} />
      {visibleProfile && (
        <Versions
          key={`${visibleProfile.id}:${server?.id ?? ''}`}
          profile={visibleProfile}
          server={server}
          onAssigned={onAssigned}
        />
      )}
    </>
  );
}
