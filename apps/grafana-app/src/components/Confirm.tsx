import React, { useRef, useState } from 'react';
import { Alert, Button, Modal } from '@grafana/ui';
import { errorMessage } from '../api/client';

export function Confirm({
  title,
  warning,
  operation,
  onDone,
  onClose,
}: {
  title: string;
  warning: string;
  operation: () => Promise<unknown>;
  onDone: () => void;
  onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const lock = useRef(false);
  const submit = async () => {
    if (lock.current) {
      return;
    }
    lock.current = true;
    setPending(true);
    setError(undefined);
    try {
      await operation();
      onDone();
      onClose();
    } catch (failure: unknown) {
      setError(errorMessage(failure));
    } finally {
      lock.current = false;
      setPending(false);
    }
  };
  return (
    <Modal
      title={title}
      isOpen
      onDismiss={() => {
        if (!pending) {
          onClose();
        }
      }}
    >
      <Alert severity="warning" title="Confirm sensitive operation">
        {warning}
      </Alert>
      {error && (
        <Alert severity="error" title="Result not confirmed">
          {error} Inspect state before deciding whether to repeat this action.
        </Alert>
      )}
      <Modal.ButtonRow>
        <Button variant="secondary" disabled={pending} onClick={onClose}>
          Cancel
        </Button>
        <Button variant="destructive" disabled={pending || Boolean(error)} onClick={() => void submit()}>
          {pending ? 'Submitting…' : 'Confirm'}
        </Button>
      </Modal.ButtonRow>
    </Modal>
  );
}
