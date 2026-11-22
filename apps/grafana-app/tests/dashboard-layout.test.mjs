import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compileCloudWatchDashboards, loadCompiledCloudWatchDashboards } from '../../../deploy/scripts/build-cloudwatch-dashboards.mjs';

const root = new URL('../../../', import.meta.url);
const json = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const inv = { type: 'infrapulse-inventory-datasource', uid: 'infrapulse-inventory' };
const cloud = { type: 'cloudwatch', uid: 'infrapulse-cloudwatch' };
const release = json('deploy/agent-release.json');
const fleetPath = 'dashboards/fleet.json';
const detailPath = 'dashboards/linux-host.json';
const windowsPath = 'dashboards/windows-host.json';

function dashboard(files, path) {
  assert.ok(Object.hasOwn(files, path), `missing ${path}`);
  return JSON.parse(files[path]);
}

test('active release compiles fleet, Linux and Windows detail dashboards, with a private-to-build manifest', async () => {
  const files = await loadCompiledCloudWatchDashboards();
  assert.deepEqual(Object.keys(files).sort(), [fleetPath, detailPath, windowsPath, 'manifest.json']);
  assert.equal(dashboard(files, fleetPath).uid, 'infrapulse-fleet');
  assert.equal(dashboard(files, detailPath).uid, 'infrapulse-linux-host');
  assert.equal(dashboard(files, windowsPath).uid, 'infrapulse-windows-host');
  const fleet = json('observability/grafana/dashboards/infrapulse/fleet.json');
  const offline = compileCloudWatchDashboards({ schemaVersion: 1, platforms: {} }, { fleet });
  assert.deepEqual(Object.keys(offline).sort(), [fleetPath, 'manifest.json']);
  assert.doesNotMatch(offline[fleetPath], /infrapulse-cloudwatch/);
});

test('fleet uses authorized inventory for summary and table; the drilldown keeps the selected time range', async () => {
  const fleet = dashboard(await loadCompiledCloudWatchDashboards(), fleetPath);
  const stat = fleet.panels.find(panel => panel.type === 'stat');
  const table = fleet.panels.find(panel => panel.type === 'table');
  for (const [panel, view] of [[stat, 'summary'], [table, 'table']]) {
    assert.deepEqual(panel.datasource, inv);
    assert.deepEqual(panel.targets.map(target => [target.operation, target.view]), [['fleet', view]]);
  }
  assert.equal(stat.fieldConfig.defaults.noValue, 'Unavailable');
  const overrides = table.fieldConfig.overrides;
  const open = overrides.find(o => o.matcher.options === 'Open');
  assert.deepEqual(open.properties.find(p => p.id === 'links').value.map(x => x.url), [
    '${__data.fields["Path"]}&from=${__from}&to=${__to}',
  ]);
  for (const field of ['VM ID', 'Path']) {
    assert.ok(overrides.find(o => o.matcher.options === field).properties.some(p => p.id === 'custom.hidden' && p.value === true));
  }
});

test('detail interpolates only a fresh closed binding and uses exact canonical Linux metrics', async () => {
  const detail = dashboard(await loadCompiledCloudWatchDashboards(), detailPath);
  const [select, binding] = detail.templating.list;
  assert.equal(detail.templating.list.length, 2);
  assert.equal(select.name, 'server_id');
  assert.equal(select.query, 'vm-options linux');
  assert.equal(select.hide, 0);
  assert.equal(select.skipUrlSync, false);
  assert.deepEqual(select.datasource, inv);
  assert.equal(binding.name, 'binding');
  assert.deepEqual(binding.datasource, inv);
  assert.equal(binding.hide, 2);
  assert.equal(binding.skipUrlSync, true);
  assert.equal(binding.refresh, 2);
  for (const v of [select, binding]) {
    assert.equal(v.multi, false);
    assert.equal(v.includeAll, false);
  }

  const stats = detail.panels.filter(panel => panel.type === 'stat');
  const series = detail.panels.filter(panel => panel.type === 'timeseries');
  assert.equal(stats.length, 3);
  assert.equal(series.length, 4);
  assert.deepEqual(stats.flatMap(p => p.targets.map(t => t.metricName)), ['cpu_usage_active', 'mem_used_percent', 'disk_used_percent']);
  assert.deepEqual(series.map(p => p.targets.map(t => t.metricName)), [
    ['cpu_usage_active'], ['mem_used_percent'], ['disk_used_percent'], ['net_bytes_recv', 'net_bytes_sent'],
  ]);
  const native = new Set();
  for (const panel of [...stats, ...series]) {
    assert.deepEqual(panel.datasource, cloud);
    for (const target of panel.targets) {
      const metric = release.platforms.linux.metrics.find(m => m.metricName === target.metricName);
      assert.ok(metric);
      assert.deepEqual(target.datasource, cloud);
      assert.equal(target.region, 'ap-southeast-1');
      assert.equal(target.namespace, metric.namespace);
      assert.equal(target.statistic, metric.statistic);
      assert.equal(target.period, String(metric.periodSeconds));
      assert.equal(target.matchExact, true);
      const identity = { ServerId: 'server_id', ManagedNodeId: 'managed_node_id', EnrollmentId: 'enrollment_id' };
      const expected = Object.fromEntries(metric.dimensions.map(({ name }) => {
        const prop = identity[name] ?? `native_${Buffer.from(metric.resourceId).toString('hex')}_${Buffer.from(name).toString('hex')}`;
        if (!identity[name]) native.add(prop);
        return [name, '${binding.' + prop + '}'];
      }));
      assert.deepEqual(target.dimensions, expected);
      assert.equal(target.expression, undefined);
    }
  }
  assert.deepEqual(binding.query.split(' '), ['binding', '$server_id', [...native].sort().join(',')]);
  for (const panel of stats) {
    assert.equal(panel.fieldConfig.defaults.unit, 'percent');
    assert.equal(panel.fieldConfig.defaults.noValue, 'No recent sample');
    assert.equal(panel.options.reduceOptions.calcs[0], 'lastNotNull');
    assert.equal(panel.transformations[0].id, 'filterByValue');
    assert.deepEqual(panel.transformations[0].options.filters.map(f => f.config.options.value), [
      '${binding.recent_after_ms}', '${binding.recent_through_ms}',
    ]);
  }
  assert.ok(series.every(p => p.fieldConfig.defaults.custom.spanNulls === false));
  assert.equal(series.at(-1).fieldConfig.defaults.unit, 'none');
  assert.match(series.at(-1).description, /Bytes\/Second.*chưa xác minh/i);

  const windowsDetail = dashboard(await loadCompiledCloudWatchDashboards(), windowsPath);
  const [winSelect] = windowsDetail.templating.list;
  assert.equal(winSelect.query, 'vm-options windows');
  const winDiskStat = windowsDetail.panels.find(p => p.type === 'stat' && p.targets[0].metricName === 'win_disk_free_percent');
  assert.deepEqual(winDiskStat.fieldConfig.defaults.thresholds, {
    mode: 'absolute',
    steps: [{ color: 'red', value: null }, { color: 'orange', value: 15 }, { color: 'green', value: 30 }],
  });
});
