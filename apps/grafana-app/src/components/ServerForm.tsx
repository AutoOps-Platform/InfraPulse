import React, { useState } from 'react';
import { Alert, Button, Field, Input, Modal, TextArea, useStyles2 } from '@grafana/ui';
import { api } from '../api/client';
import type { Os, Server, ServerInput } from '../api/types';
import { useAction } from '../hooks/useApi';
import { ActionState, Choice } from './Common';
import { getStyles } from '../styles';

const controls = /[\u0000-\u001f\u007f]/u;
const reserved = new Set(['password', 'secret', 'token', 'api_key', 'authorization']);
export function parseMetadata(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Metadata must be a JSON object.');
  }
  const visit = (item: unknown, depth: number): boolean => {
    if (depth > 4) {
      return false;
    }
    if (item === null || typeof item === 'boolean') {
      return true;
    }
    if (typeof item === 'number') {
      return Number.isFinite(item);
    }
    if (typeof item === 'string') {
      return item.length <= 512 && !controls.test(item);
    }
    if (Array.isArray(item)) {
      return item.every((child) => visit(child, depth + 1));
    }
    if (typeof item !== 'object') {
      return false;
    }
    return Object.entries(item).every(
      ([key, child]) =>
        key.length > 0 &&
        key.length <= 64 &&
        !controls.test(key) &&
        !reserved.has(key.toLowerCase()) &&
        visit(child, depth + 1)
    );
  };
  if (new TextEncoder().encode(JSON.stringify(value)).length > 4096 || !visit(value, 1)) {
    throw new Error(
      'Metadata must be non-secret, ≤4 KiB UTF-8, depth ≤4, strings ≤512 and keys ≤64 characters; credential field names and control characters are forbidden.'
    );
  }
  return value as Record<string, unknown>;
}
export function ServerForm({
  server,
  onClose,
  onSaved,
}: {
  server?: Server;
  onClose: () => void;
  onSaved: (server: Server) => void;
}) {
  const [name, setName] = useState(server?.name ?? '');
  const [environment, setEnvironment] = useState(server?.environment ?? '');
  const [os, setOs] = useState<Os>(server?.os ?? 'linux');
  const [metadata, setMetadata] = useState(JSON.stringify(server?.metadata ?? {}, null, 2));
  const [validation, setValidation] = useState<string>();
  const action = useAction();
  const s = useStyles2(getStyles);
  const submit = (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (action.pending || action.error) {
      return;
    }
    setValidation(undefined);
    let input: ServerInput;
    try {
      if (
        !name.length ||
        name.length > 128 ||
        controls.test(name) ||
        !environment.length ||
        environment.length > 64 ||
        controls.test(environment)
      ) {
        throw new Error('Name must be 1–128 characters and environment 1–64, without control characters.');
      }
      input = { name, os, environment, metadata: parseMetadata(metadata) };
    } catch (failure: unknown) {
      setValidation(
        failure instanceof SyntaxError
          ? 'Metadata must be valid JSON.'
          : failure instanceof Error
            ? failure.message
            : 'Invalid fields.'
      );
      return;
    }
    void action.run(
      () => (server ? api.updateServer(server.id, input) : api.createServer(input)),
      (saved) => {
        onSaved(saved);
        onClose();
      }
    );
  };
  return (
    <Modal
      title={server ? 'Edit Server' : 'Add Server'}
      isOpen
      onDismiss={() => {
        if (!action.pending) {
          onClose();
        }
      }}
    >
      <form className={s.form} onSubmit={submit}>
        <Field label="Server name" required>
          <Input
            aria-label="Server name"
            value={name}
            required
            maxLength={128}
            onChange={(e) => setName(e.currentTarget.value)}
          />
        </Field>
        <Field label="Environment" required>
          <Input
            aria-label="Environment"
            value={environment}
            required
            maxLength={64}
            onChange={(e) => setEnvironment(e.currentTarget.value)}
          />
        </Field>
        <Choice
          label="Operating system"
          value={os}
          options={[
            { label: 'Linux', value: 'linux' },
            { label: 'Windows', value: 'windows' },
          ]}
          onChange={(value) => setOs(value as Os)}
        />
        <Field label="Non-secret metadata JSON" description="Object ≤4 KiB; never enter passwords, tokens or API keys.">
          <TextArea
            aria-label="Non-secret metadata JSON"
            value={metadata}
            rows={8}
            onChange={(e) => setMetadata(e.currentTarget.value)}
          />
        </Field>
        {server && (
          <Alert severity="info" title="OS changes are constrained">
            Management rejects incompatible assignments or an active Agent with 409. Refresh current state after a
            conflict.
          </Alert>
        )}
        {validation && (
          <Alert severity="error" title="Check form">
            {validation}
          </Alert>
        )}
        <ActionState {...action} />
        <Modal.ButtonRow>
          <Button type="button" variant="secondary" disabled={action.pending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={action.pending || Boolean(action.error)}>
            {action.pending ? 'Saving…' : 'Save Server'}
          </Button>
        </Modal.ButtonRow>
        {action.error && (
          <p>Inspect the Server inventory before reopening this form; this request is never automatically retried.</p>
        )}
      </form>
    </Modal>
  );
}
