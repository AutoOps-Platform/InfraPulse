import React, { useState } from 'react';
import { Button, Field, Input, useStyles2 } from '@grafana/ui';
import { api } from '../api/client';
import type { Server } from '../api/types';
import { useCursor } from '../hooks/useApi';
import { Choice, LoadState, Pager } from './Common';
import { getStyles } from '../styles';

export function ServerPicker({
  value,
  onChange,
  os,
  includeArchived = false,
}: {
  value?: Server;
  onChange: (server: Server | undefined) => void;
  os?: string;
  includeArchived?: boolean;
}) {
  const [name, setName] = useState('');
  const list = useCursor({ name, os, archive: includeArchived ? undefined : 'false' }, api.servers);
  const s = useStyles2(getStyles);
  return (
    <section className={s.card} aria-label="Select authoritative Server">
      <h3>Server selection</h3>
      <Field label="Server name prefix (literal)">
        <Input
          aria-label="Server name prefix"
          value={name}
          maxLength={128}
          onChange={(e) => setName(e.currentTarget.value)}
        />
      </Field>
      <LoadState {...list} empty={list.data?.items.length === 0}>
        <Choice
          label="Server on this page"
          value={list.data?.items.some((v) => v.id === value?.id) ? (value?.id ?? '') : ''}
          options={[
            { label: 'Choose a Server', value: '' },
            ...(list.data?.items ?? []).map((server) => ({
              label: `${server.name} · ${server.os} · ${server.onboarding.state}/${server.onboarding.stage} · ${server.id}`,
              value: server.id,
            })),
          ]}
          onChange={(id) => onChange(list.data?.items.find((server) => server.id === id))}
        />
      </LoadState>
      <Pager {...list} nextCursor={list.data?.next_cursor} />
      {value && (
        <p>
          Selected: <strong>{value.name}</strong> · {value.os} · {value.id} {value.archived_at ? '(archived)' : ''}{' '}
          <Button size="sm" variant="secondary" onClick={() => onChange(undefined)}>
            Clear Server
          </Button>
        </p>
      )}
    </section>
  );
}
