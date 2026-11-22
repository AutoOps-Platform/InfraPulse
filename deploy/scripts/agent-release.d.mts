import type { MetricSpec, NativeResource } from '../../services/management-backend/src/integrations/aws/aws.port.js';
export type ReleasePlatform = 'linux' | 'windows';
export interface ReleaseSigner { subject: string; certificateSha256: string }
export interface ReleaseArtifact { version: string; url: string; sha256: string; signer: ReleaseSigner | null }
export interface AlloyReleaseArtifact { version: string; url: string; sha256: string }
export interface AmpTargetConfig { workspaceId: string; region: 'ap-southeast-1'; remoteWriteUrl: string }
export interface ReleasePlugin {
  plugin: 'cpu' | 'mem' | 'disk' | 'net' | 'Processor' | 'Memory' | 'LogicalDisk' | 'Network Interface';
  resources: (NativeResource & { selector: string })[];
  measurements: { input: string; metricKeys: string[] }[];
}
export interface PlatformRelease {
  revision: string;
  ssm: ReleaseArtifact;
  helper: ReleaseArtifact;
  alloy: AlloyReleaseArtifact;
  amp: AmpTargetConfig;
  configuration: { plugins: ReleasePlugin[] };
  metrics: MetricSpec[];
  parameter: { name: string; version: number; tier: 'Standard' | 'Advanced'; sha256: string };
}
export interface AgentRelease { schemaVersion: 1; platforms: Partial<Record<ReleasePlatform, PlatformRelease>> }
export function decodeAgentRelease(value: unknown): AgentRelease;
export function canonicalJson(value: unknown): string;
export function releaseSha256(value: unknown): string;
export function alloyPreset(platform: ReleasePlatform, release: PlatformRelease): Record<string, unknown>;
export function cloudWatchPreset(platform: ReleasePlatform, release: PlatformRelease): Record<string, unknown>;
