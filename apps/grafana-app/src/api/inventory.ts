import { parseDashboardContext, parseOnboardingProgress } from './types';
import type { AwsServer, Filters, MonitoringHealth, Os, Page } from './types';

export interface FleetRow {
  serverId: string;
  name: string;
  platform: Os;
  environment: string;
  health: MonitoringHealth;
  lastSampleAt: string | null;
  canOpenMetrics: boolean;
}

export type Binding = { server_id: string; managed_node_id: string; enrollment_id: string } & Record<`native_${string}`, string>;
type ReadPage = (filters: Filters, signal?: AbortSignal) => Promise<Page<AwsServer>>;
type ReadServer = (serverId: string, signal?: AbortSignal) => Promise<AwsServer>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const nativeAtom = /^[A-Za-z0-9_ .:/()+\-#\[\]]{1,256}$/;
const hex = (value: string) => Array.from(value, c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException('Cancelled', 'AbortError');
  }
}

export function projectBinding(server: AwsServer): Binding | null {
  try {
    const progress = parseOnboardingProgress(server.onboarding);
    if (!progress.availability.available) {
      return null;
    }
    const binding = parseDashboardContext(server.dashboardContext, server, progress);
    if (!binding || (binding.platform !== 'linux' && binding.platform !== 'windows')) {
      return null;
    }
    const dimensions: Binding = { server_id: binding.serverId, managed_node_id: binding.nodeId, enrollment_id: binding.enrollmentId };
    for (const resource of binding.resources) {
      for (const { name, value } of resource.dimensions) {
        // No Grafana wildcard, variable, delimiter, controls, or whitespace-only values.
        if (!nativeAtom.test(value) || value !== value.trim()) {
          return null;
        }
        dimensions[`native_${hex(resource.id)}_${hex(name)}`] = value;
      }
    }
    return dimensions;
  } catch {
    return null;
  }
}

export async function listFleet(readPage: ReadPage, signal?: AbortSignal): Promise<{ rows: FleetRow[]; partial: boolean }> {
  const rows = new Map<string, FleetRow>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let partial = false;
  for (let page = 0; page < 100; page++) {
    checkAbort(signal);
    const result = await readPage({ archive: 'false', limit: 100, cursor }, signal);
    checkAbort(signal);
    for (const server of result.items) {
      if (rows.has(server.id) || server.archived_at !== null) {
        partial = true;
        continue;
      }
      rows.set(server.id, {
        serverId: server.id,
        name: server.name,
        platform: server.os,
        environment: server.environment,
        health: server.onboarding.monitoring.health,
        lastSampleAt: server.onboarding.monitoring.lastObservedSampleAt,
        canOpenMetrics: projectBinding(server) !== null,
      });
    }
    if (result.next_cursor === null) {
      return { rows: [...rows.values()], partial };
    }
    if (seenCursors.has(result.next_cursor)) {
      break;
    }
    seenCursors.add(result.next_cursor);
    cursor = result.next_cursor;
  }
  return { rows: [...rows.values()], partial: true };
}

export function vmOptionsForQuery(
  rows: readonly FleetRow[],
  query: unknown,
): Array<{ text: string; value: string }> | null {
  if (query !== 'vm-options' && query !== 'vm-options linux' && query !== 'vm-options windows') {
    return null;
  }
  const platform: Os | null = query === 'vm-options' ? null : (query.slice('vm-options '.length) as Os);
  return rows
    .filter((row) => platform === null || row.platform === platform)
    .map(({ name, serverId }) => ({ text: `${name} (${serverId})`, value: serverId }));
}

export async function readBinding(readServer: ReadServer, serverId: string, signal?: AbortSignal): Promise<Binding | null> {
  checkAbort(signal);
  if (!uuid.test(serverId)) {
    return null;
  }
  let server: AwsServer;
  try {
    server = await readServer(serverId, signal);
  } catch {
    checkAbort(signal);
    return null;
  }
  checkAbort(signal);
  return server.id === serverId ? projectBinding(server) : null;
}
