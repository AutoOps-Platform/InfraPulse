// Wire types follow Management DTOs/OpenAPI, not the illustrative routes in INTRODUCT.
export type Os = 'linux' | 'windows';
export type Role = 'Viewer' | 'Operator' | 'Admin';
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}
export interface Principal {
  kind: 'user';
  issuer: string;
  subject: string;
  context: string;
  role: Role;
  display?: string;
}
export interface Server {
  id: string;
  name: string;
  os: Os;
  environment: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}
// Current inventory never promises the retired telemetry projection.
export interface DashboardContext {
  serverId: string;
  nodeId: string;
  enrollmentId: string;
  generation: number;
  platform: Os;
  presetHash: string;
  state: 'Active';
  resources: Array<{ id: string; dimensions: Array<{ name: string; value: string }> }>;
}
export interface ConfigurationObservation {
  version: string | null;
  status: 'Pending' | 'InProgress' | 'Success' | 'Failed' | 'Cancelled' | 'TimedOut' | 'Unknown' | null;
  requestedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface AwsServer extends Server {
  configuration: ConfigurationObservation;
  alertRuleUids: string[];
  onboarding: OnboardingProgress;
  dashboardContext: DashboardContext | null;
}
export interface ServerInput {
  name: string;
  os: Os;
  environment: string;
  metadata?: Record<string, unknown>;
}
export interface SslTarget {
  id: string;
  name: string;
  host: string;
  port: number;
  group: string;
  enabled: boolean;
  subjectCn: string | null;
  issuerCn: string | null;
  serialNumber: string | null;
  notBefore: string | null;
  notAfter: string | null;
  authorized: boolean | null;
  lastProbedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface CreateSslTargetInput {
  name: string;
  host: string;
  port?: number;
  group?: string;
  enabled?: boolean;
}
export interface PatchSslTargetInput {
  name?: string;
  group?: string;
  enabled?: boolean;
}
export type Filters = Record<string, string | number | undefined>;

// Closed B1 public contract, mirrored from onboarding.types.ts (not provider errors).
export const ONBOARDING_STATES = ['Pending', 'Registered', 'Configuring', 'Verifying', 'Success', 'Failed', 'Expired'] as const;
export const ONBOARDING_STAGES = ['AwaitingBootstrap', 'CreatingActivation', 'ReconcilingActivation', 'AwaitingRegistration', 'ApplyingConfig', 'VerifyingMetrics', 'Complete', 'Failed', 'Expired', 'Decommissioning', 'CleanupRequired', 'Retired'] as const;
export const ONBOARDING_ERROR_CODES = ['activation_ambiguous', 'activation_expired', 'activation_unavailable', 'registration_conflict', 'platform_mismatch', 'configuration_failed', 'configuration_timeout', 'verification_timeout', 'metrics_unavailable', 'permission_denied', 'contract_unqualified', 'cleanup_required', 'dependency_unavailable', 'superseded'] as const;
export type OnboardingState = (typeof ONBOARDING_STATES)[number];
export type OnboardingStage = (typeof ONBOARDING_STAGES)[number];
export type OnboardingErrorCode = (typeof ONBOARDING_ERROR_CODES)[number];
export type MonitoringHealth = 'Fresh' | 'Stale' | 'Offline' | 'Unknown';
export type BindingState = 'Active' | 'Decommissioning' | 'CleanupRequired' | 'Retired';
export type AlertSyncState = 'Pending' | 'Synced' | 'Error';
export interface BootstrapIntent { requestId: string }
export interface BootstrapLink {
  serverId: string;
  attemptId: string;
  generation: number;
  platform: Os;
  url: string;
  expiresAt: string;
  command: string;
}
export interface RetryIntent extends BootstrapIntent { mode: 'retry-config' | 'regenerate-unused' }
export interface AgentMetadata {
  nodeId: string | null;
  hostname: string | null;
  ipAddress: string | null;
  osVersion: string | null;
  ssmStatus: 'Online' | 'ConnectionLost' | 'Inactive' | null;
  ssmAgentVersion: string | null;
  ssmLastPingAt: string | null;
  cloudWatchVersion: string | null;
  cloudWatchServiceState: 'running' | 'stopped' | 'failed' | null;
  observedAt: string | null;
}
export interface OnboardingProgress {
  availability: { available: boolean; configurationVersion: string | null; reason: 'ready' | 'release_missing' };
  agent: AgentMetadata;
  serverId: string;
  attemptId: string | null;
  enrollmentId: string | null;
  generation: number;
  state: OnboardingState;
  stage: OnboardingStage;
  bindingState: BindingState | null;
  expiresAt: string | null;
  nextRunAt: string | null;
  errorCode: OnboardingErrorCode | null;
  monitoring: {
    health: MonitoringHealth;
    lastObservedSampleAt: string | null;
    lastSuccessfulQueryAt: string | null;
  };
  alertSync: {
    state: AlertSyncState;
    generation: number;
    desiredHash: string | null;
    syncedAt: string | null;
  };
}
const progressUuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const nullable = (v: unknown, check: (v: unknown) => boolean) => v === null || check(v);
const integer = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 2147483647;
const timestamp = (v: unknown) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const member = (v: unknown, choices: readonly string[]) => typeof v === 'string' && choices.includes(v);
const closedObject = (v: unknown, keys: string[]): v is Record<string, unknown> => Boolean(
  v && typeof v === 'object' && !Array.isArray(v) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(v)) &&
  Reflect.ownKeys(v).length === keys.length &&
  keys.every((key) => Object.prototype.hasOwnProperty.call(v, key) && 'value' in Object.getOwnPropertyDescriptor(v, key)!)
);
// Parse only the backend safe projection. Resource dimensions are presentation
// filters from the protected current receipt, never browser-native attestation.
export function parseDashboardContext(value: unknown, server: Server, onboarding: OnboardingProgress): DashboardContext | null {
  if (value === null) return null;
  const invalid = () => { throw new Error('Invalid dashboard context'); };
  if (!closedObject(value, ['serverId', 'nodeId', 'enrollmentId', 'generation', 'platform', 'presetHash', 'state', 'resources'])) return invalid();
  if (!progressUuid(value.serverId) || !progressUuid(value.enrollmentId) || typeof value.nodeId !== 'string' || !/^mi-[a-f0-9]{17}$/.test(value.nodeId) ||
    !integer(value.generation) || value.generation === 0 || value.platform !== server.os || value.serverId !== server.id ||
    value.state !== 'Active' || typeof value.presetHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.presetHash) ||
    server.archived_at !== null || onboarding.serverId !== server.id || onboarding.state !== 'Success' || onboarding.stage !== 'Complete' ||
    onboarding.bindingState !== 'Active' || onboarding.enrollmentId !== value.enrollmentId || onboarding.generation !== value.generation ||
    !Array.isArray(value.resources) || value.resources.length < 1 || value.resources.length > 32) return invalid();
  const resources = value.resources.map((item: unknown) => {
    if (!closedObject(item, ['id', 'dimensions']) || typeof item.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(item.id) ||
      !Array.isArray(item.dimensions) || item.dimensions.length < 1 || item.dimensions.length > 10) return invalid();
    const dimensions = item.dimensions.map((d: unknown) => {
      if (!closedObject(d, ['name', 'value']) || typeof d.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(d.name) ||
        /hash|time|activation|code|secret|token|credential/i.test(d.name) || ['ServerId', 'ManagedNodeId', 'EnrollmentId'].includes(d.name) ||
        typeof d.value !== 'string' || !/^[\x20-\x7e]{1,256}$/.test(d.value) || d.value.includes('${')) return invalid();
      return { name: d.name, value: d.value };
    });
    if (new Set(dimensions.map(d => d.name)).size !== dimensions.length) return invalid();
    return { id: item.id, dimensions };
  });
  if (new Set(resources.map(r => r.id)).size !== resources.length || JSON.stringify(value).length > 16384) return invalid();
  return { serverId: value.serverId as string, nodeId: value.nodeId, enrollmentId: value.enrollmentId as string,
    generation: value.generation as number, platform: server.os, presetHash: value.presetHash, state: 'Active', resources };
}
export function parseConfigurationObservation(value: unknown): ConfigurationObservation {
  if (!closedObject(value, ['version', 'status', 'requestedAt', 'startedAt', 'finishedAt']) ||
    !nullable(value.version, v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)) ||
    !nullable(value.status, v => member(v, ['Pending', 'InProgress', 'Success', 'Failed', 'Cancelled', 'TimedOut', 'Unknown'])) ||
    !['requestedAt', 'startedAt', 'finishedAt'].every(k => nullable(value[k], timestamp))) throw new Error('Invalid configuration observation');
  return JSON.parse(JSON.stringify(value)) as ConfigurationObservation;
}
export function parseOnboardingProgress(value: unknown): OnboardingProgress {
  if (!closedObject(value, ['serverId', 'attemptId', 'enrollmentId', 'generation', 'state', 'stage', 'bindingState', 'expiresAt', 'nextRunAt', 'errorCode', 'monitoring', 'alertSync', 'availability', 'agent'])) throw new Error('Invalid onboarding progress');
  const m = value.monitoring, a = value.alertSync, availability = value.availability, agent = value.agent;
  const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  const safeText = (v: unknown) => typeof v === 'string' && /^[\x20-\x7e]{1,255}$/.test(v);
  if (!closedObject(availability, ['available', 'configurationVersion', 'reason']) || typeof availability.available !== 'boolean' ||
    (availability.available ? availability.reason !== 'ready' || !hash(availability.configurationVersion) : availability.reason !== 'release_missing' || availability.configurationVersion !== null) ||
    !closedObject(agent, ['nodeId', 'hostname', 'ipAddress', 'osVersion', 'ssmStatus', 'ssmAgentVersion', 'ssmLastPingAt', 'cloudWatchVersion', 'cloudWatchServiceState', 'observedAt']) ||
    !nullable(agent.nodeId, v => typeof v === 'string' && /^mi-[a-f0-9]{17}$/.test(v)) ||
    !['hostname', 'ipAddress', 'osVersion', 'ssmAgentVersion', 'cloudWatchVersion'].every(k => nullable(agent[k], safeText)) ||
    !nullable(agent.ssmStatus, v => member(v, ['Online', 'ConnectionLost', 'Inactive'])) ||
    !nullable(agent.cloudWatchServiceState, v => member(v, ['running', 'stopped', 'failed'])) ||
    !nullable(agent.ssmLastPingAt, timestamp) || !nullable(agent.observedAt, timestamp)) throw new Error('Invalid onboarding progress');
  if (
    !progressUuid(value.serverId) ||
    !nullable(value.attemptId, progressUuid) || !nullable(value.enrollmentId, progressUuid) ||
    !integer(value.generation) || !member(value.state, ONBOARDING_STATES) || !member(value.stage, ONBOARDING_STAGES) ||
    !nullable(value.bindingState, (v) => member(v, ['Active', 'Decommissioning', 'CleanupRequired', 'Retired'])) ||
    !nullable(value.expiresAt, timestamp) || !nullable(value.nextRunAt, timestamp) ||
    !nullable(value.errorCode, (v) => member(v, ONBOARDING_ERROR_CODES)) ||
    !closedObject(m, ['health', 'lastObservedSampleAt', 'lastSuccessfulQueryAt']) ||
    !member(m.health, ['Fresh', 'Stale', 'Offline', 'Unknown']) ||
    !nullable(m.lastObservedSampleAt, timestamp) || !nullable(m.lastSuccessfulQueryAt, timestamp) ||
    !closedObject(a, ['state', 'generation', 'desiredHash', 'syncedAt']) ||
    !member(a.state, ['Pending', 'Synced', 'Error']) || !integer(a.generation) ||
    !nullable(a.desiredHash, (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)) || !nullable(a.syncedAt, timestamp)
  ) throw new Error('Invalid onboarding progress');
  if (
    (value.attemptId === null) !== (value.enrollmentId === null) ||
    (value.attemptId === null && (
      value.generation !== 0 || value.state !== 'Pending' || value.stage !== 'AwaitingBootstrap' ||
      value.bindingState !== null || m.health !== 'Unknown' ||
      m.lastObservedSampleAt !== null || m.lastSuccessfulQueryAt !== null ||
      a.state !== 'Pending' || a.generation !== 0 || a.desiredHash !== null || a.syncedAt !== null
    )) ||
    (value.attemptId !== null && value.generation === 0) ||
    (m.health !== 'Unknown' && (value.bindingState !== 'Active' || m.lastObservedSampleAt === null || m.lastSuccessfulQueryAt === null)) ||
    (a.state === 'Synced' && (a.desiredHash === null || a.syncedAt === null || a.generation !== value.generation))
  ) throw new Error('Invalid onboarding progress');
  // The closed JSON value has no extension bags or arbitrary error/stage text.
  return JSON.parse(JSON.stringify(value)) as OnboardingProgress;
}

