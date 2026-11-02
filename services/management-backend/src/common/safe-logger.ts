import type { ApiCode } from './errors.js';

export type SafeEvent = 'startup_failed' | 'startup_ready' | 'request_failed';
export interface SafeFields {
  readonly code?: ApiCode;
  readonly request_id?: string;
  readonly status?: number;
}
const eventNames = new Set<string>([
  'startup_failed',
  'startup_ready',
  'request_failed',
]);
const codes = new Set<string>([
  'invalid_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'payload_too_large',
  'rate_limited',
  'dependency_unavailable',
  'audit_unavailable',
  'internal_error',
  'provisioning_not_ready',
  'profile_not_provisioned',
  'secret_already_issued',
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Project known fields before serialization; arbitrary objects never reach the sink.
export class SafeLogger {
  constructor(
    private readonly sink: (line: string) => void = (line) => {
      process.stdout.write(`${line}\n`);
    },
  ) {}
  event(event: SafeEvent, fields: SafeFields = {}): void {
    if (!eventNames.has(event)) return;
    const output: Record<string, string | number> = { event };
    if (typeof fields.code === 'string' && codes.has(fields.code))
      output.code = fields.code;
    if (typeof fields.request_id === 'string' && uuid.test(fields.request_id))
      output.request_id = fields.request_id;
    if (
      typeof fields.status === 'number' &&
      Number.isInteger(fields.status) &&
      fields.status >= 100 &&
      fields.status <= 599
    )
      output.status = fields.status;
    this.sink(JSON.stringify(output));
  }
}
