import React, { createContext, useContext } from 'react';
import { Alert, Button, Field, Combobox, Spinner, useStyles2 } from '@grafana/ui';
import type { Principal, Telemetry } from '../api/types';
import { getStyles } from '../styles';

export const PrincipalContext = createContext<Principal | undefined>(undefined);
export const useAdmin = () => useContext(PrincipalContext)?.role === 'Admin';
export const time = (value: string | null | undefined) => (value ? new Date(value).toISOString() : 'Not reported');
export function Choice({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: Array<{ label: string; value: string }>;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <Field label={label}>
      <Combobox
        aria-label={label}
        value={value}
        options={options}
        onChange={(v) => onChange(v.value ?? '')}
        disabled={disabled}
        width={30}
      />
    </Field>
  );
}
export const osOptions = [
  { label: 'All operating systems', value: '' },
  { label: 'Linux', value: 'linux' },
  { label: 'Windows', value: 'windows' },
];
export function LoadState({
  loading,
  error,
  retry,
  empty,
  children,
}: React.PropsWithChildren<{ loading: boolean; error?: string; retry: () => void; empty?: boolean }>) {
  if (loading) {
    return (
      <div role="status">
        <Spinner /> Loading Management data…
      </div>
    );
  }
  if (error) {
    return (
      <Alert severity="error" title="Management request failed">
        <p>{error}</p>
        <Button variant="secondary" onClick={retry}>
          Retry read
        </Button>
      </Alert>
    );
  }
  if (empty) {
    return (
      <Alert severity="info" title="No matching records">
        Try changing the filters, or create a resource if your role permits.
      </Alert>
    );
  }
  return <>{children}</>;
}
export function ActionState({ error, notice }: { error?: string; notice?: string }) {
  return (
    <>
      {error && (
        <Alert severity="error" title="Action was not confirmed">
          {error}
        </Alert>
      )}
      {notice && (
        <Alert severity="success" title="Management response received">
          {notice}
        </Alert>
      )}
    </>
  );
}
export function Pager({
  page,
  loading,
  nextCursor,
  previous,
  next,
}: {
  page: number;
  loading: boolean;
  nextCursor?: string | null;
  previous: () => void;
  next: () => void;
}) {
  const s = useStyles2(getStyles);
  return (
    <div className={s.row} aria-label="Pagination">
      <Button variant="secondary" disabled={loading || page <= 1} onClick={previous}>
        Previous
      </Button>
      <span>Page {page}</span>
      <Button variant="secondary" disabled={loading || !nextCursor} onClick={next}>
        Next
      </Button>
    </div>
  );
}
export function TelemetryView({ telemetry }: { telemetry: Telemetry }) {
  const s = useStyles2(getStyles);
  return (
    <div className={s.card}>
      <strong>{telemetry.status}</strong>
      <dl>
        <dt>Source health</dt>
        <dd>{telemetry.source_health}</dd>
        <dt>Evidence as of</dt>
        <dd>{time(telemetry.status_as_of)}</dd>
        <dt>Last metric receipt</dt>
        <dd>{time(telemetry.last_metric_seen_at)}</dd>
        <dt>Confidence</dt>
        <dd>{telemetry.confidence_reason}</dd>
      </dl>
      <p className={s.muted}>Observation only. Lifecycle is not Online; Offline is not a machine power-state claim.</p>
    </div>
  );
}
export function Table({
  caption,
  headings,
  children,
}: React.PropsWithChildren<{ caption: string; headings: string[] }>) {
  const s = useStyles2(getStyles);
  return (
    <div className={s.table}>
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            {headings.map((heading) => (
              <th scope="col" key={heading}>
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
