import { createHash } from 'node:crypto';
// ARCHIVAL ONLY: historical test/source exports; no current release consumer.
// agent-release.mjs is the sole CURRENT decoder. This module is not packaged.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const MAX_BYTES = 262144;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const DIM = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const BINDING = ['EnrollmentId', 'ManagedNodeId', 'ServerId'];
const GROUPS = ['cpu', 'memory', 'disk', 'network'];
const STATS = ['Average', 'Maximum', 'Minimum', 'Sum'];
const BASELINE = { intervalSeconds: 60, freshSeconds: 300, futureSeconds: 30, maxActiveNodes: 5, maxConcurrentOnboarding: 2 };

// Reject non-JSON JS values/accessors before reading fields. Bounded work, no I/O.
function jsonText(value) {
  let nodes = 0;
  const ancestors = new Set();
  function ordered(v, depth) {
    if (++nodes > 20000 || depth > 20) throw Error('INVALID_JSON');
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      if (v.length > 4096) throw Error('INVALID_JSON');
      return v;
    }
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (!v || typeof v !== 'object' || ancestors.has(v)) throw Error('INVALID_JSON');
    const array = Array.isArray(v);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(v))) throw Error('INVALID_JSON');
    if (Object.getOwnPropertySymbols(v).length) throw Error('INVALID_JSON');
    const descriptors = Object.getOwnPropertyDescriptors(v);
    const keys = Object.keys(descriptors).filter(k => !(array && k === 'length'));
    if (array && (keys.length !== v.length || keys.some((k, i) => k !== String(i)))) throw Error('INVALID_JSON');
    ancestors.add(v);
    const result = array ? [] : Object.create(null);
    for (const key of keys.sort()) {
      const d = descriptors[key];
      if (key.length > 128 || !d.enumerable || !('value' in d)) throw Error('INVALID_JSON');
      result[key] = ordered(d.value, depth + 1);
    }
    ancestors.delete(v);
    return result;
  }
  const text = JSON.stringify(ordered(value, 0));
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw Error('INVALID_JSON');
  return text;
}

/** Canonical JSON: recursively sorted object keys; array order retained; SHA256 UTF-8. */
export function canonicalSha256(value) {
  try { return createHash('sha256').update(jsonText(value), 'utf8').digest('hex'); }
  catch { throw Error('INVALID_JSON'); }
}

