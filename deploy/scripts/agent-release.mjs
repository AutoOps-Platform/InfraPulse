import { createHash } from 'node:crypto';

const invalid = () => { throw new Error('AGENT_RELEASE_INVALID'); };
const hash = /^[a-f0-9]{64}$/;
const id = /^[a-z][a-z0-9_-]{0,63}$/;
const stats = ['Average', 'Maximum', 'Minimum', 'Sum'];
const identity = ['EnrollmentId', 'ManagedNodeId', 'ServerId'];
export const canonicalJson = value => JSON.stringify(order(value));
function order(value) {
  if (Array.isArray(value)) return value.map(order);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, order(value[k])]));
  return value;
}
export const releaseSha256 = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
function exact(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== fields.length || fields.some(k => !Object.hasOwn(value, k))) invalid();
  return value;
}
function text(value, pattern) { if (typeof value !== 'string' || !pattern.test(value)) invalid(); return value; }
function list(value, maximum, minimum = 1) { if (!Array.isArray(value) || value.length < minimum || value.length > maximum) invalid(); return value; }
function unique(values) { if (new Set(values).size !== values.length) invalid(); }
function signer(value, platform) {
  if (platform === 'linux') { if (value !== null) invalid(); return; }
  exact(value, ['subject', 'certificateSha256']);
  text(value.subject, /^(Amazon Web Services, Inc\.|Amazon\.com Services LLC)$/);
  text(value.certificateSha256, hash);
}
function artifact(value, platform, helper) {
  exact(value, ['version', 'url', 'sha256', 'signer']);
  text(value.sha256, hash); signer(value.signer, platform);
  text(value.version, helper ? /^sha256:[a-f0-9]{64}$/ : /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/);
  if (helper) {
    // AWS publishes setup-cli at this fixed URL; its VERSION is the verified
    // content digest, not the mutable URL label. Keep the existing trust rule.
    if (value.version !== `sha256:${value.sha256}` || value.url !== 'https://amazon-ssm-ap-southeast-1.s3.ap-southeast-1.amazonaws.com/latest/' + (platform === 'linux' ? 'debian_amd64/ssm-setup-cli' : 'windows_amd64/ssm-setup-cli.exe')) invalid();
    return;
  }
  if (typeof value.url !== 'string' || value.url.length > 1024 || value.url.includes('..')) invalid();
  let url; try { url = new URL(value.url); } catch { invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
    || !/^(amazon-ssm-ap-southeast-1\.s3\.ap-southeast-1\.amazonaws\.com|s3\.ap-southeast-1\.amazonaws\.com)$/.test(url.hostname)
    || (url.hostname === 's3.ap-southeast-1.amazonaws.com' && !url.pathname.startsWith('/amazon-ssm-ap-southeast-1/'))
    || !/^\/[A-Za-z0-9_./-]+$/.test(url.pathname) || /(?:latest|stable|current)/i.test(url.pathname)
    || !url.pathname.split('/').includes(value.version)
    || (platform === 'linux' ? !url.pathname.endsWith('/amazon-ssm-agent.deb') : !url.pathname.endsWith('/AmazonSSMAgentSetup.exe'))) invalid();
}
const linuxInputs = {
  cpu: { usage_active: ['Percent', 'gauge'], usage_idle: ['Percent', 'gauge'], usage_user: ['Percent', 'gauge'], usage_system: ['Percent', 'gauge'], usage_iowait: ['Percent', 'gauge'], usage_steal: ['Percent', 'gauge'] },
  mem: { used_percent: ['Percent', 'gauge'], available_percent: ['Percent', 'gauge'], used: ['Bytes', 'gauge'], available: ['Bytes', 'gauge'], total: ['Bytes', 'gauge'] },
  disk: { used_percent: ['Percent', 'gauge'], used: ['Bytes', 'gauge'], free: ['Bytes', 'gauge'], total: ['Bytes', 'gauge'] },
  net: { bytes_sent: ['Bytes/Second', 'rate'], bytes_recv: ['Bytes/Second', 'rate'], packets_sent: ['Count/Second', 'rate'], packets_recv: ['Count/Second', 'rate'] },
};
const windowsInputs = {
  Processor: { '% Processor Time': ['Percent', 'gauge'] },
  Memory: { '% Committed Bytes In Use': ['Percent', 'gauge'], 'Committed Bytes': ['Bytes', 'gauge'] },
  LogicalDisk: { '% Free Space': ['Percent', 'gauge'] },
  'Network Interface': { 'Bytes Sent/sec': ['Bytes/Second', 'rate'], 'Bytes Received/sec': ['Bytes/Second', 'rate'], 'Packets Sent/sec': ['Count/Second', 'rate'], 'Packets Received/sec': ['Count/Second', 'rate'] },
};
const groups = { cpu: 'cpu', mem: 'memory', disk: 'disk', net: 'network', Processor: 'cpu', Memory: 'memory', LogicalDisk: 'disk', 'Network Interface': 'network' };
const kinds = { cpu: 'cpu', memory: 'memory', disk: 'filesystem', network: 'interface' };
function dimensions(values) {
  list(values, 10, 0);
  for (const d of values) { exact(d, ['name', 'value']); text(d.name, /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/); text(d.value, /^[A-Za-z0-9 ${}_.:/()%+-]{1,256}$/); }
  unique(values.map(d => d.name));
  if (canonicalJson(values.map(d => d.name)) !== canonicalJson(values.map(d => d.name).sort())) invalid();
}
function configuration(value, platform) {
  exact(value.configuration, ['plugins']);
  const plugins = list(value.configuration.plugins, 4);
  const inputs = platform === 'linux' ? linuxInputs : windowsInputs;
  if (plugins.length !== 4) invalid();
  unique(plugins.map(p => p.plugin));
  const metrics = list(value.metrics, 128), resources = [], covered = [];
  unique(metrics.map(m => m.key));
  for (const m of metrics) {
    exact(m, ['key', 'group', 'namespace', 'metricName', 'resourceId', 'dimensions', 'statistic', 'aggregation', 'unit', 'periodSeconds', 'semantics']);
    text(m.key, id); text(m.metricName, /^[A-Za-z0-9 _%./()-]{1,128}$/);
    if (m.namespace !== 'InfraPulse/Lab' || !Object.values(groups).includes(m.group) || m.periodSeconds !== 60 || !stats.includes(m.statistic)) invalid();
    list(m.aggregation, 4); unique(m.aggregation);
    if (!m.aggregation.includes(m.statistic) || m.aggregation.some(s => !stats.includes(s))) invalid();
    if (m.resourceId !== null) text(m.resourceId, id);
    dimensions(m.dimensions);
  }
  for (const p of plugins) {
    exact(p, ['plugin', 'resources', 'measurements']);
    if (!Object.hasOwn(inputs, p.plugin)) invalid();
    const group = groups[p.plugin], memoryWithoutResource = platform === 'linux' && p.plugin === 'mem';
    list(p.resources, 32, memoryWithoutResource ? 0 : 1);
    if ((memoryWithoutResource && p.resources.length) || (['cpu', 'memory'].includes(group) && !memoryWithoutResource && p.resources.length !== 1)) invalid();
    unique(p.resources.map(r => r.selector));
    for (const r of p.resources) {
      exact(r, ['id', 'kind', 'selector', 'dimensions']); text(r.id, id); dimensions(r.dimensions);
      if (r.kind !== kinds[group] || r.dimensions.some(d => /[${}]/.test(d.value))) invalid();
      let expected;
      if (platform === 'linux') {
        if (group === 'cpu') { if (r.selector !== 'cpu-total') invalid(); expected = [{ name: 'cpu', value: 'cpu-total' }]; }
        if (group === 'network') { text(r.selector, /^[A-Za-z0-9_.:-]{1,64}$/); if (r.selector === 'lo') invalid(); expected = [{ name: 'interface', value: r.selector }]; }
        if (group === 'disk') {
          text(r.selector, /^\/(?:[A-Za-z0-9_.-]+\/?)*$/); if (r.selector.includes('..')) invalid();
          if (canonicalJson(r.dimensions.map(d => d.name)) !== '["device","fstype","path"]' || r.dimensions[2].value !== r.selector
            || /^(proc|sysfs|tmpfs|devtmpfs|overlay|squashfs|cgroup2?|debugfs|tracefs|securityfs|pstore|autofs|fusectl|mqueue|hugetlbfs|rpc_pipefs|nsfs)$/.test(r.dimensions[1].value)) invalid();
          expected = r.dimensions;
        }
      } else {
        if (group === 'cpu' && r.selector !== '_Total') invalid();
        if (group === 'memory' && r.selector !== '') invalid();
        if (group === 'disk') text(r.selector, /^[A-Z]:$/);
        if (group === 'network') { text(r.selector, /^[A-Za-z0-9 _().-]{1,128}$/); if (/loopback/i.test(r.selector)) invalid(); }
        expected = [...(group === 'memory' ? [] : [{ name: 'instance', value: r.selector }]), { name: 'objectname', value: p.plugin }];
      }
      if (canonicalJson(expected) !== canonicalJson(r.dimensions)) invalid();
      resources.push(r);
    }
    list(p.measurements, 16); unique(p.measurements.map(m => m.input));
    for (const measurement of p.measurements) {
      exact(measurement, ['input', 'metricKeys']);
      const semantic = inputs[p.plugin][measurement.input]; if (!semantic) invalid();
      list(measurement.metricKeys, 32); unique(measurement.metricKeys);
      const specs = measurement.metricKeys.map(key => metrics.find(m => m.key === key));
      if (specs.some(m => !m || m.group !== group || m.unit !== semantic[0] || m.semantics !== semantic[1])
        || new Set(specs.map(m => m.metricName)).size !== 1
        || canonicalJson(specs.map(m => m.resourceId).sort()) !== canonicalJson((memoryWithoutResource ? [null] : p.resources.map(r => r.id)).sort())) invalid();
      for (const m of specs) {
        const r = resources.find(r => r.id === m.resourceId);
        const expected = [...identity.map(name => ({ name, value: '${' + name + '}' })), ...(r?.dimensions ?? []).map(d => ({ name: d.name, value: '${native.' + r.id + '.' + d.name + '}' }))].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        if (canonicalJson(expected) !== canonicalJson(m.dimensions)) invalid();
      }
      covered.push(...measurement.metricKeys);
    }
  }
  if (resources.length > 32) invalid(); unique(resources.map(r => r.id)); unique(covered);
  unique(metrics.map(m => canonicalJson([m.namespace, m.metricName, m.dimensions])));
  if (canonicalJson(covered.sort()) !== canonicalJson(metrics.map(m => m.key).sort())) invalid();
}
/** Native preset has only reviewed metrics/identity slots, never arbitrary agent settings or credentials. */
export function cloudWatchPreset(platform, release) {
  return {
    agent: { metrics_collection_interval: 60, region: 'ap-southeast-1', omit_hostname: true },
    metrics: { namespace: 'InfraPulse/Lab', metrics_collected: Object.fromEntries(release.configuration.plugins.map(p => [p.plugin, {
      metrics_collection_interval: 60,
      append_dimensions: Object.fromEntries(identity.map(name => [name, '${' + name + '}'])),
      ...(p.resources.length && p.plugin !== 'Memory' && !(platform === 'linux' && p.plugin === 'cpu') ? { resources: p.resources.map(r => r.selector) } : {}),
      ...(platform === 'linux' && p.plugin === 'cpu' ? { totalcpu: true } : {}),
      measurement: p.measurements.map(m => { const spec = release.metrics.find(s => s.key === m.metricKeys[0]); return { name: m.input, rename: spec.metricName, unit: spec.unit }; }),
    }])) },
  };
}
/** The sole release decoder. Missing OS entries are unavailable, not malformed defaults. */
export function decodeAgentRelease(value) {
  exact(value, ['schemaVersion', 'platforms']);
  if (value.schemaVersion !== 1) invalid();
  if (!value.platforms || typeof value.platforms !== 'object' || Array.isArray(value.platforms) || Object.getPrototypeOf(value.platforms) !== Object.prototype
    || Object.keys(value.platforms).some(p => !['linux', 'windows'].includes(p))) invalid();
  for (const [platform, p] of Object.entries(value.platforms)) {
    exact(p, ['revision', 'ssm', 'helper', 'cloudWatch', 'configuration', 'metrics', 'parameter']);
    text(p.revision, hash); artifact(p.ssm, platform, false); artifact(p.helper, platform, true);
    // Shared onFailure inputs require SSM >=3.0.502; preserve the existing
    // bootstrap protocol's exact reviewed SSM pin until Task2 switches it.
    if (p.ssm.version !== '3.3.5828.0') invalid();
    exact(p.cloudWatch, ['packageVersion', 'version', 'files', 'signer']);
    text(p.cloudWatch.packageVersion, /^[0-9]+(?:\.[0-9]+){2,3}(?:b[0-9]+)?$/); text(p.cloudWatch.version, /^[0-9]+\.[0-9]+\.[0-9]+(?:\.[0-9]+|b[0-9]+)?$/);
    exact(p.cloudWatch.files, ['agent', 'downloader', 'control']);
    for (const digest of Object.values(p.cloudWatch.files)) text(digest, hash);
    signer(p.cloudWatch.signer, platform); configuration(p, platform);
    exact(p.parameter, ['name', 'version', 'tier', 'sha256']);
    if (p.parameter.name !== `/infrapulse/lab-20261118/presets/${platform}` || !Number.isSafeInteger(p.parameter.version) || p.parameter.version < 1 || p.parameter.version > 1000000 || !['Standard', 'Advanced'].includes(p.parameter.tier)) invalid();
    text(p.parameter.sha256, hash);
    const preset = cloudWatchPreset(platform, p);
    if (releaseSha256(preset) !== p.parameter.sha256 || Buffer.byteLength(canonicalJson(preset)) > (p.parameter.tier === 'Standard' ? 4096 : 8192)) invalid();
    const { revision, ...body } = p;
    if (releaseSha256(body) !== revision) invalid();
  }
  // Return detached JSON only; downstream consumers do not reimplement validation.
  return JSON.parse(canonicalJson(value));
}
