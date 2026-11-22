import { mkdir, open, lstat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { decodeAgentRelease, releaseSha256 } from './agent-release.mjs';

const ROOT = new URL('../../', import.meta.url);
const OUT = 'deploy/generated/cloudwatch/';
const INPUT = 'observability/grafana/dashboards/infrapulse/';
const AMP = { type: 'grafana-amazonprometheus-datasource', uid: 'infrapulse-amp' };
const INVENTORY = { type: 'infrapulse-inventory-datasource', uid: 'infrapulse-inventory' };
const fail = code => { throw Error(code); };
const encode = value => JSON.stringify(value, null, 2) + '\n';
const SEL = 'server_id="${binding.server_id}",managed_node_id="${binding.managed_node_id}",enrollment_id="${binding.enrollment_id}"';

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
  return {
    id: null, uid, title, description, editable: false, schemaVersion: 41, version: 6,
    graphTooltip: 1, tags: ['InfraPulse', 'AMP'], timezone: 'browser', refresh: '60s',
    time: { from: 'now-1h', to: 'now' },
    templating: { list: variables }, annotations: { list: [] }, panels,
  };
}

const override = (name, ...properties) => ({ matcher: { id: 'byName', options: name }, properties });
const regexOverride = (pattern, ...properties) => ({ matcher: { id: 'byRegexp', options: pattern }, properties });
const fixedColor = color => ({ id: 'color', value: { mode: 'fixed', fixedColor: color } });
const negY = { id: 'custom.transform', value: 'negative-Y' };
const naMapping = [{ type: 'special', options: { match: 'null', result: { text: 'N/A' } } }];
const statusMappings = [{
  type: 'value',
  options: {
    Fresh: { color: 'green', index: 0 },
    Stale: { color: 'orange', index: 1 },
    Offline: { color: 'red', index: 2 },
    Unknown: { color: 'text', index: 3 },
    Online: { color: 'green', index: 4 },
    ConnectionLost: { color: 'red', index: 5 },
    Inactive: { color: 'orange', index: 6 },
    Linux: { color: 'blue', index: 7 },
    Windows: { color: 'purple', index: 8 },
  },
}];
const badgeCell = { id: 'custom.cellOptions', value: { type: 'color-background', mode: 'basic' } };
const rowPanel = (id, title, y, collapsed = false, panels = []) => ({
  id, type: 'row', title, collapsed, gridPos: { x: 0, y, w: 24, h: 1 }, panels,
});
const prom = (refId, expr, legendFormat = '', instant = false, extra = {}) => ({
  datasource: AMP, refId, expr, legendFormat, range: !instant, instant, interval: '60s', editorMode: 'code', ...extra,
});
const containerStateMappings = [{
  type: 'value',
  options: {
    running: { text: 'Running', color: 'green', index: 0 },
    restarting: { text: 'Restarting', color: 'orange', index: 1 },
    exited: { text: 'Exited', color: 'red', index: 2 },
    paused: { text: 'Paused', color: 'yellow', index: 3 },
    dead: { text: 'Dead', color: 'red', index: 4 },
    created: { text: 'Created', color: 'blue', index: 5 },
  },
}];
const containerHealthMappings = [{
  type: 'value',
  options: {
    healthy: { text: 'Healthy', color: 'green', index: 0 },
    unhealthy: { text: 'Unhealthy', color: 'red', index: 1 },
    starting: { text: 'Starting', color: 'orange', index: 2 },
    none: { text: 'None', color: 'semi-dark-blue', index: 3 },
  },
}];
const stateCodeMappings = [{
  type: 'value',
  options: {
    '1': { text: 'Running', color: 'green', index: 0 },
    '2': { text: 'Restarting', color: 'orange', index: 1 },
    '3': { text: 'Paused', color: 'yellow', index: 2 },
    '0': { text: 'Exited', color: 'red', index: 3 },
    '4': { text: 'Dead', color: 'red', index: 4 },
    '5': { text: 'Created', color: 'blue', index: 5 },
  },
}];
const healthCodeMappings = [{
  type: 'value',
  options: {
    '1': { text: 'Healthy', color: 'green', index: 0 },
    '2': { text: 'Unhealthy', color: 'red', index: 1 },
    '3': { text: 'Starting', color: 'orange', index: 2 },
    '0': { text: 'None', color: 'semi-dark-blue', index: 3 },
  },
}];
const oomCodeMappings = [{
  type: 'value',
  options: {
    '0': { text: 'OK', color: 'green', index: 0 },
    '1': { text: 'OOMKilled', color: 'red', index: 1 },
  },
}];
const unlimitedZeroMapping = [
  { type: 'value', options: { '0': { text: 'Unlimited', index: 0 } } },
  { type: 'special', options: { match: 'null', result: { text: '—' } } },
];
const thresholdsOf = (steps, mode = 'absolute') => ({ mode, steps });

