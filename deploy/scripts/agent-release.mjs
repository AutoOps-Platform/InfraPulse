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
function alloyArtifact(value, platform) {
  exact(value, ['version', 'url', 'sha256']);
  text(value.version, /^[0-9]+\.[0-9]+\.[0-9]+$/);
  text(value.sha256, hash);
  if (typeof value.url !== 'string' || value.url.length > 1024 || value.url.includes('..')) invalid();
  let url; try { url = new URL(value.url); } catch { invalid(); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port || url.search || url.hash
    || !url.pathname.startsWith(`/grafana/alloy/releases/download/v${value.version}/`)
    || (platform === 'linux' ? !url.pathname.endsWith('/alloy-linux-amd64.zip') : !url.pathname.endsWith('/alloy-installer-windows-amd64.exe.zip'))) invalid();
}
function ampConfig(value) {
  exact(value, ['workspaceId', 'region', 'remoteWriteUrl']);
  text(value.workspaceId, /^ws-[a-z0-9-]{8,64}$/);
  if (value.region !== 'ap-southeast-1') invalid();
  if (value.remoteWriteUrl !== `https://aps-workspaces.${value.region}.amazonaws.com/workspaces/${value.workspaceId}/api/v1/remote_write`) invalid();
}
const linuxInputs = {
  cpu: { node_cpu_seconds_total: ['Count', 'counter'] },
  mem: { node_memory_MemAvailable_bytes: ['Bytes', 'gauge'] },
  disk: { node_filesystem_avail_bytes: ['Bytes', 'gauge'] },
  net: { node_network_receive_bytes_total: ['Bytes', 'counter'] },
};
const windowsInputs = {
  Processor: { windows_cpu_time_total: ['Count', 'counter'] },
  Memory: { windows_memory_available_bytes: ['Bytes', 'gauge'] },
  LogicalDisk: { windows_logical_disk_free_bytes: ['Bytes', 'gauge'] },
  'Network Interface': { windows_net_bytes_received_total: ['Bytes', 'counter'] },
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
    text(m.key, id); text(m.metricName, /^[A-Za-z_][A-Za-z0-9_:]{0,127}$/);
    if (m.namespace !== 'InfraPulse/AMP' || !Object.values(groups).includes(m.group) || m.periodSeconds !== 60 || !stats.includes(m.statistic)) invalid();
    list(m.aggregation, 4); unique(m.aggregation);
    if (!m.aggregation.includes(m.statistic) || m.aggregation.some(s => !stats.includes(s))) invalid();
    if (m.resourceId !== null) text(m.resourceId, id);
    dimensions(m.dimensions);
  }
  for (const p of plugins) {
    exact(p, ['plugin', 'resources', 'measurements']);
    if (!Object.hasOwn(inputs, p.plugin)) invalid();
    const group = groups[p.plugin];
    list(p.resources, 1, 1);
    const r = p.resources[0];
    exact(r, ['id', 'kind', 'selector', 'dimensions']);
    text(r.id, id); dimensions(r.dimensions);
    if (r.kind !== kinds[group] || r.dimensions.some(d => /[${}]/.test(d.value))) invalid();
    const expected = [{ name: 'collector', value: platform === 'linux' ? 'unix' : 'windows' }];
    if (canonicalJson(expected) !== canonicalJson(r.dimensions)) invalid();
    resources.push(r);

    list(p.measurements, 16); unique(p.measurements.map(m => m.input));
    for (const measurement of p.measurements) {
      exact(measurement, ['input', 'metricKeys']);
      const semantic = inputs[p.plugin][measurement.input]; if (!semantic) invalid();
      list(measurement.metricKeys, 32); unique(measurement.metricKeys);
      const specs = measurement.metricKeys.map(key => metrics.find(m => m.key === key));
      if (specs.some(m => !m || m.group !== group || m.unit !== semantic[0] || m.semantics !== semantic[1] || m.metricName !== measurement.input)
        || new Set(specs.map(m => m.metricName)).size !== 1
        || canonicalJson(specs.map(m => m.resourceId).sort()) !== canonicalJson(p.resources.map(x => x.id).sort())) invalid();
      for (const m of specs) {
        const expectedDims = [...identity.map(name => ({ name, value: '${' + name + '}' })), ...r.dimensions.map(d => ({ name: d.name, value: '${native.' + r.id + '.' + d.name + '}' }))].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        if (canonicalJson(expectedDims) !== canonicalJson(m.dimensions)) invalid();
      }
      covered.push(...measurement.metricKeys);
    }
  }
  if (resources.length > 32) invalid(); unique(resources.map(r => r.id)); unique(covered);
  unique(metrics.map(m => canonicalJson([m.namespace, m.metricName, m.dimensions])));
  if (canonicalJson(covered.sort()) !== canonicalJson(metrics.map(m => m.key).sort())) invalid();
}

