import { DataSourceApi, DataSourcePlugin, FieldType } from '@grafana/data';
import type { DataQuery, DataQueryRequest, DataQueryResponse, LegacyMetricFindQueryOptions, MetricFindValue } from '@grafana/data';
import { getTemplateSrv } from '@grafana/runtime';
import { api } from '../api/client';
import { listFleet, readBinding, vmOptionsForQuery } from '../api/inventory';
import { vmMetricsHref, vmsHref } from '../api/vm-routes';

interface InventoryQuery extends DataQuery {
  operation: 'fleet';
  view: 'table' | 'summary';
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
    const prefix = 'binding $server_id ';
    if (typeof query !== 'string' || query.length > 32768 || !query.startsWith(prefix)) {
      return [];
    }
    const subset = query.slice(prefix.length);
    if (!nativeKeys.test(subset)) {
      return [];
    }
    const required = [...identityKeys, ...new Set(subset.split(','))];
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
    const targets = request.targets.filter((target) => !target.hide && target.operation === 'fleet' && ['table', 'summary'].includes(target.view));
    if (!targets.length) {
      return { data: [] };
    }
    const snapshot = await listFleet(api.servers);
    const { rows, partial } = snapshot;
    const meta = partial ? { notices: [{ severity: 'warning' as const, text: 'Partial inventory. Totals are unavailable.' }] } : undefined;
    const data = targets.map(({ refId, view }) => view === 'summary' ? {
        refId, meta, fields: [
          { name: 'VMs', type: FieldType.number, values: [partial ? null : rows.length] },
          ...statusFields.map((status) => ({ name: status, type: FieldType.number,
            values: [partial ? null : rows.filter((row) => row.health === status).length] })),
        ], length: 1,
      } : {
        refId, meta, length: rows.length, fields: [
          { name: 'VM', type: FieldType.string, values: rows.map((row) => row.name) },
          { name: 'Environment', type: FieldType.string, values: rows.map((row) => row.environment) },
          { name: 'Status', type: FieldType.string, values: rows.map((row) => row.health) },
          { name: 'Last sample', type: FieldType.time, values: rows.map((row) => row.lastSampleAt === null ? null : Date.parse(row.lastSampleAt)) },
          { name: 'VM ID', type: FieldType.string, values: rows.map((row) => row.serverId) },
          { name: 'Open', type: FieldType.string, values: rows.map((row) => row.canOpenMetrics ? 'Metrics' : 'Setup') },
          { name: 'Path', type: FieldType.string, values: rows.map((row) => row.canOpenMetrics
            ? vmMetricsHref(row.serverId, row.platform) : vmsHref(row.serverId)) },
        ],
      });
    // Scenes only applies overrides to fields that carry a FieldConfig object.
    return { data: data.map((frame) => ({ ...frame, fields: frame.fields.map((field) => ({ ...field, config: {} })) })) };
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
