import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadCompiledCloudWatchDashboards } from './build-cloudwatch-dashboards.mjs';
import { parseUniqueJson } from './build-inputs.mjs';

const PREFIX = 'grafana/dashboards/';
const REGION = 'ap-southeast-1';
const TARGET_KEYS = 'account_id,bucket,deployment_id,prefix,region,version';
const MAX_TARGET_BYTES = 4096;
const MAX_DASHBOARD_BYTES = 2 * 1024 * 1024;
const ARTIFACTS = new Map([
  ['dashboards/container-detail.json', 'infrapulse-container-detail'],
  ['dashboards/containers.json', 'infrapulse-containers'],
  ['dashboards/fleet.json', 'infrapulse-fleet'],
  ['dashboards/linux-host.json', 'infrapulse-linux-host'],
  ['dashboards/windows-host.json', 'infrapulse-windows-host'],
]);
const fail = (code) => { throw new Error(code); };
const object = (value) => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;

function validateTarget(target) {
  if (!object(target) || Object.keys(target).sort().join(',') !== TARGET_KEYS || target.version !== 1
    || target.region !== REGION || target.prefix !== PREFIX
    || typeof target.account_id !== 'string' || !/^[0-9]{12}(?![\s\S])/.test(target.account_id)
    || typeof target.deployment_id !== 'string' || !/^[a-z][a-z0-9-]{1,30}[a-z0-9](?![\s\S])/.test(target.deployment_id)
    || target.bucket !== `infrapulse-${target.deployment_id}-dash-${target.account_id}`) fail('DASHBOARD_TARGET_INVALID');
}

async function readTarget(path) {
  let handle;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size < 2 || info.size > MAX_TARGET_BYTES) fail('DASHBOARD_TARGET_INVALID');
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) fail('DASHBOARD_TARGET_INVALID');
    const bytes = Buffer.alloc(MAX_TARGET_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_TARGET_BYTES) fail('DASHBOARD_TARGET_INVALID');
    const target = parseUniqueJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
    validateTarget(target);
    return target;
  } catch {
    fail('DASHBOARD_TARGET_INVALID');
  } finally {
    if (handle) await handle.close();
  }
}

/** Validate the complete batch before any cloud operation. */
export function planDashboardPublish(target, files) {
  validateTarget(target);
  if (!object(files)) fail('DASHBOARD_ARTIFACT_INVALID');
  const seen = new Set();
  const plan = [];
  for (const [name, body] of Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (name === 'manifest.json') continue;
    const uid = ARTIFACTS.get(name);
    if (!uid || typeof body !== 'string' || Buffer.byteLength(body) > MAX_DASHBOARD_BYTES || seen.has(uid)) fail('DASHBOARD_ARTIFACT_INVALID');
    let dashboard;
    try { dashboard = parseUniqueJson(body); } catch { fail('DASHBOARD_ARTIFACT_INVALID'); }
    if (!object(dashboard) || dashboard.uid !== uid || typeof dashboard.title !== 'string' || !dashboard.title.trim()) fail('DASHBOARD_ARTIFACT_INVALID');
    seen.add(uid);
    plan.push({ bucket: target.bucket, key: `${PREFIX}live/${basename(name)}`, accountId: target.account_id, region: REGION, uid, body });
  }
  if (plan.length === 0) fail('DASHBOARD_ARTIFACTS_EMPTY');
  if (!seen.has('infrapulse-fleet')) fail('DASHBOARD_ARTIFACT_INVALID');
  return plan;
}

function runAws(args) {
  const result = spawnSync('aws', args, {
    shell: false, stdio: 'ignore', windowsHide: true, timeout: 120_000,
    env: { ...process.env, AWS_PAGER: '', AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true', AWS_MAX_ATTEMPTS: '1' },
  });
  return result.status === 0 && !result.error;
}

/** Only the explicit publish path creates local bodies or calls the AWS CLI. */
export async function publishDashboards(target, files, run = runAws) {
  const plan = planDashboardPublish(target, files);
  const total = plan.length;
  let confirmed = 0;
  let dir;
  let code;
  try {
    dir = await mkdtemp(join(tmpdir(), 'infrapulse-dashboard-'));
    for (const item of plan) {
      const bodyPath = join(dir, basename(item.key));
      await writeFile(bodyPath, item.body, { flag: 'wx', mode: 0o600, encoding: 'utf8' });
    }
    for (const item of plan) {
      const args = ['s3api', 'put-object', '--bucket', item.bucket, '--key', item.key,
        '--expected-bucket-owner', item.accountId, '--region', item.region, '--content-type', 'application/json',
        '--body', join(dir, basename(item.key))];
      if (await run(args) !== true) { code = 'DASHBOARD_UPLOAD_UNCONFIRMED'; break; }
      confirmed++;
    }
  } catch {
    code = dir && confirmed < total ? 'DASHBOARD_PUBLISH_FAILED' : 'DASHBOARD_LOCAL_PREPARATION_FAILED';
  } finally {
    if (dir) {
      try { await rm(dir, { recursive: true, force: true }); }
      catch { code ??= 'DASHBOARD_TEMP_CLEANUP_FAILED'; }
    }
  }
  return code ? { ok: false, code, confirmed, total } : { ok: true, dryRun: false, confirmed, total };
}

async function runCli(args) {
  if ((args.length !== 2 && args.length !== 3) || args[0] !== '--target' || !args[1] || args[1].startsWith('-')
    || (args.length === 3 && args[2] !== '--publish')) return { exit: 2, value: { ok: false, code: 'CLI_USAGE' } };
  try {
    const target = await readTarget(args[1]);
    let files;
    try { files = await loadCompiledCloudWatchDashboards(); } catch { fail('DASHBOARD_INPUT_UNAVAILABLE'); }
    if (args[2] === '--publish') {
      const value = await publishDashboards(target, files);
      return { exit: value.ok ? 0 : 1, value };
    }
    const dashboards = planDashboardPublish(target, files).map(({ key, uid }) => ({ key, uid }));
    const destination = { bucket: target.bucket, prefix: PREFIX, region: REGION, accountId: target.account_id };
    return { exit: 0, value: { ok: true, dryRun: true, destination, dashboards } };
  } catch (error) {
    const known = ['DASHBOARD_TARGET_INVALID', 'DASHBOARD_ARTIFACT_INVALID', 'DASHBOARD_ARTIFACTS_EMPTY', 'DASHBOARD_INPUT_UNAVAILABLE'];
    return { exit: 1, value: { ok: false, code: known.includes(error?.message) ? error.message : 'DASHBOARD_PUBLISH_FAILED' } };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { exit, value } = await runCli(process.argv.slice(2));
  console.log(JSON.stringify(value));
  process.exitCode = exit;
}
