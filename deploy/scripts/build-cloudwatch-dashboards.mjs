import { mkdir, open, lstat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { decodeAgentRelease, releaseSha256 } from './agent-release.mjs';

const ROOT = new URL('../../', import.meta.url);
const OUT = 'deploy/generated/cloudwatch/';
const INPUT = 'observability/grafana/dashboards/infrapulse/';
const CW = { type: 'cloudwatch', uid: 'infrapulse-cloudwatch' };
const INVENTORY = { type: 'infrapulse-inventory-datasource', uid: 'infrapulse-inventory' };
const IDENTITY = { ServerId: 'server_id', ManagedNodeId: 'managed_node_id', EnrollmentId: 'enrollment_id' };
const fail = code => { throw Error(code); };
const binding = name => '${binding.' + name + '}';
const nativeProperty = (id, name) => `native_${Buffer.from(id, 'ascii').toString('hex')}_${Buffer.from(name, 'ascii').toString('hex')}`;
const encode = value => JSON.stringify(value, null, 2) + '\n';

function template(value, uid, format, platform) {
  const fields = platform ? 'description,format,platform,title,uid' : 'description,format,title,uid';
  if (!value || Object.keys(value).sort().join(',') !== fields || value.uid !== uid || value.format !== format
    || (platform && value.platform !== platform)
    || !['description', 'title'].every(k => typeof value[k] === 'string' && value[k].trim().length > 0 && value[k].length <= 512)) {
    fail('DASHBOARD_TEMPLATE_INVALID');
  }
  return value;
}

function dashboard(source, panels, variables = []) {
  const { uid, title, description } = source;
  return { id: null, uid, title, description, editable: false, schemaVersion: 39, version: 1,
    tags: ['InfraPulse'], timezone: 'browser', refresh: '60s', time: { from: 'now-1h', to: 'now' },
    templating: { list: variables }, annotations: { list: [] }, panels };
}

function fleetDashboard(source) {
  const query = view => ({ datasource: INVENTORY, refId: 'A', operation: 'fleet', view });
  const override = (name, ...properties) => ({ matcher: { id: 'byName', options: name }, properties });
  return dashboard(source, [
    { id: 1, type: 'stat', title: 'VM và trạng thái metrics', datasource: INVENTORY,
      description: 'Số lượng chỉ hiển thị khi inventory đọc đủ. Unknown không có nghĩa là Offline.',
      gridPos: { x: 0, y: 0, w: 24, h: 5 }, targets: [query('summary')],
      fieldConfig: { defaults: { noValue: 'Unavailable', unit: 'short', decimals: 0 }, overrides: [] },
      options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, graphMode: 'none', textMode: 'value_and_name' } },
    { id: 2, type: 'table', title: 'Danh sách VM', datasource: INVENTORY,
      description: 'Metrics mở chi tiết của VM có binding hiện hành; Setup mở trang đăng ký. Inventory thiếu sẽ có cảnh báo.',
      gridPos: { x: 0, y: 5, w: 24, h: 15 }, targets: [query('table')],
      fieldConfig: { defaults: { noValue: '—' }, overrides: [
        override('VM ID', { id: 'custom.hidden', value: true }),
        override('Path', { id: 'custom.hidden', value: true }),
        override('Open', { id: 'links', value: [{ title: '${__value.raw}', url: '${__data.fields["Path"]}&from=${__from}&to=${__to}' }] }),
      ] }, options: { showHeader: true } },
  ]);
}

