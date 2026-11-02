const errors = {
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
export type ApiCode = keyof typeof errors;
export class ApiError extends Error {
  readonly status: number;
  constructor(readonly code: ApiCode) {
    super(errors[code][1]);
    this.name = 'ApiError';
    this.status = errors[code][0];
  }
}
