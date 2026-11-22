import { config } from '@grafana/runtime';
import type {
  Filters,
  Page,
  Principal,
  AwsServer,
  BootstrapIntent,
  BootstrapLink,
  RetryIntent,
  OnboardingProgress,
  ServerInput,
} from './types';
import {
  parseOnboardingProgress,
  parseBootstrapLink,
  parseDashboardContext,
  parseConfigurationObservation,
} from './types';

import { PLUGIN_ID, isUuid } from './vm-routes';
export { PLUGIN_ID, appPath, isUuid } from './vm-routes';
export const resourcePath = (target: string) => `${config.appSubUrl}/api/plugins/${PLUGIN_ID}/resources/${target}`;
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
    readonly requestId?: string
  ) {
    super(messages[status] ?? 'The request failed. Its result may be uncertain; refresh state before a new mutation.');
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
// and global error/analytics handlers holding sensitive responses.
async function request<T>(target: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(resourcePath(target), {
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
      }
    } catch {
      /* Finite fallback only; do not log network/parser exceptions. */
    }
    throw new ApiError(response.status, code, requestId);
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
function progress(value: unknown, serverId: string): OnboardingProgress {
  try {
    const parsed = parseOnboardingProgress(value);
    if (parsed.serverId !== id(serverId)) throw new Error();
    return parsed;
  } catch {
    throw new ApiError(502, 'invalid_upstream_response');
  }
}
function inventory(value: unknown, serverId?: string): AwsServer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(502, 'invalid_upstream_response');
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !isUuid(row.id) || (serverId !== undefined && row.id !== serverId) || typeof row.name !== 'string' || typeof row.environment !== 'string' || (row.os !== 'linux' && row.os !== 'windows') || !row.metadata || typeof row.metadata !== 'object' || Array.isArray(row.metadata) || typeof row.created_at !== 'string' || typeof row.updated_at !== 'string' || (row.archived_at !== null && typeof row.archived_at !== 'string')) throw new ApiError(502, 'invalid_upstream_response');
  const server = {
    id: row.id, name: row.name, environment: row.environment, os: row.os,
    metadata: row.metadata as Record<string, unknown>, created_at: row.created_at,
    updated_at: row.updated_at, archived_at: row.archived_at,
    onboarding: progress(row.onboarding, row.id),
    configuration: (() => { try { return parseConfigurationObservation(row.configuration); } catch { throw new ApiError(502, 'invalid_upstream_response'); } })(),
    alertRuleUids: (() => {
      if (!Array.isArray(row.alertRuleUids) || row.alertRuleUids.length > 32 || row.alertRuleUids.some(v => typeof v !== 'string' || !/^ip_[a-f0-9]{32}_[a-z0-9]{4}$/.test(v)) || new Set(row.alertRuleUids).size !== row.alertRuleUids.length) throw new ApiError(502, 'invalid_upstream_response');
      return row.alertRuleUids as string[];
    })(),
  } satisfies Omit<AwsServer, 'dashboardContext'>;
  try { return { ...server, dashboardContext: parseDashboardContext(row.dashboardContext, server, server.onboarding) }; }
  catch { throw new ApiError(502, 'invalid_upstream_response'); }
}
function inventoryPage(value: unknown): Page<AwsServer> {
  const page = value as Partial<Page<unknown>> | null;
  if (!page || !Array.isArray(page.items) || page.items.length > 100 || (page.next_cursor !== null && (typeof page.next_cursor !== 'string' || page.next_cursor.length > 2048))) throw new ApiError(502, 'invalid_upstream_response');
  return { items: page.items.map((row) => inventory(row)), next_cursor: page.next_cursor };
}
const intent = (value: BootstrapIntent): BootstrapIntent => ({ requestId: id(value.requestId) });
export const api = {
  me: (signal?: AbortSignal) => request<Principal>('api/v1/me', 'GET', undefined, signal),
  servers: async (filters?: Filters, signal?: AbortSignal) =>
    inventoryPage(await request<unknown>(`api/v1/servers${query(filters)}`, 'GET', undefined, signal)),
  inventoryServer: async (serverId: string, signal?: AbortSignal) =>
    inventory(await request<unknown>(`api/v1/servers/${id(serverId)}`, 'GET', undefined, signal), serverId),
  createServer: async (input: ServerInput) => inventory(await request<unknown>('api/v1/servers', 'POST', input)),
  updateServer: async (serverId: string, input: Partial<ServerInput>) =>
    inventory(await request<unknown>(`api/v1/servers/${id(serverId)}`, 'PATCH', input), serverId),
  onboarding: async (serverId: string, signal?: AbortSignal) =>
    progress(await request<unknown>(`api/v1/servers/${id(serverId)}/onboarding`, 'GET', undefined, signal), serverId),
  createBootstrapLink: async (serverId: string, input: BootstrapIntent, signal?: AbortSignal): Promise<BootstrapLink> => {
    const targetId = id(serverId);
    const data = await request<unknown>(`api/v1/servers/${targetId}/onboarding/bootstrap-link`, 'POST', intent(input), signal);
    try {
      return parseBootstrapLink(data, targetId);
    } catch {
      throw new ApiError(502, 'invalid_upstream_response');
    }
  },
  retryOnboarding: async (serverId: string, input: RetryIntent, signal?: AbortSignal) => {
    if (!['retry-config', 'regenerate-unused'].includes(input.mode)) throw new Error('Invalid retry mode');
    return progress(await request<unknown>(`api/v1/servers/${id(serverId)}/onboarding/retry`, 'POST', { ...intent(input), mode: input.mode }, signal), serverId);
  },
  decommission: async (serverId: string, input: BootstrapIntent, signal?: AbortSignal) =>
    progress(await request<unknown>(`api/v1/servers/${id(serverId)}/decommission`, 'POST', intent(input), signal), serverId),
  archiveServer: (serverId: string) => request<void>(`api/v1/servers/${id(serverId)}`, 'DELETE'),
};
