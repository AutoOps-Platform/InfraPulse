import type { Platform } from '../../app/modules/onboarding/dto/onboarding.dto.js';

export const AWS_PORT = Symbol('AWS_PORT');

export interface WorkflowIdentity {
  serverId: string;
  nodeId: string;
  enrollmentId: string;
  operationId: string;
  platform: Platform;
  configurationVersion: string;
}

export interface AgentCommand {
  identity: WorkflowIdentity;
  kind: 'Configure' | 'Cleanup';
  document: { name: string; version: string };
  preset: { name: string; version: string };
  previousOperationId: string | null;
}

export type CommandErrorCode =
  | 'RELEASE_MISSING'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'MANUAL_ADOPTION_REQUIRED'
  | 'CONFLICT'
  | 'DECOMMISSIONED'
  | 'PACKAGE_MISMATCH'
  | 'CREDENTIAL_SOURCE_UNSAFE'
  | 'PRESET_FETCH_FAILED'
  | 'PRESET_MISMATCH'
  | 'RESOURCE_MISMATCH'
  | 'CONFIGURE_FAILED'
  | 'CLEANUP_FAILED'
  | 'SUMMARY_TOO_LARGE'
  | 'COMMAND_FAILED'
  | 'INVALID_SUMMARY';

export interface CommandObservation {
  commandId: string | null;
  status: 'Pending' | 'InProgress' | 'Success' | 'Failed' | 'Cancelled' | 'TimedOut' | 'Unknown';
  requestedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  step: 'prepare' | 'install' | 'configure' | 'cleanup' | null;
  errorCode: CommandErrorCode | null;
  cloudWatchVersion: string | null;
  serviceState: 'running' | 'stopped' | 'failed' | null;
  resources: NativeResource[] | null;
}

export interface CommandSummary extends WorkflowIdentity {
  step: 'prepare' | 'configure' | 'cleanup';
  errorCode: CommandErrorCode | null;
  cloudWatchVersion: string | null;
  serviceState: CommandObservation['serviceState'];
  resources: NativeResource[];
}

export type AwsErrorCode =
  | 'invalid_input'
  | 'permission_denied'
  | 'timeout'
  | 'aborted'
  | 'dependency_unavailable'
  | 'invalid_response'
  | 'qualification_required'
  | 'conflict';

export type MutationResult =
  | { kind: 'Known'; commandId?: string }
  | { kind: 'Ambiguous' | 'Error'; code: AwsErrorCode };

export interface AgentCommandPort {
  readonly sendCommand: (
    command: AgentCommand,
    signal: AbortSignal,
  ) => Promise<
    { kind: 'Known'; commandId: string } | { kind: 'Ambiguous' | 'Error'; code: AwsErrorCode }
  >;
  readonly readCommand: (
    command: AgentCommand,
    commandId: string | null,
    signal: AbortSignal,
  ) => Promise<CommandObservation>;
}

export interface ActivationIntent {
  serverId: string;
  enrollmentId: string;
  generation: number;
  platform: Platform;
  expiresAt: Date;
}

export interface ActivationMetadata extends ActivationIntent {
  id: string;
  registrations: number;
}

export type CreateActivationResult =
  | { kind: 'Known'; id: string; code: string; expiresAt: Date }
  | { kind: 'Ambiguous' | 'Denied' | 'Invalid'; code: AwsErrorCode };

export type ActivationMatch =
  | { kind: 'None' }
  | { kind: 'One'; activation: ActivationMetadata }
  | { kind: 'Ambiguous'; code: AwsErrorCode };

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

export interface NodeIdentity {
  nodeId: string;
  activationId: string;
  serverId: string;
  enrollmentId: string;
  generation: number;
  platform: Platform;
  metadata: AgentMetadata;
}

export type NodeMatch =
  | { kind: 'None' }
  | { kind: 'One'; node: NodeIdentity }
  | { kind: 'Ambiguous'; code: AwsErrorCode };

export interface Dimension {
  name: string;
  value: string;
}

export interface NativeResource {
  id: string;
  kind: 'cpu' | 'memory' | 'filesystem' | 'interface';
  dimensions: Dimension[];
}

