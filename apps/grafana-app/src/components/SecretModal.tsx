import React, { useRef, useState } from 'react';
import { Alert, Button, Field, Input, Modal } from '@grafana/ui';
import type { Agent, IssuedCredential, Server } from '../api/types';
import { ProvisioningPreview, type ExpectedProfile } from './ProvisioningPreview';

export function SecretModal({
  issued,
  server,
  agent,
  onClose,
  preview = false,
  expectedProfile,
}: {
  issued: IssuedCredential;
  server: Server;
  agent: Agent;
  onClose: () => void;
  preview?: boolean;
  expectedProfile?: ExpectedProfile;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const copy = async () => {
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(issued.api_key);
      setCopied(true);
    } catch {
      setCopyError(true);
    }
  };
  return (
    <Modal title="One-time Agent API key" isOpen onDismiss={onClose}>
      <Alert severity="warning" title="Save securely now — shown once">
        Closing, navigating away or refreshing clears this UI reference. Management cannot retrieve this secret. Do not
        screenshot, paste it into commands, URLs, logs or tickets. Clipboard contents may be accessible to other
        applications; clear your clipboard after securely transferring it.
      </Alert>
      <p>
        Credential ID: {issued.id}
        <br />
        Operation ID: {issued.issuance_request_id}
        <br />
        Server: {server.id}
        <br />
        Agent: {agent.id}
      </p>
      <Field label="One-time API key">
        <Input
          aria-label="One-time API key"
          type="password"
          autoComplete="off"
          readOnly
          value={issued.api_key}
          spellCheck={false}
        />
      </Field>
      <Button variant="secondary" onClick={() => void copy()}>
        Copy key explicitly
      </Button>
      {copied && <p role="status">Copied on your request. Clear clipboard when finished.</p>}
      {copyError && (
        <p role="alert">
          Clipboard access was denied. Transfer securely from the key field; do not place it in commands.
        </p>
      )}
      {preview && (
        <ProvisioningPreview
          server={server}
          agent={agent}
          expectedProfile={expectedProfile}
          getKey={() => issued.api_key}
        />
      )}
      <Modal.ButtonRow>
        <Button onClick={onClose}>I have saved the key securely — close</Button>
      </Modal.ButtonRow>
    </Modal>
  );
}

export function ExistingKeyPreview({
  server,
  agent,
  onClose,
  expectedProfile,
}: {
  server: Server;
  agent: Agent;
  onClose: () => void;
  expectedProfile?: ExpectedProfile;
}) {
  const input = useRef<HTMLInputElement>(null);
  const clear = () => {
    if (input.current) {
      input.current.value = '';
    }
  };
  const close = () => {
    clear();
    onClose();
  };
  return (
    <Modal title="Preview using an existing Agent key" isOpen onDismiss={close}>
      <Alert severity="warning" title="Explicit transient key entry">
        Management cannot retrieve an old key. Paste only if you choose to use a securely held existing key. This
        password input is cleared after each preview attempt and when closed; never put the key in a URL or command.
      </Alert>
      <Field label="Existing Agent key (ephemeral)">
        <Input
          ref={input}
          aria-label="Existing Agent key (ephemeral)"
          type="password"
          autoComplete="off"
          spellCheck={false}
          maxLength={8192}
        />
      </Field>
      <ProvisioningPreview
        server={server}
        agent={agent}
        expectedProfile={expectedProfile}
        getKey={() => input.current?.value ?? ''}
        clearKey={clear}
      />
      <Modal.ButtonRow>
        <Button onClick={close}>Clear and close</Button>
      </Modal.ButtonRow>
    </Modal>
  );
}
