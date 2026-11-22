import { DataSourceApi, DataSourcePlugin, FieldType } from '@grafana/data';
import type { DataQuery, DataQueryRequest, DataQueryResponse, LegacyMetricFindQueryOptions, MetricFindValue } from '@grafana/data';
import { getTemplateSrv } from '@grafana/runtime';
import { api } from '../api/client';
import { listFleet, readBinding, vmOptionsForQuery } from '../api/inventory';
import { vmMetricsHref, vmsHref } from '../api/vm-routes';

interface InventoryQuery extends DataQuery {
  operation: 'fleet' | 'host-info';
  view?: 'table' | 'summary' | 'by-status' | 'by-os';
}

const statusFields = ['Fresh', 'Stale', 'Offline', 'Unknown'] as const;
const identityKeys = ['server_id', 'managed_node_id', 'enrollment_id'];
const nativeKeys = /^(?:native_[0-9a-f]{2,128}_[0-9a-f]{2,128})(?:,native_[0-9a-f]{2,128}_[0-9a-f]{2,128})*$/;
const noMatch = 'no-match'; // Cannot be an Inventory UUID or a managed-node ID.

class InventoryDataSource extends DataSourceApi<InventoryQuery> {
  async metricFindQuery(query: unknown, options?: LegacyMetricFindQueryOptions): Promise<MetricFindValue[]> {
    if (query === 'vm-options' || query === 'vm-options linux' || query === 'vm-options windows') {
      const { rows } = await listFleet(api.servers);
      return vmOptionsForQuery(rows, query) ?? [];
    }
    if (typeof query !== 'string' || query.length > 32768) {
      return [];
    }
    let required = identityKeys;
    if (query === 'binding $server_id') {
      required = identityKeys;
    } else if (query.startsWith('binding $server_id ')) {
      const subset = query.slice('binding $server_id '.length);
      if (!nativeKeys.test(subset)) {
        return [];
      }
      required = [...identityKeys, ...new Set(subset.split(','))];
    } else {
      return [];
    }
    const selected = getTemplateSrv().replace('$server_id', options?.scopedVars);
    const binding = await readBinding(api.inventoryServer, selected);
    const valid = binding !== null && required.every((key) => Object.hasOwn(binding, key));
    const now = Date.now();
    const properties = valid
      ? { ...binding, recent_after_ms: String(now - 300_000), recent_through_ms: String(now) }
      : { ...Object.fromEntries(required.map((key) => [key, noMatch])), recent_after_ms: '1', recent_through_ms: '0' };
    return [{ text: valid ? 'Current binding' : 'No verified binding', value: valid ? 'verified' : noMatch, properties }];
  }

  async query(request: DataQueryRequest<InventoryQuery>): Promise<DataQueryResponse> {
    const visible = request.targets.filter((target) => !target.hide);
    const hostTargets = visible.filter((target) => target.operation === 'host-info');
    const fleetTargets = visible.filter(
      (target) => target.operation === 'fleet' && target.view !== undefined && ['table', 'summary', 'by-status', 'by-os'].includes(target.view),
    );
    if (!hostTargets.length && !fleetTargets.length) {
      return { data: [] };
    }

    const frames = [];
    if (hostTargets.length) {
      const selected = getTemplateSrv().replace('$server_id', request.scopedVars);
      let server = null;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(selected)) {
        try {
          server = await api.inventoryServer(selected);
        } catch {
          server = null;
        }
      }
      for (const { refId } of hostTargets) {
        const agent = server?.onboarding.agent;
        frames.push({
          refId,
          length: server ? 1 : 0,
          fields: [
            { name: 'VM', type: FieldType.string, values: server ? [server.name] : [], config: {} },
            { name: 'OS', type: FieldType.string, values: server ? [server.os === 'windows' ? 'Windows' : 'Linux'] : [], config: {} },
            { name: 'OS Version', type: FieldType.string, values: server ? [agent?.osVersion ?? '—'] : [], config: {} },
            { name: 'Hostname', type: FieldType.string, values: server ? [agent?.hostname ?? '—'] : [], config: {} },
            { name: 'IP', type: FieldType.string, values: server ? [agent?.ipAddress ?? '—'] : [], config: {} },
            { name: 'Managed Node', type: FieldType.string, values: server ? [agent?.nodeId ?? '—'] : [], config: {} },
            { name: 'SSM', type: FieldType.string, values: server ? [agent?.ssmStatus ?? '—'] : [], config: {} },
            { name: 'Alloy', type: FieldType.string, values: server ? [agent?.cloudWatchVersion ? `${agent.cloudWatchVersion} (${agent.cloudWatchServiceState ?? '—'})` : '—'] : [], config: {} },
            { name: 'Metrics', type: FieldType.string, values: server ? [server.onboarding.monitoring.health] : [], config: {} },
          ],
        });
      }
    }

