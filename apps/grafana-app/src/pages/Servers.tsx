import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, Button, Field, Input, LinkButton, useStyles2 } from '@grafana/ui';
import { api } from '../api/client';
import type { Server } from '../api/types';
import { fleetHref, selectedVm, vmsHref } from '../api/vm-routes';
import { VmOnboarding } from './Install';
import { useCursor, useResource } from '../hooks/useApi';
import { Choice, LoadState, osOptions, Pager, Table, time, useAdmin } from '../components/Common';
import { ServerForm } from '../components/ServerForm';
import { Confirm } from '../components/Confirm';
import { OnboardingStatus } from '../components/OnboardingStatus';
import { getStyles } from '../styles';

export function ServerDetail({ id, onChanged }: { id: string; onChanged?: () => void }) {
  const detail = useResource(`inventory-server:${id}`, (signal) => api.inventoryServer(id, signal));
  const [edit, setEdit] = useState(false);
  const [archive, setArchive] = useState(false);
  const admin = useAdmin();
  const s = useStyles2(getStyles);
  const refresh = () => { detail.retry(); onChanged?.(); };
  return <section className={s.card}>
    <LinkButton href={vmsHref()} variant="secondary">Back to VMs</LinkButton>
    <LoadState {...detail}>
      {detail.data && <>
        <h1>{detail.data.name}</h1>
        <dl>
          <dt>Authoritative Server ID</dt><dd>{detail.data.id}</dd>
          <dt>OS / Environment</dt><dd>{detail.data.os} / {detail.data.environment}</dd>
          <dt>Archived</dt><dd>{detail.data.archived_at ? time(detail.data.archived_at) : 'No'}</dd>
          <dt>Updated</dt><dd>{time(detail.data.updated_at)}</dd>
        </dl>
        <div className={s.row}>
          {admin && !detail.data.archived_at && <Button variant="secondary" onClick={() => setEdit(true)}>Edit VM</Button>}
        </div>
      </>}
    </LoadState>
    <VmOnboarding server={detail.data} refreshInventory={detail.retry} />
    {detail.data && <>
        <details>
          <summary>Inventory metadata</summary>
          <pre className={s.code}>{JSON.stringify(detail.data.metadata, null, 2)}</pre>
        </details>
        {edit && admin && <ServerForm server={detail.data} onClose={() => setEdit(false)} onSaved={refresh} />}
        {admin && !detail.data.archived_at && <details>
          <summary>Advanced inventory actions</summary>
          <Button variant="destructive" onClick={() => setArchive(true)}>Archive VM</Button>
        </details>}
        {archive && admin && <Confirm
          title="Archive VM permanently?"
          warning="Archive is not AWS decommission. Management rejects unresolved AWS ownership, including CleanupRequired. Finish decommission and inspect its persisted receipt first. Inventory, lifecycle history and audit remain; there is no restore UI."
          operation={() => api.archiveServer(id)} onDone={refresh} onClose={() => setArchive(false)}
        />}
    </>}
  </section>;
}
export default function Servers() {
  const [params, setParams] = useSearchParams();
  const selected = selectedVm(params.toString());
  const [name, setName] = useState('');
  const [os, setOs] = useState('');
  const [environment, setEnvironment] = useState('');
  const [archive, setArchive] = useState('false');
  const [create, setCreate] = useState(false);
  const admin = useAdmin();
  const s = useStyles2(getStyles);
  const list = useCursor({ name, os, environment, archive }, api.servers, !selected);
  const select = (server: Server) => setParams({ server: server.id });
  const fleet = fleetHref();
  if (selected) return <ServerDetail key={selected} id={selected} onChanged={list.retry} />;
  return <>
    <h1>VMs</h1>
    <p>Manage VM inventory and onboarding. Open a VM to view its current setup progress.</p>
    {fleet && <LinkButton variant="secondary" href={fleet}>Fleet dashboard</LinkButton>}
    {params.has('server') && <Alert severity="error" title="Invalid VM selection">Choose a VM from inventory.</Alert>}
    <div className={s.row}>
      <Field label="Name prefix"><Input aria-label="Name prefix" value={name} maxLength={128} onChange={(e) => setName(e.currentTarget.value)} /></Field>
      <Choice label="OS filter" value={os} options={osOptions} onChange={setOs} />
      <Field label="Exact environment"><Input aria-label="Exact environment" value={environment} maxLength={64} onChange={(e) => setEnvironment(e.currentTarget.value)} /></Field>
      <Choice label="Archive filter" value={archive} options={[{ label: 'Unarchived', value: 'false' }, { label: 'Archived', value: 'true' }, { label: 'All', value: '' }]} onChange={setArchive} />
      <Button variant="secondary" onClick={list.retry} disabled={list.loading}>Refresh</Button>
      {admin && <Button onClick={() => setCreate(true)}>Add VM</Button>}
    </div>
    <LoadState {...list} empty={list.data?.items.length === 0}>
      <Table caption="AWS Server inventory — onboarding, metrics and alert sync are independent" headings={['Name', 'Server ID', 'OS / environment', 'Onboarding / health / alert sync', 'Archived', 'Detail']}>
        {list.data?.items.map((server) => <tr key={server.id}>
          <td>{server.name}</td><td>{server.id}</td><td>{server.os} / {server.environment}</td>
          <td><OnboardingStatus progress={server.onboarding} compact /></td>
          <td>{server.archived_at ? 'Yes' : 'No'}</td>
          <td><Button variant="secondary" size="sm" onClick={() => select(server)}>Open detail</Button></td>
        </tr>)}
      </Table>
    </LoadState>
    <Pager {...list} nextCursor={list.data?.next_cursor} />
    {create && admin && <ServerForm onClose={() => setCreate(false)} onSaved={(server) => { list.retry(); select(server); }} />}
  </>;
}