// Small closed schema vocabulary: every object key is required, no extension bags.
const text = max => ({ scalar: v => typeof v === 'string' && v.length > 0 && v.length <= max });
const literal = expected => ({ scalar: v => v === expected });
const oneOf = values => ({ scalar: v => values.includes(v) });
const integer = { scalar: v => Number.isSafeInteger(v) && v >= 1 && v <= 1000000 };
const boolean = { scalar: v => typeof v === 'boolean' };
const nullable = schema => ({ nullable: schema });
const array = (item, max) => ({ item, max });
const object = fields => ({ fields });
const dimension = object({ name: text(64), value: text(256) });
const artifactSchema = object({ schemaVersion: literal(1), platforms: array(object({
  platform: oneOf(['linux', 'windows']), os: text(64), arch: text(16),
  packages: array(object({ name: oneOf(['ssm', 'cloudwatch']), version: text(64), url: text(1024), sha256: text(64), signer: nullable(object({ required: boolean, subject: text(128) })) }), 2),
  identity: object({ adapter: text(64), file: text(256), profile: text(64), evidenceId: text(64) }),
  resources: array(object({ id: text(64), kind: oneOf(['cpu', 'memory', 'filesystem', 'interface']), dimensions: array(dimension, 10) }), 32),
  evidenceIds: array(text(64), 16),
}), 2) });
const artifactV2Schema = object({ schemaVersion: literal(2), platforms: array(object({
  ...artifactSchema.fields.platforms.item.fields,
  registration: object({ adapter: literal('ssm-setupcli-installed-agent-v1'), helper: object({
    version: text(71), url: text(1024), sha256: text(64), signer: nullable(object({ required: boolean, subject: text(128) })),
  }), evidenceId: text(64) }),
}), 2) });
// v3 adds only a closed Linux lifecycle producer. Windows remains null until N3.
const lifecycleSchema = object({
  schemaVersion: literal(1), adapter: literal('linux-cw-deb-v1'), packageVersion: text(64),
  serviceFile: oneOf(['/etc/systemd/system/amazon-cloudwatch-agent.service', '/usr/lib/systemd/system/amazon-cloudwatch-agent.service']),
  files: object(Object.fromEntries(['agent', 'downloader', 'translator', 'control', 'start', 'service'].map(k => [k, text(64)]))),
  credentials: object({ adapter: literal('ssm-root-shared-file-v1'), file: literal('/root/.aws/credentials'), profile: literal('default'), serviceFile: oneOf(['/usr/lib/systemd/system/amazon-ssm-agent.service', '/etc/systemd/system/amazon-ssm-agent.service']), serviceFragmentSha256: text(64), evidenceId: text(64) }),
  execution: literal('n4-ssm-envelope-v1'),
  presetSource: object({ adapter: literal('cw-packaged-ssm-v1'), parameterName: literal('/infrapulse/lab-20261118/presets/linux'), parameterVersion: integer,
    envelopeSha256: text(64), configSource: object({ schemaVersion: literal(1), plugins: array(object({
      plugin: oneOf(['cpu', 'mem', 'disk', 'net']),
      resources: array(object({ resourceId: text(64), selector: text(128) }), 32),
      measurements: array(object({ input: text(64), metricKeys: array(text(64), 32) }), 32),
    }), 4) }),
  }), evidenceIds: array(text(64), 16),
});
const artifactV3Schema = object({ schemaVersion: literal(3), platforms: array(object({
  ...artifactV2Schema.fields.platforms.item.fields, lifecycle: nullable(lifecycleSchema),
}), 2) });
// v4 retains the exact v3 Linux object and adds a closed Windows counterpart.
const windowsLifecycleSchema = object({
  schemaVersion: literal(1), adapter: literal('windows-cw-msi-v1'), packageVersion: text(64), productCode: text(38),
  files: object(Object.fromEntries(['agent', 'downloader', 'translator', 'control', 'start'].map(k => [k, text(64)]))),
  credentials: object({ adapter: literal('ssm-system-shared-file-v1'), file: literal('C:\\Windows\\System32\\config\\systemprofile\\.aws\\credentials'), profile: literal('default'), serviceBinarySha256: text(64), evidenceId: text(64) }),
  execution: literal('n4-ssm-envelope-v1'),
  presetSource: object({ adapter: literal('cw-packaged-ssm-v1'), parameterName: literal('/infrapulse/lab-20261118/presets/windows'), parameterVersion: integer,
    envelopeSha256: text(64), configSource: object({ schemaVersion: literal(1), plugins: array(object({
      plugin: oneOf(['Processor', 'Memory', 'LogicalDisk', 'Network Interface']),
      resources: array(object({ resourceId: text(64), selector: { scalar: v => typeof v === 'string' && v.length <= 128 } }), 32),
      measurements: array(object({ input: text(64), metricKeys: array(text(64), 32) }), 32),
    }), 4) }),
  }), evidenceIds: array(text(64), 16),
});
const artifactV4Schema = object({ schemaVersion: literal(4), platforms: array(object({
  ...artifactV2Schema.fields.platforms.item.fields,
  lifecycle: { scalar: v => matches(v, lifecycleSchema) || matches(v, windowsLifecycleSchema) },
}), 2) });
const metricSchema = object({ schemaVersion: literal(1), namespace: text(64),
  limits: object(Object.fromEntries(Object.keys(BASELINE).map(k => [k, integer]))),
  presets: array(object({ id: text(64), platform: oneOf(['linux', 'windows']), version: integer, hash: text(64), metrics: array(object({
    key: text(64), group: oneOf(GROUPS), namespace: text(64), metricName: text(128), resourceId: nullable(text(64)),
    dimensions: array(dimension, 13), statistic: text(32), aggregation: array(text(32), 4), unit: text(32), periodSeconds: integer, semantics: text(16),
  }), 128) }), 2),
});
const qualificationSchema = object({ schemaVersion: literal(1), status: oneOf(['NOT RUN', 'candidate', 'qualified']), synthetic: boolean,
  artifactsHash: text(64), metricsHash: text(64),
  sources: array(object({ id: text(64), kind: oneOf(['official-documentation', 'native-test', 'operator-review']), reference: text(1024), sha256: text(64) }), 64),
  checks: object(Object.fromEntries(['nativePackages', 'metricManifest', 'credentialsAdapter', 'ssmDocument', 'alertApi'].map(k => [k, array(text(64), 16)]))),
  review: object({ operator: text(64), reviewedAt: text(24), evidenceId: text(64) }),
});
function matches(value, schema) {
  if (schema.scalar) return schema.scalar(value);
  if (schema.nullable) return value === null || matches(value, schema.nullable);
  if (schema.item) return Array.isArray(value) && value.length <= schema.max && value.every(v => matches(v, schema.item));
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === Object.keys(schema.fields).length
    && Object.entries(schema.fields).every(([k, s]) => Object.hasOwn(value, k) && matches(value[k], s));
}
const unique = values => new Set(values).size === values.length;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sortedUniqueNames = dims => unique(dims.map(d => d.name)) && same(dims.map(d => d.name), dims.map(d => d.name).sort());
const safeNativeName = name => DIM.test(name) && !BINDING.includes(name) && !/hash|time|activation|code|secret|token|credential/i.test(name);
function safeUrl(raw, hosts) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && hosts.includes(u.hostname) && !u.port && !u.username && !u.password
      && !u.search && !u.hash && u.href === raw && !/%|\\|\/\.\.?\//.test(u.pathname) ? u : null;
  } catch { return null; }
}
function officialReference(raw) {
  const u = safeUrl(raw, ['docs.aws.amazon.com', 'aws.amazon.com', 'github.com']);
  return !!u && u.pathname !== '/' && (u.hostname !== 'github.com' || /^\/aws\//.test(u.pathname));
}
function localReference(raw) {
  return /^evidence\/[A-Za-z0-9_/-]+\.(json|md|txt)$/.test(raw) && !raw.includes('..') && raw.length <= 256;
}
function immutableArtifact(pkg, platform, sourceVersion) {
  const hosts = pkg.name === 'ssm'
    ? ['amazon-ssm-ap-southeast-1.s3.ap-southeast-1.amazonaws.com', 's3.ap-southeast-1.amazonaws.com']
    : ['amazoncloudwatch-agent.s3.amazonaws.com', 'amazoncloudwatch-agent-ap-southeast-1.s3.ap-southeast-1.amazonaws.com'];
  const u = safeUrl(pkg.url, hosts);
  return (pkg.name === 'cloudwatch' && (sourceVersion === 4 || (platform === 'linux' && sourceVersion === 3))
    ? /^\d+\.\d+\.\d+(?:\.\d+|b\d+)?$/.test(pkg.version)
    : /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(pkg.version)) && HASH.test(pkg.sha256) && !!u
    && (u.hostname !== 's3.ap-southeast-1.amazonaws.com' || u.pathname.startsWith('/amazon-ssm-ap-southeast-1/'))
    && u.pathname.split('/').includes(pkg.version) && !/latest|stable|current/i.test(u.pathname)
    && (platform === 'linux' ? /\.deb$/.test(u.pathname) : (pkg.name === 'ssm' ? /\.exe$/.test(u.pathname) : /\.msi$/.test(u.pathname)));
}
function identityPath(file, platform) {
  return !file.includes('..') && (platform === 'linux'
    ? /^\/(var\/lib|etc)\/amazon\/ssm\/[A-Za-z0-9_./-]+$/.test(file)
    : /^C:\\ProgramData\\Amazon\\SSM\\[A-Za-z0-9_.\\-]+$/.test(file));
}

// Closed input-counter mapping. Output names never select a native counter.
// Mirrors assertCanonicalLifecycle in the typed consumer; I1 remains authority.
function windowsLifecycleSource(native, preset, sources) {
  const l = native.lifecycle;
  if (!matches(l, windowsLifecycleSchema) || !/^\{[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}\}$/.test(l.productCode)
    || !/^\d{1,3}\.\d{1,3}\.\d{1,5}$/.test(l.packageVersion) || l.packageVersion.split('.').some((v, i) => Number(v) > (i === 2 ? 65535 : 255))
    || Object.values(l.files).some(v => !HASH.test(v)) || !HASH.test(l.credentials.serviceBinarySha256)
    || !sources.some(s => s.id === l.credentials.evidenceId && s.kind === 'native-test')) return false;
  if (!l.evidenceIds.length || !unique(l.evidenceIds) || l.evidenceIds.some(id => !sources.some(s => s.id === id))
    || !['official-documentation', 'native-test'].every(kind => l.evidenceIds.some(id => sources.some(s => s.id === id && s.kind === kind)))) return false;
  const p = l.presetSource, plugins = p.configSource.plugins;
  if (p.parameterVersion !== preset.version || !HASH.test(p.envelopeSha256) || plugins.length !== 4 || !unique(plugins.map(p => p.plugin))) return false;
  const groups = { Processor: 'cpu', Memory: 'memory', LogicalDisk: 'disk', 'Network Interface': 'network' };
  const kinds = { Processor: 'cpu', Memory: 'memory', LogicalDisk: 'filesystem', 'Network Interface': 'interface' };
  const inputs = {
    Processor: { '% Processor Time': ['Percent', 'gauge'] },
    Memory: { '% Committed Bytes In Use': ['Percent', 'gauge'], 'Committed Bytes': ['Bytes', 'gauge'] },
    LogicalDisk: { '% Free Space': ['Percent', 'gauge'] },
    'Network Interface': { 'Bytes Sent/sec': ['Bytes/Second', 'rate'], 'Bytes Received/sec': ['Bytes/Second', 'rate'], 'Packets Sent/sec': ['Count/Second', 'rate'], 'Packets Received/sec': ['Count/Second', 'rate'] },
  };
  const selected = [], covered = [];
  for (const plugin of plugins) {
    const name = plugin.plugin, rs = plugin.resources;
    if (!rs.length || !unique(rs.map(r => r.resourceId)) || !unique(rs.map(r => r.selector)) || (['Processor', 'Memory'].includes(name) && rs.length !== 1)) return false;
    for (const r of rs) {
      const actual = native.resources.find(a => a.id === r.resourceId);
      if (!actual || actual.kind !== kinds[name] || !same(actual.dimensions, name === 'Memory' ? [{ name: 'objectname', value: name }] : [{ name: 'instance', value: r.selector }, { name: 'objectname', value: name }])
        || (name === 'Processor' ? r.selector !== '_Total' : name === 'Memory' ? r.selector !== '' : name === 'LogicalDisk' ? !/^[A-Z]:$/.test(r.selector) : !/^[A-Za-z0-9 _().-]{1,128}$/.test(r.selector) || /loopback/i.test(r.selector))) return false;
      selected.push(r.resourceId);
    }
    if (!plugin.measurements.length || !unique(plugin.measurements.map(m => m.input))) return false;
    for (const measurement of plugin.measurements) {
      const semantics = inputs[name]?.[measurement.input], keys = measurement.metricKeys, specs = keys.map(k => preset.metrics.find(m => m.key === k));
      if (!semantics || !keys.length || !unique(keys) || specs.some(m => !m || m.group !== groups[name] || m.unit !== semantics[0] || m.semantics !== semantics[1])
        || new Set(specs.map(m => m?.metricName)).size !== 1 || !same(specs.map(m => m?.resourceId).sort(), rs.map(r => r.resourceId).sort())) return false;
      covered.push(...keys);
    }
  }
  return unique(selected) && same(selected.sort(), native.resources.map(r => r.id).sort()) && unique(covered) && same(covered.sort(), preset.metrics.map(m => m.key).sort())
    && p.envelopeSha256 === canonicalSha256({ schemaVersion: 1, presetId: preset.id, presetVersion: preset.version, presetHash: preset.hash, configSource: p.configSource });
}
function lifecycleSource(native, preset, sources, version) {
  if (native.platform === 'windows') return version === 3 ? native.lifecycle === null : windowsLifecycleSource(native, preset, sources);
  const l = native.lifecycle;
  if (!matches(l, lifecycleSchema) || !/^[0-9][0-9a-z.+:~\-]{0,63}$/.test(l.packageVersion)
    || Object.values(l.files).some(v => !HASH.test(v)) || !HASH.test(l.credentials.serviceFragmentSha256)
    || !sources.some(s => s.id === l.credentials.evidenceId && s.kind === 'native-test')) return false;
  const evidence = l.evidenceIds;
  if (!evidence.length || !unique(evidence) || evidence.some(id => !sources.some(s => s.id === id))
    || !['official-documentation', 'native-test'].every(kind => evidence.some(id => sources.some(s => s.id === id && s.kind === kind)))) return false;
  const p = l.presetSource, plugins = p.configSource.plugins;
  if (p.parameterVersion !== preset.version || !HASH.test(p.envelopeSha256) || plugins.length !== 4 || !unique(plugins.map(p => p.plugin))) return false;
  const inputs = {
    cpu: Object.fromEntries(['usage_active', 'usage_idle', 'usage_user', 'usage_system', 'usage_iowait', 'usage_steal', 'usage_nice', 'usage_irq', 'usage_softirq', 'usage_guest', 'usage_guest_nice'].map(k => [k, ['Percent', 'gauge']])),
    mem: { used_percent: ['Percent', 'gauge'], available_percent: ['Percent', 'gauge'], used: ['Bytes', 'gauge'], available: ['Bytes', 'gauge'], total: ['Bytes', 'gauge'] },
    disk: { used_percent: ['Percent', 'gauge'], used: ['Bytes', 'gauge'], free: ['Bytes', 'gauge'], total: ['Bytes', 'gauge'], inodes_free: ['Count', 'gauge'], inodes_used: ['Count', 'gauge'], inodes_total: ['Count', 'gauge'] },
    net: { bytes_sent: ['Bytes/Second', 'rate'], bytes_recv: ['Bytes/Second', 'rate'], packets_sent: ['Count/Second', 'rate'], packets_recv: ['Count/Second', 'rate'] },
  };
  const selected = [], covered = [];
  for (const plugin of plugins) {
    const name = plugin.plugin, rs = plugin.resources;
    if (!unique(rs.map(r => r.resourceId)) || !unique(rs.map(r => r.selector)) || (name === 'mem' ? rs.length !== 0 : !rs.length) || (name === 'cpu' && rs.length !== 1)) return false;
    for (const r of rs) {
      const actual = native.resources.find(a => a.id === r.resourceId);
      if (!actual || actual.kind !== { cpu: 'cpu', disk: 'filesystem', net: 'interface' }[name]) return false;
      const ds = actual.dimensions;
      const expectedNames = name === 'cpu' ? ['cpu'] : name === 'disk' ? ['device', 'fstype', 'path'] : ['interface'];
      if (!same(ds.map(d => d.name), expectedNames)) return false;
      if (name === 'cpu' ? r.selector !== 'cpu-total' || ds[0].value !== r.selector
        : name === 'net' ? !/^[A-Za-z0-9_.:-]{1,64}$/.test(r.selector) || r.selector === 'lo' || ds[0].value !== r.selector
          : !/^\/(?:[A-Za-z0-9_.-]+\/?)*$/.test(r.selector) || r.selector.includes('..') || ds.find(d => d.name === 'path')?.value !== r.selector || /^(?:proc|sysfs|tmpfs|devtmpfs|overlay|squashfs|cgroup2?|debugfs|tracefs|securityfs|pstore|autofs|fusectl|mqueue|hugetlbfs|rpc_pipefs|nsfs)$/.test(ds.find(d => d.name === 'fstype')?.value ?? '')) return false;
      selected.push(r.resourceId);
    }
    if (!plugin.measurements.length || !unique(plugin.measurements.map(m => m.input))) return false;
    for (const measurement of plugin.measurements) {
      const semantics = inputs[name]?.[measurement.input], keys = measurement.metricKeys;
      const specs = keys.map(k => preset.metrics.find(m => m.key === k));
      if (!semantics || !keys.length || !unique(keys) || specs.some(m => !m || m.group !== { cpu: 'cpu', mem: 'memory', disk: 'disk', net: 'network' }[name] || m.unit !== semantics[0] || m.semantics !== semantics[1]) || new Set(specs.map(m => m?.metricName)).size !== 1
        || (name === 'mem' ? specs.length !== 1 || specs[0]?.resourceId !== null : !same(specs.map(m => m?.resourceId).sort(), rs.map(r => r.resourceId).sort()))) return false;
      covered.push(...keys);
    }
  }
  return unique(selected) && same(selected.sort(), native.resources.map(r => r.id).sort()) && unique(covered)
    && same(covered.sort(), preset.metrics.map(m => m.key).sort())
    && p.envelopeSha256 === canonicalSha256({ schemaVersion: 1, presetId: preset.id, presetVersion: preset.version, presetHash: preset.hash, configSource: p.configSource });
}
/**
 * Pure, synchronous, no I/O/network and no input mutation.
 * @returns {{ok:boolean, issues:string[]}} Only finite, input-independent codes.
 * release defaults true; release:false also admits explicitly synthetic unit evidence.
 */
export function validateContracts(input) {
  const issues = new Set();
  const reject = code => issues.add(code);
  const result = () => ({ ok: issues.size === 0, issues: [...issues] });
  try {
    // Copy bounded JSON, so no caller-supplied getters/prototypes enter schema validation.
    const encoded = jsonText(input);
    if (/(?:AKIA|ASIA)[A-Z0-9]{16}|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|(?:AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|secretAccessKey|activationCode)\s*[:=]/i.test(encoded)) {
      reject('SECRET'); return result();
    }
    const data = JSON.parse(encoded);
    if (!data || Array.isArray(data) || typeof data !== 'object'
      || Object.keys(data).some(k => !['artifacts', 'metrics', 'qualification', 'release'].includes(k))
      || (Object.hasOwn(data, 'release') && typeof data.release !== 'boolean')
      || !matches(data.artifacts, data.artifacts?.schemaVersion === 4 ? artifactV4Schema : data.artifacts?.schemaVersion === 3 ? artifactV3Schema : data.artifacts?.schemaVersion === 2 ? artifactV2Schema : artifactSchema) || !matches(data.metrics, metricSchema) || !matches(data.qualification, qualificationSchema)) {
      reject('SCHEMA'); return result();
    }
    const { artifacts, metrics, qualification: q } = data;
    const release = data.release ?? true;
    if (q.status !== 'qualified') reject('NOT_QUALIFIED');
    if (release && q.synthetic) reject('SYNTHETIC_RELEASE');

    const sources = new Map(q.sources.map(s => [s.id, s]));
    if (!unique(q.sources.map(s => s.id)) || q.sources.length < 3) reject('EVIDENCE');
    for (const s of q.sources) {
      if (!ID.test(s.id) || !HASH.test(s.sha256) || !(s.kind === 'official-documentation' ? officialReference(s.reference) : localReference(s.reference))) reject('EVIDENCE');
    }
    const evidence = (ids, kinds) => ids.length > 0 && unique(ids) && ids.every(id => sources.has(id))
      && kinds.every(kind => ids.some(id => sources.get(id)?.kind === kind));
    for (const ids of Object.values(q.checks)) if (!evidence(ids, ['official-documentation', 'native-test'])) reject('EVIDENCE');
    if (!ID.test(q.review.operator) || sources.get(q.review.evidenceId)?.kind !== 'operator-review'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(q.review.reviewedAt)
      || !Number.isFinite(Date.parse(q.review.reviewedAt)) || new Date(q.review.reviewedAt).toISOString() !== q.review.reviewedAt) reject('EVIDENCE');

    if (!same(Object.keys(BASELINE).map(k => metrics.limits[k]), Object.values(BASELINE))) reject('LIMIT');
    if (metrics.namespace !== 'InfraPulse/Lab') reject('METRIC');
    if (artifacts.platforms.length !== 2 || !unique(artifacts.platforms.map(p => p.platform))) reject('ARTIFACT');
    for (const p of artifacts.platforms) {
      const windows = p.platform === 'windows';
      if (p.os !== (windows ? 'Windows Server 2022 English' : 'Ubuntu 24.04') || p.arch !== (windows ? 'x64' : 'amd64')
        || p.packages.length !== 2 || !unique(p.packages.map(x => x.name))) reject('ARTIFACT');
      for (const pkg of p.packages) {
        if (!immutableArtifact(pkg, p.platform, artifacts.schemaVersion) || (windows
          ? !pkg.signer?.required || !['Amazon Web Services, Inc.', 'Amazon.com Services LLC'].includes(pkg.signer.subject)
          : pkg.signer !== null)) reject('ARTIFACT');
      }
      if (artifacts.schemaVersion === 1) {
        if (p.identity.adapter !== 'ssm-local-identity-v1' || p.identity.profile !== 'AmazonCloudWatchAgent' || !identityPath(p.identity.file, p.platform)) reject('ARTIFACT');
      } else {
        const helper = p.registration.helper;
        const helperUrl = 'https://amazon-ssm-ap-southeast-1.s3.ap-southeast-1.amazonaws.com/latest/' + (windows ? 'windows_amd64/ssm-setup-cli.exe' : 'debian_amd64/ssm-setup-cli');
        if (p.identity.adapter !== 'ssm-registration-receipt-v1' || p.identity.profile !== 'none'
          || p.identity.file !== (windows ? 'C:\\ProgramData\\InfraPulse AWS\\registration.json' : '/var/lib/infrapulse-aws/registration.json')
          || p.packages.find(pkg => pkg.name === 'ssm')?.version !== '3.3.5828.0'
          || helper.version !== 'sha256:' + helper.sha256 || helper.url !== helperUrl || !HASH.test(helper.sha256) || (windows
            ? !helper.signer?.required || !['Amazon Web Services, Inc.', 'Amazon.com Services LLC'].includes(helper.signer.subject)
            : helper.signer !== null)
          || sources.get(p.registration.evidenceId)?.kind !== 'native-test') reject('ARTIFACT');
      }
      if (sources.get(p.identity.evidenceId)?.kind !== 'native-test' || !evidence(p.evidenceIds, ['official-documentation', 'native-test'])) reject('EVIDENCE');
      if (!unique(p.resources.map(r => r.id))) reject('DIMENSION');
      for (const r of p.resources) {
        if (!ID.test(r.id) || !r.dimensions.length || !sortedUniqueNames(r.dimensions)
          || r.dimensions.some(d => !safeNativeName(d.name) || !/^[\x20-\x7e]{1,128}$/.test(d.value) || d.value.includes('${'))) reject('DIMENSION');
      }
    }
    if (metrics.presets.length !== 2 || !unique(metrics.presets.map(p => p.platform)) || !unique(metrics.presets.map(p => p.id))) reject('METRIC');
    for (const p of metrics.presets) {
      if (!ID.test(p.id) || !unique(p.metrics.map(m => m.key)) || !GROUPS.every(g => p.metrics.some(m => m.group === g))) reject('METRIC');
      const platform = artifacts.platforms.find(a => a.platform === p.platform);
      for (const m of p.metrics) {
        if (!ID.test(m.key) || !/^[A-Za-z0-9 _%./()-]{1,128}$/.test(m.metricName) || m.namespace !== metrics.namespace
          || !STATS.includes(m.statistic) || !m.aggregation.length || !unique(m.aggregation)
          || m.aggregation.some(a => !STATS.includes(a)) || !m.aggregation.includes(m.statistic)) reject('METRIC');
        const units = { gauge: ['Percent', 'Bytes', 'Count'], counter: ['Bytes', 'Count'], rate: ['Bytes/Second', 'Count/Second'] };
        if (!units[m.semantics]?.includes(m.unit)
          || (m.group !== 'network' && m.semantics !== 'gauge') || (m.group === 'cpu' && m.unit !== 'Percent')
          || (m.group === 'network' && m.semantics === 'gauge')) reject('METRIC');
        if (m.periodSeconds !== 60) reject('LIMIT');
        const resource = platform?.resources.find(r => r.id === m.resourceId);
        const requiredKind = { cpu: 'cpu', memory: 'memory', disk: 'filesystem', network: 'interface' }[m.group];
        if ((m.resourceId !== null && (!resource || resource.kind !== requiredKind)) || (['disk', 'network'].includes(m.group) && !resource)) reject('DIMENSION');
        const expected = BINDING.map(name => ({ name, value: '${' + name + '}' }));
        if (resource) expected.push(...resource.dimensions.map(d => ({ name: d.name, value: '${native.' + resource.id + '.' + d.name + '}' })));
        expected.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        if (!sortedUniqueNames(m.dimensions) || !same(m.dimensions.map(d => [d.name, d.value]), expected.map(d => [d.name, d.value]))) reject('DIMENSION');
      }
      const { hash, ...body } = p;
      if (!HASH.test(hash) || hash !== canonicalSha256(body)) reject('HASH');
    }
    if (artifacts.schemaVersion === 3 || artifacts.schemaVersion === 4) for (const native of artifacts.platforms) {
      const preset = metrics.presets.find(p => p.platform === native.platform);
      if (!preset || !lifecycleSource(native, preset, q.sources, artifacts.schemaVersion)) reject('ARTIFACT');
    }
    if (!HASH.test(q.artifactsHash) || !HASH.test(q.metricsHash)
      || q.artifactsHash !== canonicalSha256(artifacts) || q.metricsHash !== canonicalSha256(metrics)) reject('HASH');
    return result();
  } catch { return { ok: false, issues: ['INVALID_JSON'] }; }
}

// JSON.parse validates grammar; a bounded token scan additionally rejects duplicate
// object keys (including escaped aliases) before schema/hash interpretation.
function parseStrictJson(text) {
  const value = JSON.parse(text);
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '{') stack.push(new Set());
    else if (char === '[') stack.push(null);
    else if (char === '}' || char === ']') stack.pop();
    else if (char === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') i++;
        i++;
      }
      let next = i + 1;
      while (/\s/.test(text[next] ?? '') && next < text.length) next++;
      if (text[next] === ':') {
        const key = JSON.parse(text.slice(start, i + 1));
        const keys = stack.at(-1);
        if (!keys || keys.has(key)) throw Error('INVALID_JSON');
        keys.add(key);
      }
    }
  }
  return value;
}

async function checkCli() {
  return { exit: 1, value: { ok: false, issues: ['ARCHIVAL_VALIDATOR_RETIRED'] } };
}

// Importing the module never executes the CLI or reads files.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { exit, value } = await checkCli(process.argv.slice(2));
    console.log(JSON.stringify(value)); process.exitCode = exit;
  } catch {
    console.log(JSON.stringify({ ok: false, issues: ['FILES_UNAVAILABLE'] })); process.exitCode = 1;
  }
}