export function parseBootstrapLink(value: unknown, serverId: string): BootstrapLink {
  if (!closedObject(value, ['serverId', 'attemptId', 'generation', 'platform', 'url', 'expiresAt', 'command'])) {
    throw new Error('Invalid bootstrap link');
  }
  const attemptId = value.attemptId;
  const generation = value.generation;
  const expiresAt = value.expiresAt;
  if (
    !progressUuid(value.serverId) ||
    value.serverId !== serverId ||
    typeof attemptId !== 'string' ||
    !progressUuid(attemptId) ||
    typeof generation !== 'number' ||
    !integer(generation) ||
    generation < 1 ||
    (value.platform !== 'linux' && value.platform !== 'windows') ||
    typeof value.url !== 'string' ||
    value.url.length === 0 ||
    value.url.length > 4096 ||
    /[\s'"]/.test(value.url) ||
    typeof expiresAt !== 'string' ||
    !timestamp(expiresAt) ||
    typeof value.command !== 'string' ||
    value.command.length === 0 ||
    value.command.length > 4500 ||
    /[\r\n]/.test(value.command) ||
    !value.command.includes(value.url)
  ) {
    throw new Error('Invalid bootstrap link');
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(value.url);
  } catch {
    throw new Error('Invalid bootstrap link');
  }
  if (
    parsedUrl.protocol !== 'https:' ||
    !/^infrapulse-[a-z0-9-]+-bootstrap-\d{12}\.s3\.ap-southeast-1\.amazonaws\.com$/.test(parsedUrl.hostname) ||
    !parsedUrl.pathname.startsWith(`/bootstrap/${serverId}/${attemptId}/`)
  ) {
    throw new Error('Invalid bootstrap link');
  }
  return {
    serverId: value.serverId,
    attemptId,
    generation,
    platform: value.platform,
    url: value.url,
    expiresAt,
    command: value.command,
  };
}
