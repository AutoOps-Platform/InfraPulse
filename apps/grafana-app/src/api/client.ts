import { config } from '@grafana/runtime';
import type {
  Agent,
  Assignment,
  Credential,
  Filters,
  IssueInput,
  IssuedCredential,
  Lifecycle,
  Page,
  Principal,
  Profile,
  ProfileDetail,
  ProfileVersion,
  Provisioning,
  PublicSettings,
  Server,
  ServerInput,
} from './types';

export const PLUGIN_ID = 'infrapulse-infrapulse-app';
export const appPath = (page = '') => `${config.appSubUrl}/a/${PLUGIN_ID}${page ? `/${page}` : ''}`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (value: string) => uuid.test(value);
const id = (value: string) => {
  if (!isUuid(value)) {
    throw new Error('Invalid resource identifier');
  }
  return value;
};
const messages: Record<number, string> = {
  400: 'Invalid request. Check the form and supported options.',
  401: 'Authentication was rejected. Sign in again; ask the operator to verify adapter trust and clocks if it persists.',
  403: 'The Management API denied this action for your verified role.',
  404: 'The resource no longer exists or is not visible to your role.',
  409: 'The operation conflicts with current state. Refresh and inspect before retrying.',
  413: 'The request exceeds the supported size.',
  429: 'The service is busy. Wait before deliberately retrying.',
  502: 'The Management response could not be verified.',
  503: 'A required service or trusted identity is unavailable. No insecure fallback is used.',
  504: 'The request timed out. A mutation may have committed; inspect state before submitting another operation.',
};
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly requestId?: string,
    readonly credential?: Credential
  ) {
    super(
      code === 'secret_already_issued'
        ? 'This operation already issued a secret and it cannot be retrieved. Inspect its metadata, revoke the inaccessible key, then deliberately start a new operation.'
        : (messages[status] ?? 'The request failed. Its result may be uncertain; refresh state before a new mutation.')
    );
    this.name = 'ApiError';
  }
}
export const errorMessage = (error: unknown): string =>
  error instanceof ApiError
    ? `${error.message}${error.requestId ? ` Request ID: ${error.requestId}` : ''}`
    : 'The request could not be completed. Check connectivity and inspect state before retrying a mutation.';