const LINUX_KEEP_REGEX = '^(up|node_uname_info|node_(boot_)?time_seconds|node_cpu_seconds_total|node_load(1|5|15)|node_pressure_(cpu|memory|io)_waiting_seconds_total|node_pressure_irq_stalled_seconds_total|node_memory_(Mem(Total|Free|Available)|Buffers|Cached|Slab|SReclaimable|Swap(Total|Free|Cached))_bytes|node_filesystem_(size|avail|free)_bytes|node_disk_(read_bytes|written_bytes|reads_completed|writes_completed)_total|node_disk_io_time_seconds_total|node_network_(receive|transmit)_(bytes|packets|errs|drop)_total|node_procs_(running|blocked)|node_(forks|context_switches|intr)_total|node_filefd_(allocated|maximum)|node_sockstat_(sockets_used|TCP_inuse|TCP_tw|UDP_inuse)|infrapulse_(docker_present|container_.*))$';

const LINUX_CONTAINER_KEEP_REGEX = '^container_(cpu_(usage_seconds|cfs_(throttled_)?periods)_total|memory_(usage_bytes|working_set_bytes|rss|cache)|spec_memory_limit_bytes|network_(receive|transmit)_bytes_total|fs_(reads|writes)_bytes_total|start_time_seconds|oom_events_total)$';

const WINDOWS_KEEP_REGEX = '^(up|windows_cpu_time_total|windows_cpu_logical_processor|windows_cs_(logical_processors|physical_memory_bytes)|windows_memory_(physical_total_bytes|physical_free_bytes|available_bytes|committed_bytes|commit_limit|swap_page_operations_total)|windows_os_(physical_memory_free_bytes|visible_memory_bytes|virtual_memory_bytes|virtual_memory_free_bytes|processes|time)|windows_system_(system_up_time|boot_time_timestamp|processor_queue_length|processes|threads)|windows_logical_disk_(size_bytes|free_bytes|read_bytes_total|write_bytes_total|reads_total|writes_total|split_ios_total)|windows_net_(bytes_total|bytes_received_total|bytes_sent_total|packets_received_total|packets_sent_total|packets_outbound_discarded_total|packets_received_discarded_total|packets_outbound_errors_total|packets_received_errors_total)|windows_time_computed_time_offset_seconds|infrapulse_(docker_present|container_.*)|container_(cpu_(usage_seconds|cfs_(throttled_)?periods)_total|memory_(usage_bytes|working_set_bytes|rss|cache)|spec_memory_limit_bytes|network_(receive|transmit)_bytes_total|fs_(reads|writes)_bytes_total|start_time_seconds|oom_events_total))$';