export interface MetricSpec {
  key: string;
  group: 'cpu' | 'memory' | 'disk' | 'network';
  namespace: string;
  metricName: string;
  resourceId: string | null;
  dimensions: Dimension[];
  statistic: 'Average' | 'Maximum' | 'Minimum' | 'Sum';
  aggregation: string[];
  unit: 'Percent' | 'Bytes' | 'Count' | 'Bytes/Second' | 'Count/Second';
  periodSeconds: 60;
  semantics: 'gauge' | 'counter' | 'rate';
}

export interface AwsContractBinding {
  accountId: string;
  region: string;
  deploymentId: string;
  configDocument: string;
  configVersion: string | null;
  cleanupDocument: string;
  cleanupVersion: string | null;
  presets: {
    platform: Platform;
    name: string;
    version: string;
    hash: string;
    configurationVersion: string;
    resources: NativeResource[];
    metrics: MetricSpec[];
  }[];
}

export interface BindingIdentity {
  serverId: string;
  enrollmentId: string;
  nodeId: string;
  activationId: string;
  generation: number;
  platform: Platform;
  accountId: string;
  region: string;
  presetHash: string;
  configStartedAt: Date;
}

export interface MetricQuery {
  id: string;
  binding: BindingIdentity;
  key: string;
  dimensions: Dimension[];
}

export interface TimeWindow {
  start: Date;
  end: Date;
}

export interface MetricSeries {
  id: string;
  dimensions: Dimension[];
  points: { timestamp: string; value: number }[];
}

export type MetricReadResult =
  | { kind: 'Complete'; series: MetricSeries[] }
  | { kind: 'Partial'; series: MetricSeries[]; code: AwsErrorCode }
  | { kind: 'Unavailable'; code: AwsErrorCode };

export interface BootstrapArtifactInput {
  key: string;
  body: Buffer;
  contentType: 'text/x-shellscript' | 'text/plain';
  expiresInSeconds: number;
}

export type PublishBootstrapArtifactResult =
  | { kind: 'Known'; url: string; expiresAt: Date }
  | { kind: 'Denied' | 'Error'; code: AwsErrorCode };

export interface AwsPort extends AgentCommandPort {
  readonly createActivation: (
    intent: ActivationIntent,
    signal: AbortSignal,
  ) => Promise<CreateActivationResult>;
  readonly findActivations: (
    intent: ActivationIntent,
    signal: AbortSignal,
  ) => Promise<ActivationMatch>;
  readonly findNodesByActivation: (id: string, signal: AbortSignal) => Promise<NodeMatch>;
  readonly observeNode: (
    binding: Pick<
      NodeIdentity,
      'nodeId' | 'activationId' | 'serverId' | 'enrollmentId' | 'platform'
    >,
    signal: AbortSignal,
  ) => Promise<AgentMetadata | null>;
  readonly readMetrics: (
    queries: MetricQuery[],
    window: TimeWindow,
    signal: AbortSignal,
  ) => Promise<MetricReadResult>;
  readonly deleteUnusedActivation: (id: string, signal: AbortSignal) => Promise<MutationResult>;
  readonly deregisterNode: (
    binding: Pick<
      NodeIdentity,
      'nodeId' | 'activationId' | 'serverId' | 'enrollmentId' | 'platform'
    >,
    signal: AbortSignal,
  ) => Promise<MutationResult>;
  readonly publishBootstrapArtifact: (
    input: BootstrapArtifactInput,
    signal: AbortSignal,
  ) => Promise<PublishBootstrapArtifactResult>;
  readonly deleteBootstrapArtifact: (key: string, signal: AbortSignal) => Promise<MutationResult>;
}

export const terminalCommand = (o: CommandObservation | null): boolean =>
  !!o && ['Success', 'Failed', 'Cancelled', 'TimedOut'].includes(o.status) && o.commandId !== null;

export const emptyAgent = (): AgentMetadata => ({
  nodeId: null,
  hostname: null,
  ipAddress: null,
  osVersion: null,
  ssmStatus: null,
  ssmAgentVersion: null,
  ssmLastPingAt: null,
  cloudWatchVersion: null,
  cloudWatchServiceState: null,
  observedAt: null,
});

export const unknownCommand = (commandId: string | null = null): CommandObservation => ({
  commandId,
  status: 'Unknown',
  requestedAt: null,
  startedAt: null,
  finishedAt: null,
  step: null,
  errorCode: null,
  cloudWatchVersion: null,
  serviceState: null,
  resources: null,
});
