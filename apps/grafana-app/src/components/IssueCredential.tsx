import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Field, Input, Modal, useStyles2 } from '@grafana/ui';
import { api, ApiError, errorMessage } from '../api/client';
import type { Agent, Credential, IssueInput, IssuedCredential, Scope, Server } from '../api/types';
import { getStyles } from '../styles';
import { SecretModal } from './SecretModal';
import { Confirm } from './Confirm';
import type { ExpectedProfile } from './ProvisioningPreview';

const allScopes: Scope[] = ['metrics:write', 'provisioning:read', 'config:report'];
type Operation = { input: IssueInput; kind: 'issue' | 'rotate'; target: string };
export function IssueCredential({
  server,
  agent,
  rotate,
  provisioning = false,
  expectedProfile,
  onChanged,
}: {
  server: Server;
  agent: Agent;
  rotate?: Credential;
  provisioning?: boolean;
  expectedProfile?: ExpectedProfile;
  onChanged: () => void;
}) {
  const [scopes, setScopes] = useState<Scope[]>(allScopes);
  const [expires, setExpires] = useState('');
  const [operation, setOperation] = useState<Operation>();
  const operationRef = useRef<Operation | undefined>(undefined);
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<string>();
  const [validation, setValidation] = useState<string>();
  const [issued, setIssued] = useState<IssuedCredential>();
  const [metadata, setMetadata] = useState<Credential>();
  const [inspection, setInspection] = useState<string>();
  const [revoke, setRevoke] = useState(false);
  const [recovered, setRecovered] = useState(false);
  const [confirmedRevoked, setConfirmedRevoked] = useState(false);
  const mounted = useRef(true);
  const inspectionController = useRef<AbortController | undefined>(undefined);
  const s = useStyles2(getStyles);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operationRef.current = undefined;
      inspectionController.current?.abort();
    };
  }, []);
  const valid =
    !server.archived_at &&
    agent.lifecycle === 'active' &&
    agent.server_id === server.id &&
    (!rotate || (rotate.agent_id === agent.id && rotate.server_id === server.id));
  const prepare = () => {
    if (lock.current || operationRef.current) {
      return;
    }
    setValidation(undefined);
    if (!scopes.length) {
      setValidation('Choose at least one supported scope.');
      return;
    }
    let expiresAt: string | undefined;
    if (expires) {
      const date = new Date(expires);
      const delta = date.getTime() - Date.now();
      if (
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(expires) ||
        !Number.isFinite(delta) ||
        delta <= 0 ||
        delta > 365 * 86400000
      ) {
        setValidation('Expiration must be a future UTC RFC3339 timestamp ending Z, no more than 365 days away.');
        return;
      }
      expiresAt = date.toISOString();
    }
    if (!valid) {
      setValidation('Choose an active Agent on an unarchived Server.');
      return;
    }
    try {
      const input: IssueInput = {
        issuance_request_id: crypto.randomUUID(),
        scopes: [...scopes],
        ...(expiresAt ? { expires_at: expiresAt } : {}),
      };
      const op: Operation = { input, kind: rotate ? 'rotate' : 'issue', target: rotate?.id ?? agent.id };
      // This memory-only snapshot exists BEFORE the first network submission.
      operationRef.current = op;
      setOperation(op);
      setConfirm(true);
    } catch {
      setValidation('Secure operation UUID generation is unavailable. Use a trusted HTTPS Grafana context.');
    }
  };
  const submit = async () => {
    const op = operationRef.current;
    if (!op || lock.current) {
      return;
    }
    lock.current = true;
    setPending(true);
    setError(undefined);
    setConfirm(false);
    try {
      const result =
        op.kind === 'rotate'
          ? await api.rotateCredential(op.target, op.input)
          : await api.issueCredential(op.target, op.input);
      if (mounted.current) {
        setIssued(result);
        onChanged();
      }
    } catch (failure: unknown) {
      if (mounted.current) {
        setError(errorMessage(failure));
        if (failure instanceof ApiError && failure.code === 'secret_already_issued') {
          setMetadata(failure.credential);
        }
      }
    } finally {
      lock.current = false;
      if (mounted.current) {
        setPending(false);
      }
    }
  };
  const inspect = async () => {
    const op = operationRef.current;
    if (!op || lock.current) {
      return;
    }
    lock.current = true;
    setPending(true);
    setInspection(undefined);
    const controller = new AbortController();
    inspectionController.current = controller;
    try {
      let cursor: string | undefined;
      let found: Credential | undefined;
      let partial = true;
      for (let page = 0; page < 100; page++) {
        if (controller.signal.aborted) {
          return;
        }
        const result = await api.credentials({ agent: agent.id, limit: 100, cursor }, controller.signal);
        found = result.items.find((row) => row.issuance_request_id === op.input.issuance_request_id);
        if (found || !result.next_cursor) {
          partial = false;
          break;
        }
        cursor = result.next_cursor;
      }
      if (mounted.current) {
        setMetadata(found);
        setConfirmedRevoked(found?.status === 'revoked');
        setInspection(
          found
            ? 'Matching operation metadata found. Plaintext is not recoverable.'
            : `${partial ? 'Partial metadata scan; operation not found in scanned pages.' : 'Operation not found in this non-atomic metadata scan.'} This is not proof that issuance did not commit. Inspect Agent credential pages and revoke any inaccessible key before a new operation.`
        );
        onChanged();
      }
    } catch (failure: unknown) {
      if (mounted.current) {
        setInspection(errorMessage(failure));
      }
    } finally {
      lock.current = false;
      if (mounted.current) {
        setPending(false);
      }
    }
  };
  const canStartNew = Boolean(
    confirmedRevoked &&
      metadata &&
      operation &&
      metadata.status === 'revoked' &&
      metadata.issuance_request_id === operation.input.issuance_request_id &&
      metadata.agent_id === agent.id &&
      metadata.server_id === server.id
  );
  const reset = () => {
    operationRef.current = undefined;
    setOperation(undefined);
    setError(undefined);
    setMetadata(undefined);
    setInspection(undefined);
    setRecovered(false);
    setConfirmedRevoked(false);
  };
  return (
    <section className={s.card}>
      <h3>{rotate ? 'Rotate selected credential' : 'Issue Agent credential'}</h3>
      <p>
        Server {server.id} · Agent {agent.id}
        {rotate ? ` · old credential ${rotate.id}` : ''}
      </p>
      {rotate && (
        <Alert severity="warning" title="Rotation requires a manual Agent update">
          The predecessor remains valid only until its earlier cutoff/expiry or at most 300 seconds. Securely update the
          Agent yourself; issuing the successor does not deploy it.
        </Alert>
      )}
      <div className={s.form}>
        <fieldset disabled={pending || Boolean(operation)}>
          <legend>Credential scopes</legend>
          {allScopes.map((scope) => (
            <Checkbox
              key={scope}
              label={scope}
              checked={scopes.includes(scope)}
              onChange={(e) =>
                setScopes(e.currentTarget.checked ? [...scopes, scope] : scopes.filter((value) => value !== scope))
              }
            />
          ))}
          {provisioning && <p>Onboarding needs all three scopes: metrics, provisioning and configuration reports.</p>}
          <Field
            label="Optional expiration (UTC)"
            description="Example format: YYYY-MM-DDTHH:mm:ssZ. Default 30 days; maximum 365 days in the future."
          >
            <Input
              aria-label="Optional expiration (UTC)"
              value={expires}
              autoComplete="off"
              onChange={(e) => setExpires(e.currentTarget.value)}
            />
          </Field>
        </fieldset>
        {validation && (
          <Alert severity="error" title="Check issuance options">
            {validation}
          </Alert>
        )}
        <Button
          disabled={!valid || pending || Boolean(operation) || (provisioning && scopes.length !== 3)}
          onClick={prepare}
        >
          {pending ? 'Request in progress…' : rotate ? 'Review rotation' : 'Review issuance'}
        </Button>
      </div>
      {operation && (
        <p>
          Memory-only operation UUID: <strong>{operation.input.issuance_request_id}</strong>. Keep this identifier for
          recovery; refresh loses it. No automatic mutation retries.
        </p>
      )}
      {confirm && operation && (
        <Modal
          title={rotate ? 'Confirm credential rotation' : 'Confirm new credential issuance'}
          isOpen
          onDismiss={() => {
            setConfirm(false);
            reset();
          }}
        >
          <Alert severity="warning" title="One-time secret operation">
            Issue a new secret for this exact Agent with scopes {operation.input.scopes?.join(', ')}. Save it securely
            immediately. A lost response cannot be recovered by retrying; the same UUID can only return 409 metadata.
          </Alert>
          <p>Operation: {operation.input.issuance_request_id}</p>
          <Modal.ButtonRow>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirm(false);
                reset();
              }}
            >
              Cancel without submitting
            </Button>
            <Button disabled={pending} onClick={() => void submit()}>
              Confirm {rotate ? 'rotation' : 'issuance'}
            </Button>
          </Modal.ButtonRow>
        </Modal>
      )}
      {error && (
        <Alert severity="error" title="Issuance result uncertain or not available">
          {error}
          <p>Retain the operation UUID. Do not blindly retry or generate a new UUID to recover plaintext.</p>
          <Button variant="secondary" disabled={pending} onClick={() => void inspect()}>
            Inspect metadata for this operation
          </Button>
        </Alert>
      )}
      {inspection && (
        <Alert severity="info" title="Metadata inspection">
          {inspection}
        </Alert>
      )}
      {metadata && (
        <div className={s.card}>
          <h4>Safe credential metadata only</h4>
          <p>
            ID {metadata.id}
            <br />
            Status {metadata.status}
            <br />
            Operation {metadata.issuance_request_id}
            <br />
            Prefix {metadata.public_prefix}
          </p>
          <Button
            variant="destructive"
            disabled={pending || metadata.status === 'revoked'}
            onClick={() => setRevoke(true)}
          >
            Revoke inaccessible credential
          </Button>
        </div>
      )}
      {error && (
        <>
          <Checkbox
            label="I inspected credential metadata and revoked any inaccessible key; I deliberately authorize a new operation, not a recovery retry."
            checked={recovered}
            disabled={pending || !canStartNew}
            onChange={(e) => setRecovered(e.currentTarget.checked)}
          />
          {!canStartNew && (
            <p role="status">
              New-operation recovery is blocked until fresh Management metadata confirms this exact operation credential
              is revoked. A missing, partial or uncertain scan is not proof of revocation. Retain the operation UUID and
              ask an Admin to reconcile it; do not abandon it for a new UUID.
            </p>
          )}
          <Button
            variant="secondary"
            disabled={pending || !recovered || !canStartNew}
            onClick={() => {
              if (canStartNew && recovered && !pending) {
                reset();
              }
            }}
          >
            Start a deliberate new operation
          </Button>
        </>
      )}
      {revoke && metadata && (
        <Confirm
          title="Revoke inaccessible credential?"
          warning="Revocation is irreversible. Gateway positive cache may last up to 30 seconds, and in-flight decisions are not cancelled. After revoking, explicitly decide whether to issue a different credential."
          operation={async () => {
            await api.revokeCredential(metadata.id);
            const actual = await api.credential(metadata.id);
            if (
              actual.status !== 'revoked' ||
              actual.issuance_request_id !== operationRef.current?.input.issuance_request_id ||
              actual.agent_id !== agent.id ||
              actual.server_id !== server.id
            ) {
              throw new Error('Credential revocation metadata was not confirmed');
            }
            if (mounted.current) {
              setMetadata(actual);
              setConfirmedRevoked(true);
            }
          }}
          onDone={onChanged}
          onClose={() => setRevoke(false)}
        />
      )}
      {issued && (
        <SecretModal
          issued={issued}
          server={server}
          agent={agent}
          preview={provisioning}
          expectedProfile={expectedProfile}
          onClose={() => {
            setIssued(undefined);
            reset();
          }}
        />
      )}
    </section>
  );
}
