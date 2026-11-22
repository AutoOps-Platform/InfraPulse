import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadCompiledCloudWatchDashboards } from '../../../deploy/scripts/build-cloudwatch-dashboards.mjs';

const script = new URL('../../../deploy/scripts/publish-grafana-dashboards.mjs', import.meta.url);
const target = {
  version: 1,
  account_id: '123456789012',
  region: 'ap-southeast-1',
  deployment_id: 'lab-123',
  bucket: 'infrapulse-lab-123-dash-123456789012',
  prefix: 'grafana/dashboards/',
};
const linuxName = 'dashboards/linux-host.json';
const windowsName = 'dashboards/windows-host.json';
const linux = JSON.stringify({ uid: 'infrapulse-linux-host', title: 'VM Detail' });
const windows = JSON.stringify({ uid: 'infrapulse-windows-host', title: 'VM Detail (Windows)' });
const fleetName = 'dashboards/fleet.json';
const fleet = JSON.stringify({ uid: 'infrapulse-fleet', title: 'Fleet' });

test('plans all canonical JSON dashboards at owned live keys, not the manifest', async () => {
  const { planDashboardPublish } = await import(script.href);
  const files = await loadCompiledCloudWatchDashboards();
  assert.deepEqual(planDashboardPublish(target, files), [
    [fleetName, 'grafana/dashboards/live/fleet.json', 'infrapulse-fleet'],
    [linuxName, 'grafana/dashboards/live/linux-host.json', 'infrapulse-linux-host'],
    [windowsName, 'grafana/dashboards/live/windows-host.json', 'infrapulse-windows-host'],
  ].map(([name, key, uid]) => ({
    bucket: 'infrapulse-lab-123-dash-123456789012', key, accountId: '123456789012',
    region: 'ap-southeast-1', uid, body: files[name],
  })));
});

test('rejects null, unsupported version, mismatched ownership, region and prefix', async () => {
  const { planDashboardPublish } = await import(script.href);
  for (const invalid of [null, { ...target, version: 2 }, { ...target, account_id: '999999999999' },
    { ...target, region: 'us-east-1' }, { ...target, bucket: 'other-bucket' },
    { ...target, prefix: 'grafana/' }, { ...target, deployment_id: '-bad' }, { ...target, unknown: true }]) {
    assert.throws(() => planDashboardPublish(invalid, { [linuxName]: linux }), /DASHBOARD_TARGET_INVALID/);
  }
});

test('rejects empty, unexpected, oversized, malformed, or conflicting artifacts as a batch', async () => {
  const { planDashboardPublish } = await import(script.href);
  for (const files of [{}, { 'manifest.json': '{}' }, { [linuxName]: linux, 'dashboards/extra.json': linux },
    { [linuxName]: ' '.repeat(2 * 1024 * 1024 + 1) }, { [linuxName]: '{' }, { [linuxName]: '[]' },
    { [linuxName]: JSON.stringify({ uid: 'infrapulse-linux-host', title: '  ' }) },
    { [linuxName]: windows }, { [linuxName]: linux }]) {
    assert.throws(() => planDashboardPublish(target, files), /DASHBOARD_(ARTIFACT_INVALID|ARTIFACTS_EMPTY)/);
  }
});

test('CLI dry run compiles locally and reports only public target metadata', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'infrapulse-target-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'public target.json');
  await writeFile(file, JSON.stringify(target));
  const run = () => spawnSync(process.execPath, [fileURLToPath(script), '--target', file], {
    encoding: 'utf8', env: { ...process.env, PATH: '', AWS_CONFIG_FILE: join(dir, 'absent') },
  });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true, dryRun: true,
    destination: { bucket: target.bucket, prefix: target.prefix, region: target.region, accountId: target.account_id },
    dashboards: [
      { key: 'grafana/dashboards/live/fleet.json', uid: 'infrapulse-fleet' },
      { key: 'grafana/dashboards/live/linux-host.json', uid: 'infrapulse-linux-host' },
      { key: 'grafana/dashboards/live/windows-host.json', uid: 'infrapulse-windows-host' },
    ],
  });
  for (const content of [JSON.stringify({ ...target, token: 'do-not-echo-this' }), ' '.repeat(4097),
    `{"regi\\u006fn":"us-east-1",${JSON.stringify(target).slice(1)}`]) {
    await writeFile(file, content);
    const invalid = run();
    assert.notEqual(invalid.status, 0);
    assert.equal(JSON.parse(invalid.stdout).code, 'DASHBOARD_TARGET_INVALID');
    assert.doesNotMatch(invalid.stdout + invalid.stderr, /do-not-echo-this/);
  }
});

test('publish puts exact bodies with expected owner and stops on the first failure, without deleting', async () => {
  const { publishDashboards } = await import(script.href);
  const calls = [];
  const paths = [];
  const files = await loadCompiledCloudWatchDashboards();
  const failure = await publishDashboards(target, files, async (args) => {
    calls.push(args.slice(0, -1));
    paths.push(args.at(-1));
    assert.equal(await readFile(args.at(-1), 'utf8'), files[calls.length === 1 ? fleetName : linuxName]);
    return calls.length === 1;
  });
  assert.deepEqual(calls, [
    ['s3api', 'put-object', '--bucket', target.bucket, '--key', 'grafana/dashboards/live/fleet.json',
      '--expected-bucket-owner', '123456789012', '--region', 'ap-southeast-1', '--content-type', 'application/json', '--body'],
    ['s3api', 'put-object', '--bucket', target.bucket, '--key', 'grafana/dashboards/live/linux-host.json',
      '--expected-bucket-owner', '123456789012', '--region', 'ap-southeast-1', '--content-type', 'application/json', '--body'],
  ]);
  assert.deepEqual(failure, { ok: false, code: 'DASHBOARD_UPLOAD_UNCONFIRMED', confirmed: 1, total: 3 });
  for (const path of paths) await assert.rejects(stat(path), { code: 'ENOENT' });
});

test('no upload runs when any file or the target fails validation', async () => {
  const { publishDashboards } = await import(script.href);
  let calls = 0;
  const run = async () => { calls++; return true; };
  await assert.rejects(publishDashboards({ ...target, bucket: 'bad-bucket' }, { [linuxName]: linux }, run), /DASHBOARD_TARGET_INVALID/);
  await assert.rejects(publishDashboards(target, { [windowsName]: windows }, run), /DASHBOARD_ARTIFACT_INVALID/);
  await assert.rejects(publishDashboards(target, {}, run), /DASHBOARD_ARTIFACTS_EMPTY/);
  const ambiguous = `{"uid":"wrong",${linux.slice(1)}`;
  await assert.rejects(publishDashboards(target, { [linuxName]: ambiguous }, run), /DASHBOARD_ARTIFACT_INVALID/);
  assert.equal(calls, 0);
});
