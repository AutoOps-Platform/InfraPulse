import React from 'react';
import { Alert } from '@grafana/ui';
import { ProfileBrowser } from '../components/ProfileBrowser';
import { ServerPicker } from '../components/Pickers';
import { LoadState } from '../components/Common';
import { useSelection } from '../hooks/useSelection';

export default function Profiles() {
  const selection = useSelection();
  return (
    <>
      <h1>Monitoring profiles</h1>
      <p>
        Inspect immutable published configuration and assign an exact OS-compatible version. No automatic latest
        assignment, configuration editing or unassignment is performed here.
      </p>
      {selection.invalid && (
        <Alert severity="error" title="Invalid selection">
          Select a Server from inventory.
        </Alert>
      )}
      <LoadState {...selection.initial} />
      <ServerPicker value={selection.server} onChange={selection.setServer} />
      <ProfileBrowser key={selection.server?.id ?? 'all'} server={selection.server} />
    </>
  );
}