function alloyRiverConfig(platform, release) {
  if (platform === 'linux') {
    return [
      'prometheus.exporter.unix "host" {',
      'set_collectors = ["cpu","diskstats","filefd","filesystem","loadavg","meminfo","netdev","pressure","sockstat","stat","textfile","time","uname","vmstat"]',
      'textfile {',
      'directory = "/var/lib/infrapulse-agent/textfile"',
      '}',
      '}',
      'prometheus.scrape "host" {',
      'targets = prometheus.exporter.unix.host.targets',
      'scrape_interval = "60s"',
      'scrape_timeout = "30s"',
      'forward_to = [prometheus.relabel.filter.receiver]',
      '}',
      'prometheus.relabel "filter" {',
      'forward_to = [prometheus.remote_write.amp.receiver]',
      'rule {',
      'source_labels = ["__name__"]',
      `regex = "${LINUX_KEEP_REGEX}"`,
      'action = "keep"',
      '}',
      'rule {',
      'source_labels = ["fstype"]',
      'regex = "^(autofs|binfmt_misc|bpf|cgroup2?|configfs|debugfs|devpts|devtmpfs|fuse.*|hugetlbfs|iso9660|mqueue|nsfs|overlay|proc|pstore|rpc_pipefs|securityfs|squashfs|sysfs|tracefs|tmpfs|ramfs)$"',
      'action = "drop"',
      '}',
      'rule {',
      'source_labels = ["mountpoint"]',
      'regex = "^/(dev|proc|run|sys|snap|boot)(/.*)?$"',
      'action = "drop"',
      '}',
      'rule {',
      'source_labels = ["device"]',
      'regex = "^(lo|loop.*|ram.*|dm-.*|veth.*|docker.*|br-.*|sr.*)$"',
      'action = "drop"',
      '}',
      '}',
      'prometheus.exporter.cadvisor "ctr" {',
      'docker_host = "unix:///var/run/docker.sock"',
      'docker_only = true',
      'store_container_labels = false',
      'storage_duration = "5m"',
      '}',
      'prometheus.scrape "ctr" {',
      'targets = prometheus.exporter.cadvisor.ctr.targets',
      'scrape_interval = "60s"',
      'scrape_timeout = "30s"',
      'forward_to = [prometheus.relabel.ctr.receiver]',
      '}',
      'prometheus.relabel "ctr" {',
      'forward_to = [prometheus.remote_write.amp.receiver]',
      'rule {',
      'source_labels = ["__name__"]',
      `regex = "${LINUX_CONTAINER_KEEP_REGEX}"`,
      'action = "keep"',
      '}',
      'rule {',
      'source_labels = ["name"]',
      'regex = "^.+$"',
      'action = "keep"',
      '}',
      'rule {',
      'source_labels = ["name"]',
      'regex = "^/?(.+)$"',
      'target_label = "container"',
      'replacement = "$1"',
      '}',
      'rule {',
      'regex = "^(id|image|name|container_label_.*)$"',
      'action = "labeldrop"',
      '}',
      '}',
      'prometheus.remote_write "amp" {',
      'external_labels = {',
      'server_id = "${ServerId}",',
      'managed_node_id = "${ManagedNodeId}",',
      'enrollment_id = "${EnrollmentId}",',
      'platform = "linux",',
      '}',
      'endpoint {',
      `url = "${release.amp.remoteWriteUrl}"`,
      'sigv4 {',
      `region = "${release.amp.region}"`,
      '}',
      '}',
      '}',
      '',
    ].join('\n');
  }

  return [
    'prometheus.exporter.windows "host" {',
    '  enabled_collectors = ["cpu", "cs", "logical_disk", "memory", "net", "os", "system", "textfile", "time"]',
    '  textfile {',
    '    directories = ["C:\\\\ProgramData\\\\InfraPulse\\\\textfile"]',
    '  }',
    '}',
    '',
    'prometheus.scrape "host" {',
    '  targets         = prometheus.exporter.windows.host.targets',
    '  scrape_interval = "60s"',
    '  scrape_timeout  = "30s"',
    '  forward_to      = [prometheus.relabel.filter.receiver]',
    '}',
    '',
    'prometheus.relabel "filter" {',
    '  forward_to = [prometheus.remote_write.amp.receiver]',
    '  rule {',
    '    source_labels = ["__name__"]',
    `    regex         = "${WINDOWS_KEEP_REGEX}"`,
    '    action        = "keep"',
    '  }',
    '  rule {',
    '    source_labels = ["volume"]',
    '    regex         = "^HarddiskVolume.*$"',
    '    action        = "drop"',
    '  }',
    '}',
    '',
    'prometheus.remote_write "amp" {',
    '  external_labels = {',
    '    server_id       = "${ServerId}",',
    '    managed_node_id = "${ManagedNodeId}",',
    '    enrollment_id   = "${EnrollmentId}",',
    '    platform        = "windows",',
    '  }',
    '  endpoint {',
    `    url = "${release.amp.remoteWriteUrl}"`,
    '    sigv4 {',
    `      region = "${release.amp.region}"`,
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
}

/** Canonical Alloy preset payload stored in SSM Parameter Store and Neon profile_versions. */
export function alloyPreset(platform, release) {
  return {
    agent: 'alloy',
    ampRemoteWriteUrl: release.amp.remoteWriteUrl,
    config: alloyRiverConfig(platform, release),
    scrapeIntervalSeconds: 60,
    version: release.alloy.version,
  };
}
export const cloudWatchPreset = alloyPreset;

/** The sole release decoder. Missing OS entries are unavailable, not malformed defaults. */
export function decodeAgentRelease(value) {
  exact(value, ['schemaVersion', 'platforms']);
  if (value.schemaVersion !== 1) invalid();
  if (!value.platforms || typeof value.platforms !== 'object' || Array.isArray(value.platforms) || Object.getPrototypeOf(value.platforms) !== Object.prototype
    || Object.keys(value.platforms).some(p => !['linux', 'windows'].includes(p))) invalid();
  for (const [platform, p] of Object.entries(value.platforms)) {
    exact(p, ['revision', 'ssm', 'helper', 'alloy', 'amp', 'configuration', 'metrics', 'parameter']);
    text(p.revision, hash); artifact(p.ssm, platform, false); artifact(p.helper, platform, true);
    if (p.ssm.version !== '3.3.5828.0') invalid();
    alloyArtifact(p.alloy, platform);
    ampConfig(p.amp);
    configuration(p, platform);
    exact(p.parameter, ['name', 'version', 'tier', 'sha256']);
    if (p.parameter.name !== `/infrapulse/lab-20261118/presets/${platform}` || !Number.isSafeInteger(p.parameter.version) || p.parameter.version < 1 || p.parameter.version > 1000000 || !['Standard', 'Advanced'].includes(p.parameter.tier)) invalid();
    text(p.parameter.sha256, hash);
    const preset = alloyPreset(platform, p);
    if (releaseSha256(preset) !== p.parameter.sha256 || Buffer.byteLength(canonicalJson(preset)) > (p.parameter.tier === 'Standard' ? 4096 : 8192)) invalid();
    const { revision, ...body } = p;
    if (releaseSha256(body) !== revision) invalid();
  }
  return JSON.parse(canonicalJson(value));
}
