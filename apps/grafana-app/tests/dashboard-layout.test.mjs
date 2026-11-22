import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compileCloudWatchDashboards, loadCompiledCloudWatchDashboards } from '../../../deploy/scripts/build-cloudwatch-dashboards.mjs';

const root = new URL('../../../', import.meta.url);
const json = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const inv = { type: 'infrapulse-inventory-datasource', uid: 'infrapulse-inventory' };
const amp = { type: 'grafana-amazonprometheus-datasource', uid: 'infrapulse-amp' };
const fleetPath = 'dashboards/fleet.json';
const detailPath = 'dashboards/linux-host.json';
const windowsPath = 'dashboards/windows-host.json';

function dashboard(files, path) {
  assert.ok(Object.hasOwn(files, path), `missing ${path}`);
  return JSON.parse(files[path]);
}

function allPanels(panels) {
  const out = [];
  for (const p of panels) {
    out.push(p);
    if (Array.isArray(p.panels)) out.push(...allPanels(p.panels));
  }
  return out;
}

test('active release compiles fleet, Linux and Windows AMP dashboards, with a private-to-build manifest', async () => {
  const files = await loadCompiledCloudWatchDashboards();
  assert.deepEqual(Object.keys(files).sort(), [fleetPath, detailPath, windowsPath, 'manifest.json']);
  assert.equal(dashboard(files, fleetPath).uid, 'infrapulse-fleet');
  assert.equal(dashboard(files, detailPath).uid, 'infrapulse-linux-host');
  assert.equal(dashboard(files, windowsPath).uid, 'infrapulse-windows-host');
  const fleet = json('observability/grafana/dashboards/infrapulse/fleet.json');
  const offline = compileCloudWatchDashboards({ schemaVersion: 1, platforms: {} }, { fleet });
  assert.deepEqual(Object.keys(offline).sort(), [fleetPath, 'manifest.json']);
  assert.doesNotMatch(offline[fleetPath], /infrapulse-amp/);
});

test('fleet uses authorized inventory for KPI summary, health/OS charts and enriched VM table', async () => {
  const fleet = dashboard(await loadCompiledCloudWatchDashboards(), fleetPath);
  const stat = fleet.panels.find(panel => panel.type === 'stat');
  const pies = fleet.panels.filter(panel => panel.type === 'piechart');
  const table = fleet.panels.find(panel => panel.type === 'table');
  assert.equal(pies.length, 2);
  for (const [panel, view] of [[stat, 'summary'], [pies[0], 'by-status'], [pies[1], 'by-os'], [table, 'table']]) {
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

test('Linux and Windows detail dashboards isolate metrics by binding labels and filter VM dropdown by OS', async () => {
  const files = await loadCompiledCloudWatchDashboards();
  for (const [path, platform, expectedMetric] of [
    [detailPath, 'linux', 'node_cpu_seconds_total'],
    [windowsPath, 'windows', 'windows_cpu_time_total'],
  ]) {
    const detail = dashboard(files, path);
    const [select, binding] = detail.templating.list;
    assert.equal(detail.templating.list.length, 2);
    assert.equal(select.name, 'server_id');
    assert.equal(select.query, `vm-options ${platform}`);
    assert.equal(select.hide, 0);
    assert.equal(select.skipUrlSync, false);
    assert.deepEqual(select.datasource, inv);
    assert.equal(binding.name, 'binding');
    assert.equal(binding.query, 'binding $server_id');
    assert.deepEqual(binding.datasource, inv);
    assert.equal(binding.hide, 2);
    assert.equal(binding.skipUrlSync, true);
    assert.equal(binding.refresh, 2);
    assert.equal(detail.graphTooltip, 1);

    const flat = allPanels(detail.panels);
    const hostInfo = flat.find(p => p.type === 'table' && p.targets?.[0]?.operation === 'host-info');
    assert.ok(hostInfo, `${platform} missing host-info panel`);
    assert.deepEqual(hostInfo.datasource, inv);

    const ampPanels = flat.filter(p => p.datasource?.uid === amp.uid);
    assert.ok(ampPanels.length >= 15, `${platform} should have rich AMP panels`);
    const allExprs = ampPanels.flatMap(p => p.targets.map(t => t.expr));
    assert.ok(allExprs.some(e => e.includes(expectedMetric)), `${platform} missing ${expectedMetric}`);
    for (const panel of ampPanels) {
      assert.deepEqual(panel.datasource, amp);
      for (const target of panel.targets) {
        assert.deepEqual(target.datasource, amp);
        assert.match(target.expr, /server_id="\$\{binding\.server_id\}"/);
        assert.match(target.expr, /managed_node_id="\$\{binding\.managed_node_id\}"/);
        assert.match(target.expr, /enrollment_id="\$\{binding\.enrollment_id\}"/);
      }
    }
  }
});