function tsPanel(id, title, gridPos, targets, {
  unit = 'short', min, max, fillOpacity = 40, lineWidth = 1, interpolation = 'linear',
  stacking = 'none', overrides = [], legend = { displayMode: 'list', placement: 'bottom', calcs: [], showLegend: true },
  description,
} = {}) {
  return {
    id, type: 'timeseries', title, datasource: AMP, gridPos, targets,
    ...(description ? { description } : {}),
    fieldConfig: {
      defaults: {
        color: { mode: 'palette-classic' },
        unit,
        ...(min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
        custom: {
          drawStyle: 'line', lineInterpolation: interpolation, lineWidth, fillOpacity,
          gradientMode: 'none', spanNulls: false, showPoints: 'never',
          stacking: { mode: stacking, group: 'A' },
        },
      },
      overrides,
    },
    options: {
      legend,
      tooltip: { mode: 'multi', sort: 'desc' },
    },
  };
}

function nefGauge(id, title, gridPos, expr, warn, crit, { unit = 'percent', decimals = 1, max = 100 } = {}) {
  return {
    id, type: 'gauge', title, datasource: AMP, gridPos,
    targets: [prom('A', expr, '', true)],
    fieldConfig: {
      defaults: {
        color: { mode: 'thresholds' }, unit, decimals, min: 0, max, mappings: naMapping,
        thresholds: thresholdsOf([{ color: 'dark-green', value: null }, { color: 'orange', value: warn }, { color: 'red', value: crit }]),
      },
      overrides: [],
    },
    options: {
      minVizHeight: 75, minVizWidth: 75, orientation: 'auto', sizing: 'auto',
      reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      showThresholdLabels: false, showThresholdMarkers: true,
    },
  };
}

function nefStat(id, displayName, gridPos, expr, { unit = 'short', decimals = 0 } = {}) {
  return {
    id, type: 'stat', title: '', datasource: AMP, gridPos,
    targets: [prom('A', expr, '__auto', true)],
    fieldConfig: {
      defaults: {
        displayName, unit, decimals, mappings: naMapping,
        color: { mode: 'thresholds' },
        thresholds: thresholdsOf([{ color: 'green', value: null }]),
      },
      overrides: [],
    },
    options: {
      colorMode: 'none', graphMode: 'none', justifyMode: 'center', orientation: 'horizontal',
      textMode: 'value_and_name', wideLayout: false,
      text: { titleSize: 12, valueSize: 20 },
      reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
    },
  };
}

function wedGauge(id, title, gridPos, expr, {
  unit = 'percent', min = 0, max = 100, warn = 80, crit = 90, decimals = 1,
} = {}) {
  return {
    id, type: 'gauge', title, datasource: AMP, gridPos,
    targets: [prom('A', expr, '', true)],
    fieldConfig: {
      defaults: {
        color: { mode: 'thresholds' }, unit, decimals, min, max, mappings: naMapping,
        thresholds: thresholdsOf([
          { color: '#299c46', value: null },
          { color: 'rgba(237, 129, 40, 0.89)', value: warn },
          { color: '#d44a3a', value: crit },
        ]),
      },
      overrides: [],
    },
    options: {
      minVizHeight: 75, minVizWidth: 75, orientation: 'auto', sizing: 'auto',
      reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      showThresholdLabels: false, showThresholdMarkers: true,
    },
  };
}

function wedSideStat(id, displayName, gridPos, expr, { unit = 'short', decimals } = {}) {
  return {
    id, type: 'stat', title: '', datasource: AMP, gridPos,
    targets: [prom('A', expr, '__auto', true)],
    fieldConfig: {
      defaults: {
        displayName, unit, mappings: naMapping,
        ...(decimals !== undefined ? { decimals } : {}),
        color: { mode: 'fixed', fixedColor: 'text' },
        thresholds: thresholdsOf([{ color: 'text', value: null }]),
      },
      overrides: [],
    },
    options: {
      colorMode: 'none', graphMode: 'none', justifyMode: 'center', orientation: 'horizontal',
      textMode: 'value_and_name', wideLayout: false,
      text: { titleSize: 12, valueSize: 20 },
      reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
    },
  };
}

const hostInfoPanels = (tableId, statusId, y) => [
  {
    id: tableId, type: 'table', title: 'Thông tin máy chủ', datasource: INVENTORY,
    gridPos: { x: 0, y, w: 14, h: 7 },
    targets: [{ datasource: INVENTORY, refId: 'A', operation: 'host-info', serverId: '${server_id}' }],
    transformations: [
      {
        id: 'organize',
        options: {
          excludeByName: { OS: true, SSM: true, Alloy: true, Metrics: true },
          indexByName: { VM: 0, 'OS Version': 1, Hostname: 2, IP: 3, 'Managed Node': 4 },
        },
      },
      {
        id: 'transpose',
        options: { firstFieldName: 'VM', emptyFieldName: 'Giá trị' },
      },
    ],
    fieldConfig: {
      defaults: { noValue: '—', custom: { align: 'left' } },
      overrides: [
        override('VM', { id: 'custom.width', value: 140 }),
        override('Field', { id: 'custom.width', value: 140 }),
      ],
    },
    options: { showHeader: true, cellHeight: 'sm', footer: { show: false } },
  },
  {
    id: statusId, type: 'stat', title: 'Trạng thái Agent & Metrics', datasource: INVENTORY,
    gridPos: { x: 14, y, w: 10, h: 7 },
    targets: [{ datasource: INVENTORY, refId: 'A', operation: 'host-info', serverId: '${server_id}' }],
    fieldConfig: {
      defaults: {
        noValue: '—',
        mappings: statusMappings,
        color: { mode: 'fixed', fixedColor: 'semi-dark-blue' },
      },
      overrides: [
        override('OS', { id: 'color', value: { mode: 'thresholds' } }, { id: 'mappings', value: statusMappings }),
        override('SSM', { id: 'color', value: { mode: 'thresholds' } }, { id: 'mappings', value: statusMappings }),
        override('Metrics', { id: 'color', value: { mode: 'thresholds' } }, { id: 'mappings', value: statusMappings }),
        override('Alloy', fixedColor('semi-dark-blue')),
      ],
    },
    options: {
      reduceOptions: { calcs: ['lastNotNull'], fields: '/^(OS|SSM|Alloy|Metrics)$/', values: false },
      colorMode: 'background_solid', graphMode: 'none', justifyMode: 'center', orientation: 'auto',
      textMode: 'value_and_name', wideLayout: false,
      text: { titleSize: 12, valueSize: 18 },
    },
  },
];

function fleetDashboard(source) {
  const query = view => ({ datasource: INVENTORY, refId: 'A', operation: 'fleet', view });
  return dashboard(source, [
    {
      id: 1, type: 'stat', title: 'Tổng quan trạng thái VM', datasource: INVENTORY,
      description: 'Số lượng chỉ hiển thị khi inventory đọc đủ. Unknown không có nghĩa là Offline.',
      gridPos: { x: 0, y: 0, w: 14, h: 6 }, targets: [query('summary')],
      fieldConfig: {
        defaults: { noValue: 'Unavailable', unit: 'short', decimals: 0 },
        overrides: [
          override('VMs', fixedColor('semi-dark-blue')),
          override('Fresh', fixedColor('semi-dark-green')),
          override('Stale', fixedColor('semi-dark-orange')),
          override('Offline', fixedColor('semi-dark-red')),
          override('Unknown', fixedColor('text')),
        ],
      },
      options: {
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
        colorMode: 'background_solid', graphMode: 'none', textMode: 'value_and_name', orientation: 'horizontal',
      },
    },
    {
      id: 2, type: 'piechart', title: 'Tỉ lệ sức khỏe metrics', datasource: INVENTORY,
      gridPos: { x: 14, y: 0, w: 5, h: 6 }, targets: [query('by-status')],
      fieldConfig: {
        defaults: { unit: 'short', decimals: 0 },
        overrides: [
          override('Fresh', fixedColor('green')),
          override('Stale', fixedColor('orange')),
          override('Offline', fixedColor('red')),
          override('Unknown', fixedColor('text')),
        ],
      },
      options: {
        pieType: 'donut', reduceOptions: { calcs: ['lastNotNull'], fields: '', values: true },
        legend: { displayMode: 'list', placement: 'bottom', values: ['value'] },
        tooltip: { mode: 'single' },
      },
    },
    {
      id: 3, type: 'piechart', title: 'Phân bố hệ điều hành', datasource: INVENTORY,
      gridPos: { x: 19, y: 0, w: 5, h: 6 }, targets: [query('by-os')],
      fieldConfig: {
        defaults: { unit: 'short', decimals: 0 },
        overrides: [
          override('Linux', fixedColor('blue')),
          override('Windows', fixedColor('purple')),
        ],
      },
      options: {
        pieType: 'donut', reduceOptions: { calcs: ['lastNotNull'], fields: '', values: true },
        legend: { displayMode: 'list', placement: 'bottom', values: ['value'] },
        tooltip: { mode: 'single' },
      },
    },
    {
      id: 4, type: 'table', title: 'Danh sách VM', datasource: INVENTORY,
      description: 'Metrics mở chi tiết của VM đúng theo hệ điều hành; Setup mở trang đăng ký.',
      gridPos: { x: 0, y: 6, w: 24, h: 16 }, targets: [query('table')],
      fieldConfig: {
        defaults: { noValue: '—', custom: { filterable: true } },
        overrides: [
          override('OS', { id: 'mappings', value: statusMappings }, badgeCell, { id: 'custom.width', value: 100 }),
          override('Status', { id: 'mappings', value: statusMappings }, badgeCell, { id: 'custom.width', value: 105 }),
          override('SSM', { id: 'mappings', value: statusMappings }, badgeCell, { id: 'custom.width', value: 115 }),
          override('VM ID', { id: 'custom.hidden', value: true }),
          override('Path', { id: 'custom.hidden', value: true }),
          override('Open', { id: 'links', value: [{ title: '${__value.raw}', url: '${__data.fields["Path"]}&from=${__from}&to=${__to}' }] }, { id: 'custom.width', value: 90 }),
        ],
      },
      options: { showHeader: true, cellHeight: 'md', sortBy: [{ displayName: 'VM', desc: false }] },
    },
  ]);
}

function detailVariables(platform) {
  const query = (name, value, hide, refresh, skipUrlSync, label = name) => ({
    name, label, type: 'query', datasource: INVENTORY,
    query: value, definition: value, hide, refresh, skipUrlSync, options: [], multi: false, includeAll: false,
  });
  return [
    query('server_id', `vm-options ${platform}`, 0, 1, false, 'VM'),
    query('binding', 'binding $server_id', 2, 2, true),
  ];
}

/** Faithful port of Node Exporter Full (rev 46) mapped to InfraPulse AMP binding labels. */
function linuxDashboard(source, targetRelease) {
  const coresExpr = `count(count(node_cpu_seconds_total{${SEL}}) by (cpu))`;
  const nefTableLegend = { displayMode: 'table', placement: 'bottom', calcs: ['min', 'mean', 'max'], showLegend: true };
  const nefListLegend = { displayMode: 'list', placement: 'bottom', calcs: [], showLegend: true };

  const panels = [
    ...hostInfoPanels(1, 2, 0),

    // Row 1: Quick CPU / Mem / Disk (Node Exporter Full styling, spacious w=4 cards for zero truncation)
    rowPanel(261, 'Quick CPU / Mem / Disk', 7),
    {
      id: 323, type: 'bargauge', title: 'Pressure', datasource: AMP,
      gridPos: { x: 0, y: 8, w: 4, h: 5 },
      targets: [
        prom('A', `rate(node_pressure_cpu_waiting_seconds_total{${SEL}}[3m])`, 'CPU', true),
        prom('B', `rate(node_pressure_memory_waiting_seconds_total{${SEL}}[3m])`, 'Mem', true),
        prom('C', `rate(node_pressure_io_waiting_seconds_total{${SEL}}[3m])`, 'I/O', true),
      ],
      fieldConfig: {
        defaults: {
          color: { mode: 'thresholds' }, decimals: 1, min: 0, max: 1, unit: 'percentunit',
          thresholds: thresholdsOf([{ color: 'green', value: null }, { color: 'dark-yellow', value: 70 }, { color: 'dark-red', value: 90 }], 'percentage'),
        },
        overrides: [],
      },
      options: {
        displayMode: 'basic', orientation: 'horizontal', showUnfilled: true, valueMode: 'color', namePlacement: 'auto',
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      },
    },
    nefGauge(20, 'CPU Busy', { x: 4, y: 8, w: 4, h: 5 }, `100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle",${SEL}}[3m])))`, 85, 95),
    nefGauge(155, 'Sys Load', { x: 8, y: 8, w: 4, h: 5 }, `scalar(node_load1{${SEL}}) * 100 / ${coresExpr}`, 85, 95),
    nefGauge(16, 'RAM Used', { x: 12, y: 8, w: 4, h: 5 }, `clamp_min((1 - (node_memory_MemAvailable_bytes{${SEL}} / node_memory_MemTotal_bytes{${SEL}})) * 100, 0)`, 80, 90),
    nefGauge(21, 'SWAP Used', { x: 16, y: 8, w: 4, h: 5 }, `((node_memory_SwapTotal_bytes{${SEL}} - node_memory_SwapFree_bytes{${SEL}}) / clamp_min(node_memory_SwapTotal_bytes{${SEL}}, 1)) * 100`, 50, 80),
    nefGauge(154, 'Root FS Used', { x: 20, y: 8, w: 4, h: 5 }, `((node_filesystem_size_bytes{${SEL},mountpoint="/",fstype!="rootfs"} - node_filesystem_avail_bytes{${SEL},mountpoint="/",fstype!="rootfs"}) / node_filesystem_size_bytes{${SEL},mountpoint="/",fstype!="rootfs"}) * 100`, 80, 90),
    nefStat(14, 'CPU Cores', { x: 0, y: 13, w: 4, h: 2 }, coresExpr, { unit: 'short', decimals: 0 }),
    nefStat(75, 'RAM Total', { x: 4, y: 13, w: 5, h: 2 }, `node_memory_MemTotal_bytes{${SEL}}`, { unit: 'bytes', decimals: 0 }),
    nefStat(18, 'SWAP Total', { x: 9, y: 13, w: 5, h: 2 }, `node_memory_SwapTotal_bytes{${SEL}}`, { unit: 'bytes', decimals: 0 }),
    nefStat(23, 'RootFS Total', { x: 14, y: 13, w: 5, h: 2 }, `node_filesystem_size_bytes{${SEL},mountpoint="/",fstype!="rootfs"}`, { unit: 'bytes', decimals: 0 }),
    nefStat(15, 'Uptime', { x: 19, y: 13, w: 5, h: 2 }, `node_time_seconds{${SEL}} - node_boot_time_seconds{${SEL}}`, { unit: 's', decimals: 1 }),

    // Row 2: Basic CPU / Mem / Net / Disk (exact Node Exporter Full colors, stacking & list legends)
    rowPanel(263, 'Basic CPU / Mem / Net / Disk', 15),
    tsPanel(77, 'CPU Basic', { x: 0, y: 16, w: 12, h: 8 }, [
      prom('A', `avg(rate(node_cpu_seconds_total{${SEL},mode="system"}[3m]))`, 'Busy System'),
      prom('B', `avg(rate(node_cpu_seconds_total{${SEL},mode="user"}[3m]))`, 'Busy User'),
      prom('C', `avg(rate(node_cpu_seconds_total{${SEL},mode="iowait"}[3m]))`, 'Busy Iowait'),
      prom('D', `avg(sum without(mode) (rate(node_cpu_seconds_total{${SEL},mode=~".*irq"}[3m])))`, 'Busy IRQs'),
      prom('E', `avg(sum without(mode) (rate(node_cpu_seconds_total{${SEL},mode!="idle",mode!="user",mode!="system",mode!="iowait",mode!="irq",mode!="softirq"}[3m])))`, 'Busy Other'),
      prom('F', `avg(rate(node_cpu_seconds_total{${SEL},mode="idle"}[3m]))`, 'Idle'),
    ], {
      unit: 'percentunit', min: 0, fillOpacity: 40, lineWidth: 1, interpolation: 'smooth', stacking: 'percent',
      legend: nefListLegend,
      overrides: [
        override('Busy Iowait', fixedColor('#890F02')),
        override('Idle', fixedColor('#052B51')),
        override('Busy System', fixedColor('#EAB839')),
        override('Busy User', fixedColor('#0A437C')),
        override('Busy Other', fixedColor('#6D1F62')),
      ],
    }),
    tsPanel(78, 'Memory Basic', { x: 12, y: 16, w: 12, h: 8 }, [
      prom('A', `node_memory_MemTotal_bytes{${SEL}}`, 'Total'),
      prom('B', `node_memory_MemTotal_bytes{${SEL}} - node_memory_MemFree_bytes{${SEL}} - (node_memory_Cached_bytes{${SEL}} + node_memory_Buffers_bytes{${SEL}} + node_memory_SReclaimable_bytes{${SEL}})`, 'Used'),
      prom('C', `node_memory_Cached_bytes{${SEL}} + node_memory_Buffers_bytes{${SEL}} + node_memory_SReclaimable_bytes{${SEL}}`, 'Cache + Buffer'),
      prom('D', `node_memory_MemFree_bytes{${SEL}}`, 'Free'),
      prom('E', `node_memory_SwapTotal_bytes{${SEL}} - node_memory_SwapFree_bytes{${SEL}}`, 'Swap used'),
    ], {
      unit: 'bytes', min: 0, fillOpacity: 40, lineWidth: 1, stacking: 'normal',
      legend: nefListLegend,
      overrides: [
        override('Swap used', fixedColor('#BF1B00')),
        override('Total', fixedColor('#E0F9D7'), { id: 'custom.fillOpacity', value: 0 }, { id: 'custom.stacking', value: { group: 'B', mode: 'none' } }),
        override('Cache + Buffer', fixedColor('#052B51')),
        override('Free', fixedColor('#7EB26D')),
      ],
    }),
    tsPanel(74, 'Network Traffic Basic', { x: 0, y: 24, w: 12, h: 8 }, [
      prom('A', `rate(node_network_receive_bytes_total{${SEL}}[3m]) * 8`, 'Rx {{device}}'),
      prom('B', `rate(node_network_transmit_bytes_total{${SEL}}[3m]) * 8`, 'Tx {{device}}'),
    ], {
      unit: 'bps', fillOpacity: 40, lineWidth: 1, legend: nefListLegend,
      overrides: [regexOverride('/.*Tx.*/', negY)],
    }),
    tsPanel(152, 'Disk Space Used Basic', { x: 12, y: 24, w: 12, h: 8 }, [
      prom('A', `((node_filesystem_size_bytes{${SEL},fstype!~"rootfs"} - node_filesystem_avail_bytes{${SEL},fstype!~"rootfs"}) / node_filesystem_size_bytes{${SEL},fstype!~"rootfs"}) * 100`, '{{mountpoint}}'),
    ], {
      unit: 'percent', min: 0, max: 100, fillOpacity: 40, lineWidth: 1, legend: nefListLegend,
    }),

    // Row 3 (collapsed): CPU / Memory / Net / Disk (full detailed h=10 charts from Node Exporter Full)
    rowPanel(265, 'CPU / Memory / Net / Disk', 32, true, [
      tsPanel(3, 'CPU', { x: 0, y: 27, w: 12, h: 10 }, [
        prom('A', `sum(rate(node_cpu_seconds_total{mode="system",${SEL}}[3m])) / scalar(${coresExpr})`, 'System - Kernel mode'),
        prom('B', `sum(rate(node_cpu_seconds_total{mode="user",${SEL}}[3m])) / scalar(${coresExpr})`, 'User - User mode'),
        prom('C', `sum(rate(node_cpu_seconds_total{mode="nice",${SEL}}[3m])) / scalar(${coresExpr})`, 'Nice - Niced user mode'),
        prom('D', `sum(rate(node_cpu_seconds_total{mode="iowait",${SEL}}[3m])) / scalar(${coresExpr})`, 'Iowait - Waiting for I/O'),
        prom('E', `sum(rate(node_cpu_seconds_total{mode="irq",${SEL}}[3m])) / scalar(${coresExpr})`, 'Irq - Hardware interrupts'),
        prom('F', `sum(rate(node_cpu_seconds_total{mode="softirq",${SEL}}[3m])) / scalar(${coresExpr})`, 'Softirq - Software interrupts'),
        prom('G', `sum(rate(node_cpu_seconds_total{mode="steal",${SEL}}[3m])) / scalar(${coresExpr})`, 'Steal - Hypervisor steal'),
        prom('H', `sum(rate(node_cpu_seconds_total{mode="idle",${SEL}}[3m])) / scalar(${coresExpr})`, 'Idle'),
      ], {
        unit: 'percentunit', min: 0, fillOpacity: 70, lineWidth: 1, stacking: 'percent', legend: nefTableLegend,
        overrides: [
          override('Idle', fixedColor('#052B51')),
          override('Iowait - Waiting for I/O', fixedColor('#890F02')),
          override('Irq - Hardware interrupts', fixedColor('#BF1B00')),
          override('Nice - Niced user mode', fixedColor('#6D1F62')),
          override('Softirq - Software interrupts', fixedColor('#A06D99')),
          override('Steal - Hypervisor steal', fixedColor('#CCB1C8')),
          override('System - Kernel mode', fixedColor('#EAB839')),
          override('User - User mode', fixedColor('#0A437C')),
        ],
      }),
      tsPanel(24, 'Memory', { x: 12, y: 27, w: 12, h: 10 }, [
        prom('A', `node_memory_MemTotal_bytes{${SEL}}`, 'Total RAM'),
        prom('B', `node_memory_MemTotal_bytes{${SEL}} - node_memory_MemFree_bytes{${SEL}} - node_memory_Buffers_bytes{${SEL}} - node_memory_Cached_bytes{${SEL}} - node_memory_Slab_bytes{${SEL}}`, 'Apps'),
        prom('C', `node_memory_Buffers_bytes{${SEL}}`, 'Buffers'),
        prom('D', `node_memory_Cached_bytes{${SEL}}`, 'Cached'),
        prom('E', `node_memory_Slab_bytes{${SEL}}`, 'Slab'),
        prom('F', `node_memory_MemFree_bytes{${SEL}}`, 'Unused'),
        prom('G', `node_memory_SwapTotal_bytes{${SEL}} - node_memory_SwapFree_bytes{${SEL}}`, 'Swap Used'),
      ], {
        unit: 'bytes', min: 0, fillOpacity: 40, lineWidth: 1, stacking: 'normal', legend: nefTableLegend,
        overrides: [
          override('Total RAM', fixedColor('#E0F9D7'), { id: 'custom.fillOpacity', value: 0 }, { id: 'custom.stacking', value: { group: 'B', mode: 'none' } }),
          override('Apps', fixedColor('#EAB839')),
          override('Unused', fixedColor('#7EB26D')),
          override('Swap Used', fixedColor('#BF1B00')),
        ],
      }),
      tsPanel(84, 'Network Traffic', { x: 0, y: 37, w: 12, h: 10 }, [
        prom('A', `rate(node_network_receive_bytes_total{${SEL}}[3m]) * 8`, '{{device}} - Rx in'),
        prom('B', `rate(node_network_transmit_bytes_total{${SEL}}[3m]) * 8`, '{{device}} - Tx out'),
      ], { unit: 'bps', fillOpacity: 20, legend: nefTableLegend, overrides: [regexOverride('/.*out.*/', negY)] }),
      tsPanel(229, 'Disk IOps', { x: 12, y: 37, w: 12, h: 10 }, [
        prom('A', `rate(node_disk_reads_completed_total{${SEL}}[3m])`, '{{device}} - Reads'),
        prom('B', `rate(node_disk_writes_completed_total{${SEL}}[3m])`, '{{device}} - Writes'),
      ], { unit: 'iops', fillOpacity: 20, legend: nefTableLegend, overrides: [regexOverride('/.*Writes.*/', negY)] }),
      tsPanel(42, 'Disk Throughput', { x: 0, y: 47, w: 12, h: 10 }, [
        prom('A', `rate(node_disk_read_bytes_total{${SEL}}[3m])`, '{{device}} - Read'),
        prom('B', `rate(node_disk_written_bytes_total{${SEL}}[3m])`, '{{device}} - Write'),
      ], { unit: 'Bps', fillOpacity: 20, legend: nefTableLegend, overrides: [regexOverride('/.*Write.*/', negY)] }),
      tsPanel(127, 'Disk I/O Utilization', { x: 12, y: 47, w: 12, h: 10 }, [
        prom('A', `rate(node_disk_io_time_seconds_total{${SEL}}[3m])`, '{{device}}'),
      ], { unit: 'percentunit', min: 0, max: 1, fillOpacity: 20, legend: nefTableLegend }),
      tsPanel(43, 'Filesystem Space Available', { x: 0, y: 57, w: 12, h: 10 }, [
        prom('A', `node_filesystem_avail_bytes{${SEL},fstype!~"rootfs"}`, '{{mountpoint}}'),
      ], { unit: 'bytes', min: 0, fillOpacity: 20, legend: nefTableLegend }),
      tsPanel(322, 'Pressure Stall Information', { x: 12, y: 57, w: 12, h: 10 }, [
        prom('A', `rate(node_pressure_cpu_waiting_seconds_total{${SEL}}[3m])`, 'CPU some'),
        prom('B', `rate(node_pressure_memory_waiting_seconds_total{${SEL}}[3m])`, 'Memory some'),
        prom('C', `rate(node_pressure_io_waiting_seconds_total{${SEL}}[3m])`, 'I/O some'),
      ], { unit: 'percentunit', min: 0, fillOpacity: 20, legend: nefTableLegend }),
    ]),

    // Row 4 (collapsed): Processes & Scheduler
    rowPanel(312, 'Processes & Scheduler', 33, true, [
      tsPanel(7, 'System Load', { x: 0, y: 28, w: 12, h: 10 }, [
        prom('A', `node_load1{${SEL}}`, '1m load average'),
        prom('B', `node_load5{${SEL}}`, '5m load average'),
        prom('C', `node_load15{${SEL}}`, '15m load average'),
        prom('D', coresExpr, 'CPU Cores'),
      ], {
        unit: 'short', min: 0, fillOpacity: 15, legend: nefTableLegend,
        overrides: [override('CPU Cores', fixedColor('#BF1B00'), { id: 'custom.fillOpacity', value: 0 }, { id: 'custom.lineStyle', value: { fill: 'dash', dash: [8, 8] } })],
      }),
      tsPanel(148, 'Processes Forks', { x: 12, y: 28, w: 12, h: 10 }, [
        prom('A', `rate(node_forks_total{${SEL}}[3m])`, 'Forks / s'),
      ], { unit: 'ops', min: 0, fillOpacity: 20, legend: nefTableLegend }),
      tsPanel(62, 'Processes Status', { x: 0, y: 38, w: 12, h: 10 }, [
        prom('A', `node_procs_running{${SEL}}`, 'Processes Running'),
        prom('B', `node_procs_blocked{${SEL}}`, 'Processes Blocked'),
      ], { unit: 'short', min: 0, fillOpacity: 20, legend: nefTableLegend }),
      tsPanel(8, 'Context Switches / Interrupts', { x: 12, y: 38, w: 12, h: 10 }, [
        prom('A', `rate(node_context_switches_total{${SEL}}[3m])`, 'Context switches'),
        prom('B', `rate(node_intr_total{${SEL}}[3m])`, 'Interrupts'),
      ], { unit: 'ops', min: 0, fillOpacity: 20, legend: nefTableLegend }),
      tsPanel(28, 'File Descriptors', { x: 0, y: 48, w: 24, h: 9 }, [
        prom('A', `node_filefd_allocated{${SEL}}`, 'Allocated'),
        prom('B', `node_filefd_maximum{${SEL}}`, 'Maximum'),
      ], { unit: 'short', min: 0, fillOpacity: 15, legend: nefTableLegend }),
    ]),

    // Row 5 (collapsed): Network Packets, Errors & Sockstat
    rowPanel(272, 'Network Traffic & Sockstat', 34, true, [
      tsPanel(60, 'Network Traffic by Packets', { x: 0, y: 29, w: 12, h: 10 }, [
        prom('A', `rate(node_network_receive_packets_total{${SEL}}[3m])`, '{{device}} - Rx in'),
        prom('B', `rate(node_network_transmit_packets_total{${SEL}}[3m])`, '{{device}} - Tx out'),
      ], { unit: 'pps', fillOpacity: 20, legend: nefTableLegend, overrides: [regexOverride('/.*out.*/', negY)] }),
      tsPanel(142, 'Network Traffic Errors & Drops', { x: 12, y: 29, w: 12, h: 10 }, [
        prom('A', `rate(node_network_receive_errs_total{${SEL}}[3m])`, '{{device}} - Rx errs'),
        prom('B', `rate(node_network_transmit_errs_total{${SEL}}[3m])`, '{{device}} - Tx errs out'),
        prom('C', `rate(node_network_receive_drop_total{${SEL}}[3m])`, '{{device}} - Rx drop'),
        prom('D', `rate(node_network_transmit_drop_total{${SEL}}[3m])`, '{{device}} - Tx drop out'),
      ], { unit: 'pps', fillOpacity: 20, legend: nefTableLegend, overrides: [regexOverride('/.*out.*/', negY)] }),
      tsPanel(63, 'Sockstat TCP', { x: 0, y: 39, w: 12, h: 10 }, [
        prom('A', `node_sockstat_TCP_inuse{${SEL}}`, 'IPv4 In-Use Sockets'),
        prom('B', `node_sockstat_TCP_tw{${SEL}}`, 'IPv4 TIME_WAIT Sockets'),
      ], { unit: 'short', min: 0, fillOpacity: 20, legend: nefTableLegend }),
      tsPanel(126, 'Sockstat Used & UDP', { x: 12, y: 39, w: 12, h: 10 }, [
        prom('A', `node_sockstat_sockets_used{${SEL}}`, 'Total sockets'),
        prom('B', `node_sockstat_UDP_inuse{${SEL}}`, 'IPv4 UDP In-Use Sockets'),
      ], { unit: 'short', min: 0, fillOpacity: 20, legend: nefTableLegend }),
    ]),
  ];

  return { result: dashboard(source, panels, detailVariables('linux')), metrics: targetRelease.metrics };
}

/** Faithful port of Windows Exporter Dashboard (rev 2) mapped to InfraPulse AMP binding labels. */
function windowsDashboard(source, targetRelease) {
  const ramTotal = `max(windows_memory_physical_total_bytes{${SEL}} or windows_cs_physical_memory_bytes{${SEL}} or windows_os_visible_memory_bytes{${SEL}})`;
  const ramFree = `max(windows_memory_physical_free_bytes{${SEL}} or windows_memory_available_bytes{${SEL}} or windows_os_physical_memory_free_bytes{${SEL}})`;
  const procsExpr = `max(windows_cpu_logical_processor{${SEL}} or windows_cs_logical_processors{${SEL}} or count(count(windows_cpu_time_total{${SEL}}) by (core)))`;
  const uptimeExpr = `time() - max(windows_system_boot_time_timestamp{${SEL}} or windows_system_system_up_time{${SEL}})`;
  const bwExpr = `sum(rate(windows_net_bytes_total{${SEL}}[3m]) or (rate(windows_net_bytes_received_total{${SEL}}[3m]) + rate(windows_net_bytes_sent_total{${SEL}}[3m]))) * 8`;
  const listLegend = { displayMode: 'list', placement: 'bottom', calcs: ['lastNotNull', 'max'], showLegend: true };
  const rightTableLegend = (calcs = ['lastNotNull', 'max']) => ({ displayMode: 'table', placement: 'right', calcs, showLegend: true });

  const panels = [
    ...hostInfoPanels(1, 2, 0),

    // Band 1 (y=7..13, h=6) — Spacious Windows Exporter overview (w=4 cards, zero title truncation)
    wedSideStat(33, 'Uptime', { x: 0, y: 7, w: 4, h: 2 }, uptimeExpr, { unit: 'dtdurations' }),
    wedSideStat(35, 'Processors', { x: 0, y: 9, w: 4, h: 2 }, procsExpr, { unit: 'short', decimals: 0 }),
    wedSideStat(37, 'RAM', { x: 0, y: 11, w: 4, h: 2 }, ramTotal, { unit: 'bytes' }),
    wedGauge(19, 'CPU Usage', { x: 4, y: 7, w: 4, h: 6 }, `100 - (avg(rate(windows_cpu_time_total{mode="idle",${SEL}}[3m])) * 100)`),
    wedGauge(21, 'Memory Usage', { x: 8, y: 7, w: 4, h: 6 }, `(${ramTotal} - ${ramFree}) / ${ramTotal} * 100`),
    wedGauge(23, 'Disk Usage', { x: 12, y: 7, w: 4, h: 6 }, `(sum(windows_logical_disk_size_bytes{${SEL}}) - sum(windows_logical_disk_free_bytes{${SEL}})) / sum(windows_logical_disk_size_bytes{${SEL}}) * 100`),
    wedGauge(17, 'Bandwidth', { x: 16, y: 7, w: 4, h: 6 }, bwExpr, { unit: 'bps', min: 0, max: 100_000_000, warn: 70_000_000, crit: 90_000_000 }),
    wedGauge(39, 'Total SWAP', { x: 20, y: 7, w: 4, h: 6 }, `rate(windows_memory_swap_page_operations_total{${SEL}}[3m])`, {
      unit: 'ops', min: 0, max: 1000, warn: 500, crit: 800, decimals: 1,
    }),

    // Band 2 (y=13..17, h=4) — Hard Disk Usage full-width horizontal bar gauge
    {
      id: 40, type: 'bargauge', title: 'Hard Disk Usage', datasource: AMP,
      gridPos: { x: 0, y: 13, w: 24, h: 4 },
      targets: [prom('A', `100 - (windows_logical_disk_free_bytes{${SEL}} / windows_logical_disk_size_bytes{${SEL}}) * 100`, '{{volume}}', true)],
      fieldConfig: {
        defaults: {
          unit: 'percent', decimals: 0, min: 0, max: 100, mappings: naMapping,
          color: { mode: 'thresholds' },
          thresholds: thresholdsOf([{ color: '#299c46', value: null }, { color: 'dark-yellow', value: 80 }, { color: '#d44a3a', value: 90 }]),
        },
        overrides: [],
      },
      options: {
        displayMode: 'basic', orientation: 'horizontal', showUnfilled: true,
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      },
    },

    // Band 3 (y=17..25, h=8) — NTP Status | Memory Details (full w=12 width, clean bottom legend)
    tsPanel(42, 'NTP Status (NTP Offset)', { x: 0, y: 17, w: 12, h: 8 }, [
      prom('A', `windows_time_computed_time_offset_seconds{${SEL}}`, 'NTP Offset'),
    ], { unit: 's', fillOpacity: 10, lineWidth: 1, legend: { displayMode: 'list', placement: 'bottom', calcs: [], showLegend: true } }),
    tsPanel(14, 'Memory Details', { x: 12, y: 17, w: 12, h: 8 }, [
      prom('A', ramTotal, 'Physical'),
      prom('B', ramFree, 'Free physical'),
      prom('C', `windows_memory_committed_bytes{${SEL}}`, 'Committed'),
      prom('D', `windows_memory_commit_limit{${SEL}}`, 'Commit limit'),
    ], { unit: 'bytes', min: 0, fillOpacity: 0, lineWidth: 3, legend: { displayMode: 'list', placement: 'bottom', calcs: ['lastNotNull'], showLegend: true } }),

    // Band 4 (y=25..34, h=9) — CPU Load | CPU Usage
    tsPanel(4, 'CPU Load', { x: 0, y: 25, w: 12, h: 9 }, [
      prom('A', `sum by (mode) (rate(windows_cpu_time_total{${SEL}}[3m]))`, '{{mode}}'),
    ], {
      unit: 'short', min: 0, fillOpacity: 20, lineWidth: 2, legend: rightTableLegend(['lastNotNull', 'max']),
      overrides: [override('idle', fixedColor('dark-green')), override('user', fixedColor('dark-red'))],
    }),
    tsPanel(25, 'CPU Usage', { x: 12, y: 25, w: 12, h: 9 }, [
      prom('A', `sum by (mode) (rate(windows_cpu_time_total{mode!="idle",${SEL}}[3m])) / scalar(${procsExpr}) * 100`, '{{mode}}'),
    ], {
      unit: 'percent', min: 0, max: 100, fillOpacity: 15, lineWidth: 1, stacking: 'normal',
      legend: rightTableLegend(['lastNotNull', 'mean', 'max']),
    }),

    // Band 5 (y=34..43, h=9) — Bandwidth | Flow Per Hour | Network Errors & Discards
    tsPanel(11, 'Bandwidth', { x: 0, y: 34, w: 12, h: 9 }, [
      prom('A', `sum(rate(windows_net_bytes_sent_total{${SEL}}[3m]))`, 'Sent - Upload'),
      prom('B', `sum(rate(windows_net_bytes_received_total{${SEL}}[3m]))`, 'Received - Download'),
    ], {
      unit: 'Bps', fillOpacity: 15, lineWidth: 1, legend: listLegend,
      overrides: [regexOverride('/^Received/', negY)],
    }),
    tsPanel(29, 'Flow Per Hour', { x: 12, y: 34, w: 6, h: 9 }, [
      prom('A', `sum(increase(windows_net_bytes_received_total{${SEL}}[1h]))`, 'Download'),
      prom('B', `sum(increase(windows_net_bytes_sent_total{${SEL}}[1h]))`, 'Upload'),
    ], {
      unit: 'bytes', min: 0, fillOpacity: 15, lineWidth: 1, stacking: 'normal',
      legend: { displayMode: 'list', placement: 'bottom', calcs: ['lastNotNull'], showLegend: true },
    }),
    tsPanel(10, 'Network Errors & Discards', { x: 18, y: 34, w: 6, h: 9 }, [
      prom('A', `sum(rate(windows_net_packets_outbound_discarded_total{${SEL}}[3m]) + rate(windows_net_packets_outbound_errors_total{${SEL}}[3m]))`, 'Sent'),
      prom('B', `sum(rate(windows_net_packets_received_discarded_total{${SEL}}[3m]) + rate(windows_net_packets_received_errors_total{${SEL}}[3m]))`, 'Recv'),
    ], { unit: 'pps', min: 0, fillOpacity: 15, lineWidth: 1, legend: { displayMode: 'list', placement: 'bottom', calcs: ['lastNotNull'], showLegend: true } }),

    // Band 6 (y=43..52, h=9) — Disk R/W | Hard disk i/o ops total
    tsPanel(8, 'Disk R/W', { x: 0, y: 43, w: 12, h: 9 }, [
      prom('A', `rate(windows_logical_disk_write_bytes_total{${SEL}}[3m])`, 'Write {{volume}}'),
      prom('B', `rate(windows_logical_disk_read_bytes_total{${SEL}}[3m])`, 'Read {{volume}}'),
    ], {
      unit: 'Bps', fillOpacity: 20, lineWidth: 1, legend: rightTableLegend(['lastNotNull', 'max']),
      overrides: [regexOverride('/^Read /', negY)],
    }),
    tsPanel(9, 'Hard disk i/o ops total', { x: 12, y: 43, w: 12, h: 9 }, [
      prom('A', `rate(windows_logical_disk_reads_total{${SEL}}[3m])`, 'Reads {{volume}}'),
      prom('B', `rate(windows_logical_disk_writes_total{${SEL}}[3m])`, 'Writes {{volume}}'),
      prom('C', `rate(windows_logical_disk_split_ios_total{${SEL}}[3m])`, 'Split I/O {{volume}}'),
    ], { unit: 'iops', min: 0, fillOpacity: 15, lineWidth: 1, legend: listLegend }),

    // Band 7 (y=52..61, h=9) — Partitions Free Space (gauge) | System Threads
    {
      id: 15, type: 'gauge', title: 'Partitions Free Space', datasource: AMP,
      gridPos: { x: 0, y: 52, w: 12, h: 9 },
      targets: [prom('A', `windows_logical_disk_free_bytes{${SEL}}`, 'free {{volume}}', true)],
      fieldConfig: {
        defaults: {
          unit: 'decbytes', min: 0, color: { mode: 'thresholds' }, mappings: naMapping,
          thresholds: thresholdsOf([
            { color: 'red', value: null },
            { color: '#EAB839', value: 2_000_000_000 },
            { color: '#6ED0E0', value: 5_000_000_000 },
            { color: 'purple', value: 15_000_000_000 },
          ]),
        },
        overrides: [],
      },
      options: {
        orientation: 'auto', showThresholdLabels: false, showThresholdMarkers: true,
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      },
    },
    tsPanel(12, 'System Threads', { x: 12, y: 52, w: 12, h: 9 }, [
      prom('A', `windows_system_threads{${SEL}}`, 'Threads'),
    ], { unit: 'short', min: 0, fillOpacity: 15, lineWidth: 1, legend: listLegend }),

    // Band 8 (y=61..70, h=9) — Processes | Processor Queue Length
    tsPanel(27, 'Processes', { x: 0, y: 61, w: 12, h: 9 }, [
      prom('A', `windows_system_processes{${SEL}}`, 'Processes'),
    ], { unit: 'short', min: 0, fillOpacity: 15, lineWidth: 1, legend: { displayMode: 'list', placement: 'bottom', calcs: [], showLegend: true } }),
    tsPanel(7, 'Processor Queue Length', { x: 12, y: 61, w: 12, h: 9 }, [
      prom('A', `windows_system_processor_queue_length{${SEL}}`, 'CPU Queue Length'),
    ], { unit: 'short', min: 0, fillOpacity: 25, lineWidth: 1, legend: listLegend }),
  ];

  return { result: dashboard(source, panels, detailVariables('windows')), metrics: targetRelease.metrics };
}

function containersOverviewDashboard(source) {
  const vmVar = {
    name: 'server_id', label: 'VM', type: 'query', datasource: INVENTORY,
    query: 'vm-options', definition: 'vm-options', hide: 0, refresh: 1, skipUrlSync: false,
    options: [], multi: false, includeAll: true, allValue: '.*',
    current: { selected: true, text: 'All', value: '$__all' },
  };
  const containerVar = {
    name: 'container', label: 'Container', type: 'query', datasource: AMP,
    query: { query: 'label_values(infrapulse_container_info{server_id=~"$server_id"}, container)', qryType: 1 },
    definition: 'label_values(infrapulse_container_info{server_id=~"$server_id"}, container)',
    hide: 0, refresh: 2, skipUrlSync: false,
    options: [], multi: true, includeAll: true, allValue: '.*',
    current: { selected: true, text: 'All', value: '$__all' },
  };
  const CSEL = 'server_id=~"$server_id",container=~"$container"';
  const kpiStat = (id, title, gridPos, expr, thresholds) => ({
    id, type: 'stat', title, datasource: AMP, gridPos,
    targets: [prom('A', expr, '', true)],
    fieldConfig: {
      defaults: { unit: 'short', decimals: 0, noValue: '0', color: { mode: 'thresholds' }, thresholds: thresholdsOf(thresholds) },
      overrides: [],
    },
    options: {
      colorMode: 'background_solid', graphMode: 'none', justifyMode: 'center', orientation: 'horizontal',
      textMode: 'value', wideLayout: false,
      text: { valueSize: 28 },
      reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
    },
  });
  const listLegend = { displayMode: 'list', placement: 'bottom', calcs: ['mean', 'lastNotNull'], showLegend: true };

  const panels = [
    // Row 1 (y=0..4, h=4) — 5 KPI Stat cards (style 15798 + container health)
    kpiStat(1, 'Tổng Container', { x: 0, y: 0, w: 5, h: 4 },
      `count(infrapulse_container_info{${CSEL}}) or vector(0)`,
      [{ color: 'semi-dark-blue', value: null }]),
    kpiStat(2, 'Running', { x: 5, y: 0, w: 5, h: 4 },
      `sum(infrapulse_container_running{${CSEL}}) or vector(0)`,
      [{ color: 'semi-dark-green', value: null }]),
    kpiStat(3, 'Stopped / Exited', { x: 10, y: 0, w: 5, h: 4 },
      `count(infrapulse_container_running{${CSEL}} == 0) or vector(0)`,
      [{ color: 'semi-dark-green', value: null }, { color: 'semi-dark-orange', value: 1 }]),
    kpiStat(4, 'Unhealthy / OOM', { x: 15, y: 0, w: 5, h: 4 },
      `count((infrapulse_container_health_code{${CSEL}} == 2) or (infrapulse_container_oom_killed{${CSEL}} == 1)) or vector(0)`,
      [{ color: 'semi-dark-green', value: null }, { color: 'semi-dark-red', value: 1 }]),
    kpiStat(5, 'VM có Docker', { x: 20, y: 0, w: 4, h: 4 },
      'sum(infrapulse_docker_present{server_id=~"$server_id"}) or vector(0)',
      [{ color: 'semi-dark-purple', value: null }]),

    // Row 2 (y=4..12, h=8) — Container Inventory Table with "Thuộc VM" column + drill-down links (zero horizontal scrollbar)
    {
      id: 6, type: 'table', title: 'Danh sách Container', datasource: { type: 'datasource', uid: '-- Mixed --' },
      description: 'Bấm vào tên Container để mở Chi tiết Container; bấm vào Thuộc VM để mở Chi tiết VM.',
      gridPos: { x: 0, y: 4, w: 24, h: 8 },
      targets: [
        prom('A', `max by (server_id, container, image, state, health, join_key) (label_join(infrapulse_container_info{${CSEL}}, "join_key", "|", "server_id", "container"))`, '', true, { format: 'table' }),
        prom('B', `sum by (join_key) (label_join(rate(container_cpu_usage_seconds_total{${CSEL}}[3m]) * 100, "join_key", "|", "server_id", "container"))`, '', true, { format: 'table' }),
        prom('C', `sum by (join_key) (label_join(container_memory_working_set_bytes{${CSEL}}, "join_key", "|", "server_id", "container"))`, '', true, { format: 'table' }),
        prom('D', `max by (join_key) (label_join(infrapulse_container_memory_limit_bytes{${CSEL}}, "join_key", "|", "server_id", "container"))`, '', true, { format: 'table' }),
        prom('E', `max by (join_key) (label_join(infrapulse_container_restarts_total{${CSEL}}, "join_key", "|", "server_id", "container"))`, '', true, { format: 'table' }),
        { datasource: INVENTORY, refId: 'F', operation: 'fleet', view: 'table' },
      ],
      transformations: [
        { id: 'joinByField', options: { byField: 'join_key', mode: 'outerTabular', keepUnjoinedFrames: true } },
        { id: 'renameByRegex', options: { regex: '^VM ID$', renamePattern: 'server_id' } },
        { id: 'joinByField', options: { byField: 'server_id', mode: 'outerTabular' } },
        {
          id: 'filterByValue',
          options: {
            type: 'include', match: 'all',
            filters: [{ fieldName: 'container', config: { id: 'isNotNull', options: {} } }],
          },
        },
        {
          id: 'filterFieldsByName',
          options: { include: { pattern: '^(server_id|container|VM|OS|image|state|health|Value #[BCDE]|Path)$' } },
        },
        {
          id: 'organize',
          options: {
            indexByName: {
              container: 0, VM: 1, OS: 2, image: 3, state: 4, health: 5,
              'Value #B': 6, 'Value #C': 7, 'Value #D': 8, 'Value #E': 9,
              server_id: 10, Path: 11,
            },
            renameByName: {
              container: 'Container', VM: 'Thuộc VM', OS: 'OS', image: 'Image',
              state: 'Trạng thái', health: 'Health',
              'Value #B': 'CPU %', 'Value #C': 'RAM', 'Value #D': 'RAM Limit', 'Value #E': 'Restarts',
            },
          },
        },
      ],
      fieldConfig: {
        defaults: { noValue: '—', custom: { filterable: true, minWidth: 60 } },
        overrides: [
          override('server_id', { id: 'custom.hidden', value: true }),
          override('Path', { id: 'custom.hidden', value: true }),
          override('Container', { id: 'custom.width', value: 130 }, {
            id: 'links',
            value: [{
              title: 'Chi tiết container ${__value.raw}',
              url: '/d/infrapulse-container-detail?var-server_id=${__data.fields["server_id"]}&var-container=${__value.raw}&from=${__from}&to=${__to}',
            }],
          }),
          override('Thuộc VM', { id: 'custom.width', value: 130 }, {
            id: 'links',
            value: [{ title: 'Chi tiết VM ${__value.raw}', url: '${__data.fields["Path"]}&from=${__from}&to=${__to}' }],
          }),
          override('OS', { id: 'mappings', value: statusMappings }, badgeCell, { id: 'custom.width', value: 75 }),
          override('Image', { id: 'custom.width', value: 135 }),
          override('Trạng thái', { id: 'mappings', value: containerStateMappings }, badgeCell, { id: 'custom.width', value: 98 }),
          override('Health', { id: 'mappings', value: containerHealthMappings }, badgeCell, { id: 'custom.width', value: 88 }),
          override('CPU %', { id: 'unit', value: 'percent' }, { id: 'decimals', value: 2 }, { id: 'custom.width', value: 80 }),
          override('RAM', { id: 'unit', value: 'bytes' }, { id: 'decimals', value: 1 }, { id: 'custom.width', value: 88 }),
          override('RAM Limit', { id: 'unit', value: 'bytes' }, { id: 'decimals', value: 0 }, { id: 'mappings', value: unlimitedZeroMapping }, { id: 'custom.width', value: 95 }),
          override('Restarts', { id: 'unit', value: 'short' }, { id: 'decimals', value: 0 }, { id: 'custom.width', value: 80 }),
        ],
      },
      options: { showHeader: true, cellHeight: 'md', sortBy: [{ displayName: 'Trạng thái', desc: true }] },
    },

    // Rows 3..6 (y=12..40, 4 wide Time Series panels matching 15798 layout)
    tsPanel(10, 'CPU Usage', { x: 0, y: 12, w: 24, h: 7 }, [
      prom('A', `sum by (container) (rate(container_cpu_usage_seconds_total{${CSEL}}[3m])) * 100`, '{{container}}'),
    ], { unit: 'percent', min: 0, fillOpacity: 20, lineWidth: 2, legend: listLegend }),

    tsPanel(11, 'Memory Usage', { x: 0, y: 19, w: 24, h: 7 }, [
      prom('A', `sum by (container) (container_memory_working_set_bytes{${CSEL}})`, '{{container}}'),
    ], { unit: 'bytes', min: 0, fillOpacity: 20, lineWidth: 2, legend: listLegend }),

    tsPanel(12, 'Network', { x: 0, y: 26, w: 24, h: 7 }, [
      prom('A', `sum by (container) (rate(container_network_receive_bytes_total{${CSEL}}[3m]))`, 'Rx {{container}}'),
      prom('B', `sum by (container) (rate(container_network_transmit_bytes_total{${CSEL}}[3m]))`, 'Tx {{container}}'),
    ], {
      unit: 'Bps', fillOpacity: 20, lineWidth: 2, legend: listLegend,
      overrides: [regexOverride('^Tx ', negY)],
    }),

    tsPanel(13, 'Disk I/O', { x: 0, y: 33, w: 24, h: 7 }, [
      prom('A', `sum by (container) (rate(container_fs_reads_bytes_total{${CSEL}}[3m]))`, 'Read {{container}}'),
      prom('B', `sum by (container) (rate(container_fs_writes_bytes_total{${CSEL}}[3m]))`, 'Write {{container}}'),
    ], {
      unit: 'Bps', fillOpacity: 20, lineWidth: 2, legend: listLegend,
      overrides: [regexOverride('^Write ', negY)],
    }),
  ];

  return dashboard(source, panels, [vmVar, containerVar]);
}

function containerDetailDashboard(source) {
  const vmVar = {
    name: 'server_id', label: 'VM', type: 'query', datasource: INVENTORY,
    query: 'vm-options', definition: 'vm-options', hide: 0, refresh: 1, skipUrlSync: false,
    options: [], multi: false, includeAll: false,
  };
  const containerVar = {
    name: 'container', label: 'Container', type: 'query', datasource: AMP,
    query: { query: 'label_values(infrapulse_container_info{server_id="$server_id"}, container)', qryType: 1 },
    definition: 'label_values(infrapulse_container_info{server_id="$server_id"}, container)',
    hide: 0, refresh: 2, skipUrlSync: false,
    options: [], multi: false, includeAll: false,
  };
  const CSEL = 'server_id="$server_id",container="$container"';
  const listLegend = { displayMode: 'list', placement: 'bottom', calcs: ['min', 'mean', 'max', 'lastNotNull'], showLegend: true };

  const statCard = (id, title, gridPos, expr, { unit = 'short', decimals = 1, mappings = naMapping, thresholds = [{ color: 'green', value: null }] } = {}) => ({
    id, type: 'stat', title, datasource: AMP, gridPos,
    targets: [prom('A', expr, '', true)],
    fieldConfig: {
      defaults: { unit, decimals, mappings, color: { mode: 'thresholds' }, thresholds: thresholdsOf(thresholds) },
      overrides: [],
    },
    options: {
      colorMode: 'value', graphMode: 'none', justifyMode: 'center', orientation: 'horizontal',
      textMode: 'value', wideLayout: false,
      text: { valueSize: 24 },
      reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
    },
  });

  const panels = [
    // Row 1 (y=0..7, h=7) — 2-card header matching VM v6 dashboards (zero scrollbars)
    {
      id: 1, type: 'table', title: 'Thông tin Container', datasource: { type: 'datasource', uid: '-- Mixed --' },
      gridPos: { x: 0, y: 0, w: 14, h: 7 },
      targets: [
        prom('A', `max by (server_id, container, image, container_id, ports) (infrapulse_container_info{${CSEL}})`, '', true, { format: 'table' }),
        { datasource: INVENTORY, refId: 'B', operation: 'fleet', view: 'table' },
      ],
      transformations: [
        { id: 'renameByRegex', options: { regex: '^VM ID$', renamePattern: 'server_id' } },
        { id: 'joinByField', options: { byField: 'server_id', mode: 'inner' } },
        { id: 'filterFieldsByName', options: { include: { pattern: '^(container|VM|image|container_id|ports)$' } } },
        {
          id: 'organize',
          options: {
            indexByName: { container: 0, VM: 1, image: 2, container_id: 3, ports: 4 },
            renameByName: { container: 'Container', VM: 'Thuộc VM', image: 'Image', container_id: 'Container ID', ports: 'Ports' },
          },
        },
        { id: 'transpose', options: { firstFieldName: 'Container', emptyFieldName: 'Giá trị' } },
      ],
      fieldConfig: {
        defaults: { noValue: '—', custom: { align: 'left' } },
        overrides: [
          override('Container', { id: 'custom.width', value: 140 }),
          override('Field', { id: 'custom.width', value: 140 }),
        ],
      },
      options: { showHeader: true, cellHeight: 'sm', footer: { show: false } },
    },
    {
      id: 2, type: 'stat', title: 'Trạng thái & Sức khỏe', datasource: AMP,
      gridPos: { x: 14, y: 0, w: 10, h: 7 },
      targets: [
        prom('A', `max(infrapulse_container_state_code{${CSEL}})`, 'Trạng thái', true),
        prom('B', `max(infrapulse_container_health_code{${CSEL}})`, 'Health', true),
        prom('C', `max(infrapulse_container_restarts_total{${CSEL}})`, 'Restarts', true),
        prom('D', `max(infrapulse_container_oom_killed{${CSEL}})`, 'OOM', true),
      ],
      fieldConfig: {
        defaults: {
          noValue: '—', unit: 'short', decimals: 0,
          color: { mode: 'thresholds' },
          thresholds: thresholdsOf([{ color: 'green', value: null }]),
        },
        overrides: [
          override('Trạng thái', { id: 'mappings', value: stateCodeMappings }),
          override('Health', { id: 'mappings', value: healthCodeMappings }),
          override('Restarts', {
            id: 'thresholds',
            value: thresholdsOf([{ color: 'green', value: null }, { color: 'orange', value: 1 }, { color: 'red', value: 5 }]),
          }),
          override('OOM', { id: 'mappings', value: oomCodeMappings }),
        ],
      },
      options: {
        colorMode: 'background_solid', graphMode: 'none', justifyMode: 'center', orientation: 'auto',
        textMode: 'value_and_name', wideLayout: false,
        text: { titleSize: 12, valueSize: 18 },
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      },
    },

    // Row 2 (y=7..10, h=3) — 5 Stat cards (style 15798)
    statCard(3, 'CPU Usage', { x: 0, y: 7, w: 5, h: 3 },
      `sum(rate(container_cpu_usage_seconds_total{${CSEL}}[3m])) * 100`,
      { unit: 'percent', decimals: 2, thresholds: [{ color: 'green', value: null }, { color: 'orange', value: 70 }, { color: 'red', value: 90 }] }),
    statCard(4, 'RAM Working Set', { x: 5, y: 7, w: 5, h: 3 },
      `sum(container_memory_working_set_bytes{${CSEL}})`,
      { unit: 'bytes', decimals: 1, thresholds: [{ color: 'semi-dark-blue', value: null }] }),
    statCard(5, 'RAM Limit', { x: 10, y: 7, w: 5, h: 3 },
      `max(infrapulse_container_memory_limit_bytes{${CSEL}})`,
      { unit: 'bytes', decimals: 0, mappings: unlimitedZeroMapping, thresholds: [{ color: 'text', value: null }] }),
    statCard(6, 'RAM % Limit', { x: 15, y: 7, w: 4, h: 3 },
      `(sum(container_memory_working_set_bytes{${CSEL}}) / (max(infrapulse_container_memory_limit_bytes{${CSEL}}) > 0)) * 100`,
      { unit: 'percent', decimals: 1, thresholds: [{ color: 'green', value: null }, { color: 'orange', value: 75 }, { color: 'red', value: 90 }] }),
    statCard(7, 'Uptime', { x: 19, y: 7, w: 5, h: 3 },
      `time() - (max(infrapulse_container_started_timestamp_seconds{${CSEL}}) > 0)`,
      { unit: 's', decimals: 0, thresholds: [{ color: 'green', value: null }] }),

    // Rows 3..6 (y=10..38, 4 wide Time Series panels matching 15798 layout)
    tsPanel(10, 'CPU Usage & Throttling', { x: 0, y: 10, w: 24, h: 7 }, [
      prom('A', `sum(rate(container_cpu_usage_seconds_total{${CSEL}}[3m])) * 100`, 'CPU Usage %'),
      prom('B', `(sum(rate(container_cpu_cfs_throttled_periods_total{${CSEL}}[3m])) / clamp_min(sum(rate(container_cpu_cfs_periods_total{${CSEL}}[3m])), 1)) * 100`, 'CPU Throttled %'),
    ], {
      unit: 'percent', min: 0, fillOpacity: 25, lineWidth: 2, legend: listLegend,
      overrides: [override('CPU Throttled %', fixedColor('orange'))],
    }),

    tsPanel(11, 'Memory Usage', { x: 0, y: 17, w: 24, h: 7 }, [
      prom('A', `sum(container_memory_working_set_bytes{${CSEL}})`, 'Working Set'),
      prom('B', `sum(container_memory_rss{${CSEL}})`, 'RSS'),
      prom('C', `sum(container_memory_cache{${CSEL}})`, 'Cache'),
      prom('D', `max(infrapulse_container_memory_limit_bytes{${CSEL}}) > 0`, 'Memory Limit'),
    ], {
      unit: 'bytes', min: 0, fillOpacity: 20, lineWidth: 2, legend: listLegend,
      overrides: [
        override('Memory Limit', fixedColor('red'), { id: 'custom.fillOpacity', value: 0 }, { id: 'custom.lineStyle', value: { fill: 'dash', dash: [8, 6] } }),
      ],
    }),

    tsPanel(12, 'Network', { x: 0, y: 24, w: 24, h: 7 }, [
      prom('A', `sum(rate(container_network_receive_bytes_total{${CSEL}}[3m]))`, 'Receive'),
      prom('B', `sum(rate(container_network_transmit_bytes_total{${CSEL}}[3m]))`, 'Transmit'),
    ], {
      unit: 'Bps', fillOpacity: 25, lineWidth: 2, legend: listLegend,
      overrides: [override('Receive', fixedColor('#7EB26D')), override('Transmit', fixedColor('#EAB839'), negY)],
    }),

    tsPanel(13, 'Disk I/O', { x: 0, y: 31, w: 24, h: 7 }, [
      prom('A', `sum(rate(container_fs_reads_bytes_total{${CSEL}}[3m]))`, 'Read'),
      prom('B', `sum(rate(container_fs_writes_bytes_total{${CSEL}}[3m]))`, 'Write'),
    ], {
      unit: 'Bps', fillOpacity: 25, lineWidth: 2, legend: listLegend,
      overrides: [override('Read', fixedColor('#6ED0E0')), override('Write', fixedColor('#EF843C'), negY)],
    }),
  ];

  return dashboard(source, panels, [vmVar, containerVar]);
}

/** Deterministic AMP + Grafana 13 dashboard compiler. */
export function compileCloudWatchDashboards(value, templates) {
  const release = decodeAgentRelease(value);
  const fleetSource = template(templates?.fleet, 'infrapulse-fleet', 'infrapulse-inventory-template-v1');
  const fleet = fleetDashboard(fleetSource);
  const files = { 'dashboards/fleet.json': encode(fleet) };
  const entries = [{ uid: fleet.uid, templateHash: releaseSha256(fleetSource), dashboardHash: releaseSha256(fleet) }];
  if (templates?.containers) {
    const containersSource = template(templates.containers, 'infrapulse-containers', 'infrapulse-container-template-v1');
    const containers = containersOverviewDashboard(containersSource);
    files['dashboards/containers.json'] = encode(containers);
    entries.push({ uid: containers.uid, templateHash: releaseSha256(containersSource), dashboardHash: releaseSha256(containers) });
  }
  if (templates?.containerDetail) {
    const containerDetailSource = template(templates.containerDetail, 'infrapulse-container-detail', 'infrapulse-container-template-v1');
    const containerDetail = containerDetailDashboard(containerDetailSource);
    files['dashboards/container-detail.json'] = encode(containerDetail);
    entries.push({ uid: containerDetail.uid, templateHash: releaseSha256(containerDetailSource), dashboardHash: releaseSha256(containerDetail) });
  }
  const linux = release.platforms.linux;
  if (linux) {
    const detailSource = template(templates?.linux, 'infrapulse-linux-host', 'infrapulse-cloudwatch-template-v2', 'linux');
    const { result, metrics } = linuxDashboard(detailSource, linux);
    files['dashboards/linux-host.json'] = encode(result);
    entries.push({
      platform: 'linux', uid: result.uid, presetId: 'linux', presetVersion: linux.parameter.version,
      presetHash: linux.parameter.sha256, templateHash: releaseSha256(detailSource), dashboardHash: releaseSha256(result), metrics,
    });
  }
  const windows = release.platforms.windows;
  if (windows) {
    const detailSource = template(templates?.windows, 'infrapulse-windows-host', 'infrapulse-cloudwatch-template-v2', 'windows');
    const { result, metrics } = windowsDashboard(detailSource, windows);
    files['dashboards/windows-host.json'] = encode(result);
    entries.push({
      platform: 'windows', uid: result.uid, presetId: 'windows', presetVersion: windows.parameter.version,
      presetHash: windows.parameter.sha256, templateHash: releaseSha256(detailSource), dashboardHash: releaseSha256(result), metrics,
    });
  }
  if (Object.entries(files).some(([, content]) => Buffer.byteLength(content) > 2097152)) fail('DASHBOARD_TOO_LARGE');
  files['manifest.json'] = encode({ format: 'infrapulse-amp-generation-v4', releaseHash: releaseSha256(release), entries });
  return files;
}

export async function loadCompiledCloudWatchDashboards() {
  const { readPublicJson, readBuildRelease } = await import('./build-inputs.mjs');
  const release = await readBuildRelease();
  const templates = {
    fleet: await readPublicJson(INPUT + 'fleet.json'),
    containers: await readPublicJson(INPUT + 'containers.json'),
    containerDetail: await readPublicJson(INPUT + 'container-detail.json'),
  };
  if (release.platforms.linux) templates.linux = await readPublicJson(INPUT + 'linux-host.json');
  if (release.platforms.windows) templates.windows = await readPublicJson(INPUT + 'windows-host.json');
  return compileCloudWatchDashboards(release, templates);
}

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
