import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { open, lstat, mkdir, rename, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { decodeAgentRelease, canonicalJson, cloudWatchPreset } from './agent-release.mjs';

const ROOT = new URL('../../', import.meta.url);
const LIMIT = 262144;
const TOKENS = ['SERVER_ID', 'ENROLLMENT_ID', 'GENERATION', 'ACTIVATION_ID', 'ACTIVATION_CODE', 'REGION', 'PRESET_HASH'];
const OUTPUT = 'services/management-backend/generated/bootstrap-assets.json';
const SOURCES = ['agents/ssm/templates/bootstrap.sh.tpl', 'agents/ssm/templates/bootstrap.ps1.tpl', 'agents/ssm/linux/bootstrap.sh', 'agents/ssm/windows/bootstrap.ps1'];
const RELEASE = 'deploy/agent-release.json';
const DOCUMENT_OUTPUTS = ['deploy/generated/ssm/configure.json', 'deploy/generated/ssm/decommission.json', 'deploy/generated/ssm/presets.json'];
const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
const fail = code => { throw Error(code); };
export const encodeBundle = bundle => canonicalJson(bundle) + '\n';
const shell = s => "'" + String(s).replaceAll("'", "'\\''") + "'";
const powershell = s => "'" + String(s).replaceAll("'", "''") + "'";
function source(text) {
  if (typeof text !== 'string' || !text.length || Buffer.byteLength(text) > LIMIT || /\r|\0|\uFEFF/.test(text)) fail('SOURCE_INVALID');
  return text;
}
function metadata(platform, release) {
  const values = {
    canonical_preset_hash: release.parameter.sha256, configuration_version: release.revision,
    ssm_version: release.ssm.version, ssm_url: release.ssm.url, ssm_sha256: release.ssm.sha256,
    helper_version: release.helper.version, helper_url: release.helper.url, helper_sha256: release.helper.sha256,
  };
  if (platform === 'linux') return 'ip_canonical_metadata() {\n' + Object.entries(values).map(([k, v]) => `  ${k}=${shell(v)}`).join('\n') + '\n}';
  const names = { canonical_preset_hash: 'PresetHash', configuration_version: 'ConfigurationVersion', ssm_version: 'SsmVersion', ssm_url: 'SsmUrl', ssm_sha256: 'SsmSha256', helper_version: 'HelperVersion', helper_url: 'HelperUrl', helper_sha256: 'HelperSha256' };
  return 'function Initialize-InfraPulseCanonical {\n    $script:Canonical = @{\n' + Object.entries(values).map(([k, v]) => `        ${names[k]} = ${powershell(v)}`).join('\n') + `\n        SsmSigner = ${powershell(release.ssm.signer.subject)}\n        SsmCertificateSha256 = ${powershell(release.ssm.signer.certificateSha256)}\n        HelperSigner = ${powershell(release.helper.signer.subject)}\n        HelperCertificateSha256 = ${powershell(release.helper.signer.certificateSha256)}\n    }\n}`;
}
/** Registration-only assets. Old triplet inputs are intentionally not accepted. */
export function compileBootstrap({ release, templates, bodies } = {}) {
  if (!release) fail('RELEASE_CONFIG_REQUIRED');
  const input = decodeAgentRelease(release);
  const entries = Object.entries(input.platforms).map(([platform, platformRelease]) => {
    let template = source(templates[platform]);
    const slots = { CANONICAL_METADATA: metadata(platform, platformRelease), BOOTSTRAP_BODY: source(bodies[platform]) };
    for (const [name, value] of Object.entries(slots)) {
      const token = `@@${name}@@`;
      if (template.split(token).length !== 2) fail('SOURCE_INVALID');
      template = template.replace(token, () => value);
    }
    if (/@@[A-Z_]+@@/.test(template)) fail('SOURCE_INVALID');
    const seen = new Set();
    const withoutTokens = template.replace(/\{\{([^{}]*)\}\}/g, (_, key) => { if (!TOKENS.includes(key)) fail('SOURCE_INVALID'); seen.add(key); return ''; });
    if (seen.size !== TOKENS.length || /\{\{/.test(withoutTokens)) fail('SOURCE_INVALID');
    const worst = template.replace(/\{\{([^{}]*)\}\}/g, (_, key) => key === 'ACTIVATION_CODE' ? 'A'.repeat(250) : key === 'GENERATION' ? '2147483647' : key === 'REGION' ? 'ap-southeast-1' : key === 'PRESET_HASH' ? 'a'.repeat(64) : 'a'.repeat(36));
    if (Buffer.byteLength(worst, 'utf8') > LIMIT || template.split('\n').some(line => line.includes('{{ACTIVATION_CODE}}') && /(?:https?:|file:|data:|ftp:|\/\/)/i.test(line))) fail('SOURCE_INVALID');
    return { platform, configurationVersion: platformRelease.revision, presetHash: platformRelease.parameter.sha256, templateSha256: sha(template), template };
  });
  const bundle = { schemaVersion: 1, entries };
  if (Buffer.byteLength(encodeBundle(bundle)) > LIMIT) fail('BUNDLE_TOO_LARGE');
  return bundle;
}
const UUID = '[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}';
function commandParameters() {
  const string = allowedPattern => ({ type: 'String', allowedPattern });
  return {
    ServerId: string(`^${UUID}$`), EnrollmentId: string(`^${UUID}$`), ManagedNodeId: string('^mi-[0-9a-f]{17}$'), OperationId: string(`^${UUID}$`),
    PreviousOperationId: { ...string(`^(${UUID})?$`), default: '' },
    Platform: string('^(linux|windows)$'), ConfigurationVersion: string('^[a-f0-9]{64}$'),
    PresetName: string('^/infrapulse/lab-20261118/presets/(linux|windows)$'), PresetVersion: string('^[1-9][0-9]{0,5}$|^1000000$'),
  };
}
/** @param {import('./agent-release.mjs').AgentRelease} release decoded once at its input boundary */
export function compileAgentDocuments(release) {
  const configure = JSON.parse(source(readFileSync(new URL('agents/ssm/documents/configure.json.tpl', ROOT), 'utf8')));
  const cleanup = JSON.parse(source(readFileSync(new URL('agents/ssm/documents/cleanup.json.tpl', ROOT), 'utf8')));
  const presets = {};
  for (const [platform, p] of Object.entries(release.platforms)) {
    presets[platform] = { name: p.parameter.name, version: String(p.parameter.version), tier: p.parameter.tier, value: canonicalJson(cloudWatchPreset(platform, p)), sha256: p.parameter.sha256 };
  }
  const step = (platform, action, lines) => ({
    action: platform === 'linux' ? 'aws:runShellScript' : 'aws:runPowerShellScript', name: action + (platform === 'linux' ? 'Linux' : 'Windows'),
    precondition: { StringEquals: ['platformType', platform === 'linux' ? 'Linux' : 'Windows'] },
    inputs: { onFailure: 'exit', timeoutSeconds: '300', runCommand: lines },
  });
  const script = (platform, action) => {
    const p = release.platforms[platform], t = configure[platform];
    const bound = platform === 'linux'
      ? `[[ '{{ ConfigurationVersion }}' == '${p.revision}' && '{{ PresetName }}' == '${p.parameter.name}' && '{{ PresetVersion }}' == '${p.parameter.version}' ]]`
      : `if ('{{ ConfigurationVersion }}' -cne '${p.revision}' -or '{{ PresetName }}' -cne '${p.parameter.name}' -or '{{ PresetVersion }}' -cne '${p.parameter.version}') { throw 'release binding' }`;
    const preamble = [...t.preamble];
    preamble.splice(platform === 'linux' ? preamble.findIndex(line => line.startsWith('[[ $(id -u)')) : preamble.indexOf('try {') + 1, 0, bound);
    const lines = [...preamble, ...(action === 'cleanup' ? cleanup[platform] : t[action]), ...(t.epilogue ?? [])];
    const projection = { cloudWatch: p.cloudWatch, parameter: p.parameter, configuration: { plugins: p.configuration.plugins.map(plugin => ({ plugin: plugin.plugin, resources: plugin.resources, measurements: [{ input: plugin.measurements[0].input }] })) } };
    const encoded = Buffer.from(canonicalJson(projection)).toString('base64');
    return lines.map(line => line.replaceAll('@@ACTION@@', action).replaceAll('@@RELEASE@@', encoded));
  };
  const document = clean => {
    const mainSteps = [];
    for (const platform of ['linux', 'windows']) {
      const p = release.platforms[platform];
      if (!p) {
        mainSteps.push(step(platform, 'unavailable', [platform === 'linux' ? `printf '%s\\n' '{"errorCode":"RELEASE_MISSING","cloudWatchVersion":null,"serviceState":null,"resources":[]}'; exit 1` : `[Console]::WriteLine('{"errorCode":"RELEASE_MISSING","cloudWatchVersion":null,"serviceState":null,"resources":[]}'); exit 1`]));
      } else if (clean) mainSteps.push(step(platform, 'cleanup', script(platform, 'cleanup')));
      else {
        mainSteps.push(step(platform, 'prepare', script(platform, 'prepare')));
        mainSteps.push({ action: 'aws:configurePackage', name: 'install' + (platform === 'linux' ? 'Linux' : 'Windows'), precondition: { StringEquals: ['platformType', platform === 'linux' ? 'Linux' : 'Windows'] }, inputs: { onFailure: 'exit', name: 'AmazonCloudWatchAgent', version: p.cloudWatch.packageVersion, action: 'Install', installationType: 'Uninstall and reinstall' } });
        mainSteps.push(step(platform, 'configure', script(platform, 'configure')));
      }
    }
    const result = { schemaVersion: '2.2', description: clean ? 'InfraPulse owned CloudWatch stop and durable decommission fence; never uninstall SSM' : 'InfraPulse sequential pinned AWS CloudWatch package and configuration', parameters: commandParameters(), mainSteps };
    if (Buffer.byteLength(encodeBundle(result)) > 65536) fail('DOCUMENT_TOO_LARGE');
    return result;
  };
  return { configure: document(false), cleanup: document(true), presets };
}
// Source-only export compatibility. The old deployment executor must switch to
// the decoded release in Task4; an old qualified triplet cannot unlock new docs.
export function compileDocuments({ release } = {}) {
  if (!release) fail('RELEASE_CONFIG_REQUIRED');
  const result = compileAgentDocuments(release);
  return { ...result, decommission: result.cleanup };
}
export function validateBootstrapBundle(bundle, inputs) {
  try { return encodeBundle(bundle) === encodeBundle(compileBootstrap(inputs)); }
  catch { return false; }
}
function strictJson(text) {
  const value = JSON.parse(text); const stack = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') stack.push(new Set());
    else if (text[i] === '[') stack.push(null);
    else if (text[i] === '}' || text[i] === ']') stack.pop();
    else if (text[i] === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
      let next = i + 1; while (next < text.length && /\s/.test(text[next])) next++;
      if (text[next] === ':') { const k = JSON.parse(text.slice(start, i + 1)); if (!stack.at(-1) || stack.at(-1).has(k)) fail('INPUT_INVALID'); stack.at(-1).add(k); }
    }
  }
  return value;
}
async function readFixed(path) {
  if (![...SOURCES, OUTPUT, RELEASE, ...DOCUMENT_OUTPUTS].includes(path)) fail('INPUT_INVALID');
  const parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const stat = await lstat(new URL(parts.slice(0, i).join('/'), ROOT));
    if (stat.isSymbolicLink() || (i < parts.length ? !stat.isDirectory() : !stat.isFile())) fail('INPUT_INVALID');
  }
  let handle;
  try {
    handle = await open(new URL(path, ROOT), 'r');
    const stat = await handle.stat(); if (stat.size < 1 || stat.size > LIMIT) fail('INPUT_INVALID');
    const bytes = Buffer.alloc(LIMIT + 1); let used = 0;
    while (used < bytes.length) { const { bytesRead } = await handle.read(bytes, used, bytes.length - used, null); if (!bytesRead) break; used += bytesRead; }
    if (used > LIMIT) fail('INPUT_INVALID');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, used));
    if (text.includes('\0') || !Buffer.from(text).equals(bytes.subarray(0, used))) fail('INPUT_INVALID');
    return text;
  } finally { if (handle) await handle.close(); }
}
export async function readBootstrapSources() {
  const texts = await Promise.all(SOURCES.map(readFixed));
  return { templates: { linux: texts[0], windows: texts[1] }, bodies: { linux: texts[2], windows: texts[3] } };
}
export async function inspectBootstrapBundle(release, bundle) {
  try { return validateBootstrapBundle(bundle, { release, ...await readBootstrapSources() }); }
  catch { return false; }
}
async function emit(path, text, check) {
  if (![OUTPUT, ...DOCUMENT_OUTPUTS].includes(path)) fail('OUTPUT_UNSAFE');
  if (check) { if (await readFixed(path) !== text) fail('BUNDLE_STALE'); return; }
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const url = new URL(parts.slice(0, i).join('/') + '/', ROOT);
    await mkdir(url, { recursive: true });
    const info = await lstat(url); if (!info.isDirectory() || info.isSymbolicLink()) fail('OUTPUT_UNSAFE');
  }
  const output = new URL(path, ROOT), temporary = new URL(path + `.${process.pid}.tmp`, ROOT);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(text, 'utf8'); await handle.sync(); await handle.close(); handle = undefined;
    await rename(temporary, output);
  } finally { if (handle) await handle.close(); await unlink(temporary).catch(() => {}); }
}
export async function runCli(args) {
  if (!['--documents', '--bootstrap-only'].includes(args[0]) || args.length > 2 || (args.length === 2 && args[1] !== '--check')) return { exit: 2, issues: ['CLI_USAGE'] };
  try {
    let value;
    try { value = strictJson(await readFixed(RELEASE)); } catch (e) { if (e.code !== 'ENOENT') throw e; value = { schemaVersion: 1, platforms: {} }; }
    const release = decodeAgentRelease(value);
    if (args[0] === '--documents') {
      const docs = compileAgentDocuments(release);
      for (const [path, value] of [[DOCUMENT_OUTPUTS[0], docs.configure], [DOCUMENT_OUTPUTS[1], docs.cleanup], [DOCUMENT_OUTPUTS[2], docs.presets]]) await emit(path, encodeBundle(value), args.includes('--check'));
    } else {
      await emit(OUTPUT, encodeBundle(compileBootstrap({ release, ...await readBootstrapSources() })), args.includes('--check'));
    }
    return { exit: 0, issues: [] };
  } catch (error) {
    const known = ['AGENT_RELEASE_INVALID', 'RELEASE_CONFIG_REQUIRED', 'SOURCE_INVALID', 'BUNDLE_TOO_LARGE', 'BUNDLE_STALE', 'OUTPUT_UNSAFE', 'INPUT_INVALID', 'DOCUMENT_TOO_LARGE'];
    return { exit: 1, issues: [error instanceof Error && known.includes(error.message) ? error.message : 'CANONICAL_INPUTS_UNAVAILABLE'] };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runCli(process.argv.slice(2));
  console.log(JSON.stringify({ ok: result.exit === 0, issues: result.issues })); process.exitCode = result.exit;
}