function detailDashboard(source, linux) {
  const probes = [
    ['cpu_busy', 'cpu', 'cpu', 'usage_active', 'CPU'],
    ['memory_used', 'memory', 'mem', 'used_percent', 'RAM'],
    ['disk_used', 'disk', 'disk', 'used_percent', 'Root filesystem'],
    ['network_received', 'network', 'net', 'bytes_recv', 'RX'],
    ['network_sent', 'network', 'net', 'bytes_sent', 'TX'],
  ];
  const native = new Set();
  const manifest = [];
  const targets = probes.map(([key, group, pluginName, input, label], idx) => {
    const metric = linux.metrics.find(m => m.key === key);
    const percent = group !== 'network';
    const matches = linux.configuration.plugins.flatMap(p => p.measurements
      .filter(m => m.metricKeys.includes(key)).map(m => ({ plugin: p.plugin, input: m.input })));
    if (!metric || metric.group !== group || metric.unit !== (percent ? 'Percent' : 'Bytes/Second')
      || matches.length !== 1 || matches[0].plugin !== pluginName || matches[0].input !== input) fail('DASHBOARD_SEMANTICS_UNSUPPORTED');
    const dimensions = Object.fromEntries(metric.dimensions.map(({ name }) => {
      if (Object.hasOwn(IDENTITY, name)) return [name, binding(IDENTITY[name])];
      if (!metric.resourceId) fail('DASHBOARD_SEMANTICS_UNSUPPORTED');
      const property = nativeProperty(metric.resourceId, name);
      native.add(property);
      return [name, binding(property)];
    }));
    if (!Object.keys(IDENTITY).every(key => Object.hasOwn(dimensions, key))) fail('DASHBOARD_SEMANTICS_UNSUPPORTED');
    manifest.push({ ...metric, nativeInput: matches[0], conversion: 'identity' });
    return { datasource: CW, refId: idx === 4 ? 'B' : 'A', id: idx === 4 ? 'm1' : 'm0', queryMode: 'Metrics', metricQueryType: 0,
      metricEditorMode: 0, region: 'ap-southeast-1', namespace: metric.namespace, metricName: metric.metricName,
      dimensions, matchExact: true, period: String(metric.periodSeconds), statistic: metric.statistic, label, hide: false };
  });
  if (!native.size) fail('DASHBOARD_SEMANTICS_UNSUPPORTED');
  const config = (percent, noValue, custom) => ({ defaults: { unit: percent ? 'percent' : 'none', noValue,
    ...(percent ? { min: 0, max: 100 } : {}), ...(custom ? { custom } : {}) }, overrides: [] });
  const trimToRecent = { id: 'filterByValue', options: { type: 'include', match: 'all', filters: [
    { fieldName: 'Time', config: { id: 'greaterOrEqual', options: { value: binding('recent_after_ms') } } },
    { fieldName: 'Time', config: { id: 'lowerOrEqual', options: { value: binding('recent_through_ms') } } },
  ] } };
  const latest = targets.slice(0, 3).map((target, i) => ({ id: i + 1, title: `${target.label} · Mẫu mới`, type: 'stat', datasource: CW,
    description: 'Chỉ hiển thị mẫu trong 5 phút gần nhất; không coi dữ liệu cũ hoặc thiếu là 0.',
    gridPos: { x: i * 8, y: 0, w: 8, h: 5 }, targets: [target], transformations: [trimToRecent],
    fieldConfig: config(true, 'No recent sample'),
    options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, graphMode: 'none', textMode: 'value' } }));
  const networkNotice = 'Đọc metric/statistic đúng release. Đơn vị Bytes/Second chưa xác minh độc lập; không quy đổi hay gắn nhãn B/s.';
  const series = [...targets.slice(0, 3).map(t => [t]), targets.slice(3)].map((group, i) => ({ id: i + 4,
    title: i === 3 ? 'Network RX / TX' : group[0].label, type: 'timeseries', datasource: CW,
    description: i === 3 ? networkNotice : 'Chỉ truy vấn binding hiện hành; dữ liệu thiếu được giữ thành khoảng trống.',
    gridPos: { x: (i % 2) * 12, y: 5 + Math.floor(i / 2) * 8, w: 12, h: 8 }, targets: group,
    fieldConfig: config(i !== 3, 'No data', { spanNulls: false, stacking: { mode: 'none', group: 'A' } }),
    options: { legend: { displayMode: 'list', placement: 'bottom', calcs: [] }, tooltip: { mode: 'multi' } } }));
  const query = (name, value, hide, refresh, skipUrlSync, label = name) => ({ name, label, type: 'query', datasource: INVENTORY,
    query: value, definition: value, hide, refresh, skipUrlSync, options: [], multi: false, includeAll: false });
  const variables = [query('server_id', 'vm-options', 0, 1, false, 'VM'),
    query('binding', `binding $server_id ${[...native].sort().join(',')}`, 2, 2, true)];
  return { result: dashboard(source, [...latest, ...series], variables), metrics: manifest };
}

