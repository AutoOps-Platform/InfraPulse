const ERROR_DEFINITIONS = {
  invalid_request: [400, 'Invalid request.'],
  unauthorized: [401, 'Unauthorized.'],
  forbidden: [403, 'Forbidden.'],
  not_found: [404, 'Resource not found.'],
  conflict: [409, 'Resource conflict.'],
  payload_too_large: [413, 'Payload too large.'],
  rate_limited: [429, 'Request limit exceeded.'],
  dependency_unavailable: [503, 'Dependency unavailable.'],
  audit_unavailable: [503, 'Audit unavailable.'],
  internal_error: [500, 'Internal error.'],
  provisioning_not_ready: [409, 'Provisioning not ready.'],
  profile_not_provisioned: [409, 'Profile not provisioned.'],
  secret_already_issued: [409, 'Secret already issued.'],
} as const;

export type ApiCode = keyof typeof ERROR_DEFINITIONS;

export class ApiError extends Error {
  readonly status: number;

  constructor(readonly code: ApiCode) {
    super(ERROR_DEFINITIONS[code][1]);
    this.name = 'ApiError';
    this.status = ERROR_DEFINITIONS[code][0];
  }
}

export interface Clock {
  now(): Date;
  nowMs(): number;
  monotonicMs(): number;
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowMs: () => Date.now(),
  monotonicMs: () => performance.now(),
};

export type SafeEvent = 'startup_failed' | 'startup_ready' | 'request_failed';

export interface SafeFields {
  readonly code?: ApiCode;
  readonly request_id?: string;
  readonly status?: number;
}

const SAFE_EVENTS = new Set<string>(['startup_failed', 'startup_ready', 'request_failed']);
const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class SafeLogger {
  constructor(
    private readonly sink: (line: string) => void = (line) => {
      process.stdout.write(`${line}\n`);
    },
  ) {}

  event(event: SafeEvent, fields: SafeFields = {}): void {
    if (!SAFE_EVENTS.has(event)) return;
    const output: Record<string, string | number> = { event };
    if (typeof fields.code === 'string' && Object.hasOwn(ERROR_DEFINITIONS, fields.code)) {
      output.code = fields.code;
    }
    if (typeof fields.request_id === 'string' && SAFE_UUID.test(fields.request_id)) {
      output.request_id = fields.request_id;
    }
    if (
      typeof fields.status === 'number' &&
      Number.isInteger(fields.status) &&
      fields.status >= 100 &&
      fields.status <= 599
    ) {
      output.status = fields.status;
    }
    this.sink(JSON.stringify(output));
  }
}