    if (fleetTargets.length) {
      const snapshot = await listFleet(api.servers);
      const { rows, partial } = snapshot;
      const meta = partial ? { notices: [{ severity: 'warning' as const, text: 'Partial inventory. Totals are unavailable.' }] } : undefined;
      for (const { refId, view } of fleetTargets) {
        if (view === 'summary') {
          frames.push({
            refId, meta, length: 1, fields: [
              { name: 'VMs', type: FieldType.number, values: [partial ? null : rows.length], config: {} },
              ...statusFields.map((status) => ({
                name: status,
                type: FieldType.number,
                values: [partial ? null : rows.filter((row) => row.health === status).length],
                config: {},
              })),
            ],
          });
        } else if (view === 'by-status') {
          frames.push({
            refId, meta, length: statusFields.length, fields: [
              { name: 'Status', type: FieldType.string, values: [...statusFields], config: {} },
              { name: 'Count', type: FieldType.number, values: statusFields.map((s) => (partial ? null : rows.filter((r) => r.health === s).length)), config: {} },
            ],
          });
        } else if (view === 'by-os') {
          const osList = ['linux', 'windows'] as const;
          frames.push({
            refId, meta, length: osList.length, fields: [
              { name: 'OS', type: FieldType.string, values: ['Linux', 'Windows'], config: {} },
              { name: 'Count', type: FieldType.number, values: osList.map((o) => (partial ? null : rows.filter((r) => r.platform === o).length)), config: {} },
            ],
          });
        } else {
          frames.push({
            refId, meta, length: rows.length, fields: [
              { name: 'VM', type: FieldType.string, values: rows.map((row) => row.name), config: {} },
              { name: 'OS', type: FieldType.string, values: rows.map((row) => (row.platform === 'windows' ? 'Windows' : 'Linux')), config: {} },
              { name: 'Environment', type: FieldType.string, values: rows.map((row) => row.environment), config: {} },
              { name: 'Hostname', type: FieldType.string, values: rows.map((row) => row.hostname ?? '—'), config: {} },
              { name: 'IP', type: FieldType.string, values: rows.map((row) => row.ipAddress ?? '—'), config: {} },
              { name: 'Status', type: FieldType.string, values: rows.map((row) => row.health), config: {} },
              { name: 'SSM', type: FieldType.string, values: rows.map((row) => row.ssmStatus ?? '—'), config: {} },
              { name: 'Alloy', type: FieldType.string, values: rows.map((row) => row.agentVersion ?? '—'), config: {} },
              { name: 'Last sample', type: FieldType.time, values: rows.map((row) => (row.lastSampleAt === null ? null : Date.parse(row.lastSampleAt))), config: {} },
              { name: 'VM ID', type: FieldType.string, values: rows.map((row) => row.serverId), config: {} },
              { name: 'Open', type: FieldType.string, values: rows.map((row) => (row.canOpenMetrics ? 'Metrics' : 'Setup')), config: {} },
              { name: 'Path', type: FieldType.string, values: rows.map((row) => (row.canOpenMetrics ? vmMetricsHref(row.serverId, row.platform) : vmsHref(row.serverId))), config: {} },
            ],
          });
        }
      }
    }

    return { data: frames };
  }

  async testDatasource() {
    try {
      await api.servers({ archive: 'false', limit: 1 });
      return { status: 'success', message: 'VM inventory is reachable.' };
    } catch {
      return { status: 'error', message: 'VM inventory is unavailable for this session.' };
    }
  }
}

export const plugin = new DataSourcePlugin(InventoryDataSource);