/** Deterministic; released query identity/statistic/period come only from the canonical decoder. */
export function compileCloudWatchDashboards(value, templates) {
  const release = decodeAgentRelease(value);
  const fleetSource = template(templates?.fleet, 'infrapulse-fleet', 'infrapulse-inventory-template-v1');
  const fleet = fleetDashboard(fleetSource);
  const files = { 'dashboards/fleet.json': encode(fleet) };
  const entries = [{ uid: fleet.uid, templateHash: releaseSha256(fleetSource), dashboardHash: releaseSha256(fleet) }];
  const linux = release.platforms.linux;
  if (linux) {
    const detailSource = template(templates?.linux, 'infrapulse-linux-host', 'infrapulse-cloudwatch-template-v2', 'linux');
    const { result, metrics } = detailDashboard(detailSource, linux);
    files['dashboards/linux-host.json'] = encode(result);
    entries.push({ platform: 'linux', uid: result.uid, presetId: 'linux', presetVersion: linux.parameter.version,
      presetHash: linux.parameter.sha256, templateHash: releaseSha256(detailSource), dashboardHash: releaseSha256(result), metrics });
  }
  if (entries.some(({ uid }) => Buffer.byteLength(files[uid === fleet.uid ? 'dashboards/fleet.json' : 'dashboards/linux-host.json']) > 2097152)) fail('DASHBOARD_TOO_LARGE');
  files['manifest.json'] = encode({ format: 'infrapulse-cloudwatch-generation-v2', releaseHash: releaseSha256(release), entries });
  return files;
}

export async function loadCompiledCloudWatchDashboards() {
  const { readPublicJson, readBuildRelease } = await import('./build-inputs.mjs');
  const release = await readBuildRelease();
  const templates = { fleet: await readPublicJson(INPUT + 'fleet.json') };
  if (release.platforms.linux) templates.linux = await readPublicJson(INPUT + 'linux-host.json');
  return compileCloudWatchDashboards(release, templates);
}

// All inputs compile before output side effects; existing outputs are never silently replaced.
export async function runCli(args) {
  if (args.length !== 1 || !['--check', '--write'].includes(args[0])) return { exit: 2, value: { ok: false, issues: ['CLI_USAGE'] } };
  try {
    const files = await loadCompiledCloudWatchDashboards();
    if (args[0] === '--write') {
      for (const [name, text] of Object.entries(files)) {
        const url = new URL(OUT + name, ROOT);
        let info;
        try { info = await lstat(url); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (info) {
          if (!info.isFile() || info.isSymbolicLink() || info.size !== Buffer.byteLength(text)) fail('DASHBOARD_OUTPUT_CONFLICT');
          const handle = await open(url, 'r');
          try { if (await handle.readFile('utf8') !== text) fail('DASHBOARD_OUTPUT_CONFLICT'); } finally { await handle.close(); }
        }
      }
      await mkdir(new URL(OUT + 'dashboards/', ROOT), { recursive: true });
      for (const [name, text] of Object.entries(files)) {
        let handle;
        try { handle = await open(new URL(OUT + name, ROOT), 'wx', 0o644); await handle.writeFile(text, 'utf8'); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const url = new URL(OUT + name, ROOT), info = await lstat(url);
          if (!info.isFile() || info.isSymbolicLink() || info.size !== Buffer.byteLength(text)) fail('DASHBOARD_OUTPUT_CONFLICT');
          handle = await open(url, 'r');
          if (await handle.readFile('utf8') !== text) fail('DASHBOARD_OUTPUT_CONFLICT');
        }
        finally { if (handle) await handle.close(); }
      }
    }
    return { exit: 0, value: { ok: true, issues: [], files: Object.keys(files) } };
  } catch (error) {
    const codes = ['DASHBOARD_TEMPLATE_INVALID', 'DASHBOARD_SEMANTICS_UNSUPPORTED', 'DASHBOARD_TOO_LARGE', 'DASHBOARD_OUTPUT_CONFLICT'];
    return { exit: 1, value: { ok: false, issues: [codes.includes(error?.message) ? error.message : 'DASHBOARD_INPUT_UNAVAILABLE'] } };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2)).then(({ exit, value }) => {
    console.log(JSON.stringify(value)); process.exitCode = exit;
  }).catch(() => {
    console.log(JSON.stringify({ ok: false, issues: ['DASHBOARD_INPUT_UNAVAILABLE'] })); process.exitCode = 1;
  });
}
