// Wire types follow Management DTOs/OpenAPI, not the illustrative routes in INTRODUCT.
export type Os = 'linux' | 'windows';
export type Role = 'Viewer' | 'Operator' | 'Admin';
export type Lifecycle = 'active' | 'disabled' | 'retired';
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
export interface Telemetry {
  status: 'Online' | 'Stale' | 'Offline' | 'Unknown';
  last_metric_seen_at: string | null;
  status_as_of: string | null;
  source_health: 'healthy' | 'stale' | 'gap' | 'unavailable';
  confidence_reason: string;
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
  telemetry: Telemetry;
}
export interface ServerInput {
  name: string;
  os: Os;
  environment: string;
  metadata?: Record<string, unknown>;
}
export interface Agent {
  id: string;
  server_id: string;
  os_at_registration: Os;
  agent_type: 'telegraf';
  lifecycle: Lifecycle;
  version: string | null;
  version_source: string | null;
  version_reported_at: string | null;
  last_metric_seen_at: string | null;
  registered_at: string;
  retired_at: string | null;
  created_at: string;
  updated_at: string;
  telemetry: Telemetry;
  last_applied_profile_version_id: string | null;
  last_applied_at: string | null;
  last_config_report_result: 'applied' | 'failed' | null;
  last_config_report_at: string | null;
}
export type Scope = 'metrics:write' | 'provisioning:read' | 'config:report';
export interface Credential {
  id: string;
  agent_id: string;
  server_id: string;
  public_prefix: string;
  scopes: Scope[];
  expires_at: string;
  retire_at: string | null;
  revoked_at: string | null;
  rotated_from_id: string | null;
  issuance_request_id: string;
  created_at: string;
  status: 'active' | 'rotating' | 'expired' | 'revoked' | 'inactive';
}
export interface IssuedCredential extends Credential {
  api_key: string;
}
export interface IssueInput {
  issuance_request_id: string;
  scopes?: Scope[];
  expires_at?: string;
}
export interface Profile {
  id: string;
  slug: string;
  name: string;
  description: string;
  os: Os;
  retired_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface ProfileConfig {
  schema_version: 1;
  os: Os;
  interval_seconds?: number;
  metric_groups: { cpu: boolean; memory: boolean; disk: boolean; network: boolean };
  options: {
    disk?: { exclude_filesystems?: string[]; mount_points?: string[]; include_volumes?: string[] };
    network?: { interfaces?: string[] };
  };
}
export interface ProfileVersion {
  id: string;
  profile_id: string;
  version: number;
  config: ProfileConfig;
  checksum: string;
  status: 'draft' | 'published';
  created_at: string;
  published_at: string | null;
}
export interface ProfileDetail extends Profile {
  versions: ProfileVersion[];
}
export interface Assignment {
  server_id: string;
  profile_version_id: string;
  assigned_at: string;
}
export interface Provisioning {
  server_id: string;
  agent_id: string;
  os: Os;
  profile: { id: string; version_id: string; version: number; checksum: string; config: ProfileConfig };
  ingestion: {
    base_url: string;
    path: '/api/v1/ingest/remote-write';
    content_type: 'application/x-protobuf';
    content_encoding: 'snappy';
    remote_write_version: '0.1.0';
    authorization_scheme: 'Bearer';
    identity_headers: { 'X-Server-ID': string; 'X-Agent-ID': string };
  };
}
export interface PublicSettings {
  agentControlUrl: string;
  gatewayOrigin: string;
}
export type Filters = Record<string, string | number | undefined>;