const query = (filters: Filters = {}) => {
  const values = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== '') {
      values.set(key, String(value));
    }
  });
  return values.size ? `?${values.toString()}` : '';
};
// Native same-origin fetch deliberately avoids shared query caches, automatic retries,
// and global error/analytics handlers holding one-time credential responses.
async function request<T>(target: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${config.appSubUrl}/api/plugins/${PLUGIN_ID}/resources/${target}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    if (signal?.aborted) {
      throw new DOMException('Request aborted', 'AbortError');
    }
    throw new ApiError(0, 'transport_unavailable');
  }
  if (!response.ok) {
    // Never retain the raw response/error object, which could include body/proof.
    let code = 'request_failed';
    let requestId: string | undefined;
    let credential: Credential | undefined;
    try {
      const data: unknown = await response.json();
      if (data && typeof data === 'object') {
        const safe = data as Record<string, unknown>;
        if (typeof safe.code === 'string' && /^[a-z_]{1,64}$/.test(safe.code)) {
          code = safe.code;
        }
        if (typeof safe.request_id === 'string' && isUuid(safe.request_id)) {
          requestId = safe.request_id;
        }
        if (code === 'secret_already_issued' && safe.credential && typeof safe.credential === 'object') {
          // Explicit projection excludes any unexpected secret-like response member.
          const row = safe.credential as Credential;
          if (isUuid(row.id ?? '') && isUuid(row.agent_id ?? '')) {
            credential = {
              id: row.id,
              agent_id: row.agent_id,
              server_id: row.server_id,
              public_prefix: row.public_prefix,
              scopes: row.scopes,
              expires_at: row.expires_at,
              retire_at: row.retire_at,
              revoked_at: row.revoked_at,
              rotated_from_id: row.rotated_from_id,
              issuance_request_id: row.issuance_request_id,
              created_at: row.created_at,
              status: row.status,
            };
          }
        }
      }
    } catch {
      /* Finite fallback only; do not log network/parser exceptions. */
    }
    throw new ApiError(response.status, code, requestId, credential);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError(502, 'invalid_upstream_response');
  }
}
export const api = {
  me: (signal?: AbortSignal) => request<Principal>('api/v1/me', 'GET', undefined, signal),
  settings: (signal?: AbortSignal) => request<PublicSettings>('settings', 'GET', undefined, signal),
  servers: (filters?: Filters, signal?: AbortSignal) =>
    request<Page<Server>>(`api/v1/servers${query(filters)}`, 'GET', undefined, signal),
  server: (serverId: string, signal?: AbortSignal) =>
    request<Server>(`api/v1/servers/${id(serverId)}`, 'GET', undefined, signal),
  createServer: (input: ServerInput) => request<Server>('api/v1/servers', 'POST', input),
  updateServer: (serverId: string, input: Partial<ServerInput>) =>
    request<Server>(`api/v1/servers/${id(serverId)}`, 'PATCH', input),
  archiveServer: (serverId: string) => request<void>(`api/v1/servers/${id(serverId)}`, 'DELETE'),
  agents: (filters?: Filters, signal?: AbortSignal) =>
    request<Page<Agent>>(`api/v1/agents${query(filters)}`, 'GET', undefined, signal),
  agent: (agentId: string, signal?: AbortSignal) =>
    request<Agent>(`api/v1/agents/${id(agentId)}`, 'GET', undefined, signal),
  registerAgent: (serverId: string) => request<Agent>(`api/v1/servers/${id(serverId)}/agents`, 'POST', {}),
  transitionAgent: (agentId: string, action: 'disable' | 'enable' | 'retire') =>
    request<Agent>(`api/v1/agents/${id(agentId)}/${action}`, 'POST', {}),
  credentials: (filters?: Filters, signal?: AbortSignal) =>
    request<Page<Credential>>(`api/v1/credentials${query(filters)}`, 'GET', undefined, signal),
  credential: (credentialId: string) => request<Credential>(`api/v1/credentials/${id(credentialId)}`),
  issueCredential: (agentId: string, input: IssueInput) =>
    request<IssuedCredential>(`api/v1/agents/${id(agentId)}/credentials`, 'POST', input),
  rotateCredential: (credentialId: string, input: IssueInput) =>
    request<IssuedCredential>(`api/v1/credentials/${id(credentialId)}/rotate`, 'POST', input),
  revokeCredential: (credentialId: string) =>
    request<void>(`api/v1/credentials/${id(credentialId)}/revoke`, 'POST', {}),
  profiles: (filters?: Filters, signal?: AbortSignal) =>
    request<Page<Profile>>(`api/v1/monitoring-profiles${query(filters)}`, 'GET', undefined, signal),
  profile: (profileId: string, signal?: AbortSignal) =>
    request<ProfileDetail>(`api/v1/monitoring-profiles/${id(profileId)}`, 'GET', undefined, signal),
  versions: (profileId: string, filters?: Filters, signal?: AbortSignal) =>
    request<Page<ProfileVersion>>(
      `api/v1/monitoring-profiles/${id(profileId)}/versions${query(filters)}`,
      'GET',
      undefined,
      signal
    ),
  version: (versionId: string) => request<ProfileVersion>(`api/v1/profile-versions/${id(versionId)}`),
  assignment: (serverId: string, signal?: AbortSignal) =>
    request<Assignment>(`api/v1/servers/${id(serverId)}/profile`, 'GET', undefined, signal),
  assignProfile: (serverId: string, versionId: string) =>
    request<Assignment>(`api/v1/servers/${id(serverId)}/profile`, 'PUT', { profile_version_id: id(versionId) }),
  provisioning: (apiKey: string, serverId: string, agentId: string) =>
    request<Provisioning>('provisioning', 'POST', { api_key: apiKey, server_id: id(serverId), agent_id: id(agentId) }),
};
export const activeAgents = (agents: Agent[]) =>
  agents.filter((agent) => agent.lifecycle === ('active' satisfies Lifecycle));
