import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// Match webpack's local extensionless TypeScript import only for this module.
const inventoryUrl = new URL('../src/api/inventory.ts', import.meta.url).href;
const hook = registerHooks({
  resolve(specifier, context, next) {
    return next(context.parentURL === inventoryUrl && specifier === './types' ? './types.ts' : specifier, context);
  },
});
const { listFleet, readBinding } = await import(inventoryUrl).finally(() => hook.deregister());
const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const enrollmentId = '42424242-4242-4242-8242-424242424242';
const nodeId = 'mi-0123456789abcdef0';
const sample = '2026-11-21T01:00:00.000Z';
function vm(id = a) {
  return {
    id, name: 'same name', os: 'linux', environment: 'lab', metadata: { ignored: 'never expose' },
    created_at: sample, updated_at: sample, archived_at: null,
    configuration: { version: null, status: null, requestedAt: null, startedAt: null, finishedAt: null }, alertRuleUids: [],
    onboarding: {
      serverId: id, attemptId: a, enrollmentId, generation: 2, state: 'Success', stage: 'Complete', bindingState: 'Active',
      expiresAt: null, nextRunAt: null, errorCode: null,
      monitoring: { health: 'Fresh', lastObservedSampleAt: sample, lastSuccessfulQueryAt: sample },
      alertSync: { state: 'Pending', generation: 2, desiredHash: null, syncedAt: null },
      availability: { available: true, configurationVersion: 'a'.repeat(64), reason: 'ready' },
      agent: { nodeId, hostname: null, ipAddress: null, osVersion: null, ssmStatus: null, ssmAgentVersion: null, ssmLastPingAt: null, cloudWatchVersion: null, cloudWatchServiceState: null, observedAt: null },
    },
    dashboardContext: { serverId: id, nodeId, enrollmentId, generation: 2, platform: 'linux', presetHash: 'b'.repeat(64), state: 'Active', resources: [
      { id: 'cpu_total', dimensions: [{ name: 'cpu', value: 'cpu-total' }] },
      { id: 'root_disk', dimensions: [{ name: 'device', value: 'sda1' }, { name: 'fstype', value: 'ext4' }, { name: 'path', value: '/' }] },
      { id: 'eth0', dimensions: [{ name: 'interface', value: 'eth0' }] },
    ] },
  };
}

test('fleet keeps identical names as separate VM ids and includes a VM without metrics', async () => {
  const unbound = vm(b);
  unbound.dashboardContext = null;
  unbound.onboarding.monitoring = { health: 'Unknown', lastObservedSampleAt: null, lastSuccessfulQueryAt: null };
  const request = [];
  const result = await listFleet(async (filters) => {
    request.push(filters);
    return filters.cursor ? { items: [unbound], next_cursor: null } : { items: [vm()], next_cursor: 'next' };
  });
  assert.deepEqual(request, [{ archive: 'false', limit: 100, cursor: undefined }, { archive: 'false', limit: 100, cursor: 'next' }]);
  assert.deepEqual(result, { partial: false, rows: [
    { serverId: a, name: 'same name', environment: 'lab', health: 'Fresh', lastSampleAt: sample, canOpenMetrics: true },
    { serverId: b, name: 'same name', environment: 'lab', health: 'Unknown', lastSampleAt: null, canOpenMetrics: false },
  ] });
});

test('fleet marks duplicate records, repeated cursors and the page cap as partial', async () => {
  let calls = 0;
  const result = await listFleet(async () => { calls++; return { items: [vm()], next_cursor: 'repeat' }; });
  assert.equal(calls, 2);
  assert.equal(result.partial, true);
  assert.equal(result.rows.length, 1);
  calls = 0;
  assert.deepEqual(await listFleet(async () => ({ items: [], next_cursor: String(++calls) })), { partial: true, rows: [] });
  assert.equal(calls, 100);
});

test('fleet rejects failed pages rather than returning the previous snapshot as complete', async () => {
  const failure = new Error('upstream denied');
  await assert.rejects(listFleet(async ({ cursor }) => {
    if (cursor) throw failure;
    return { items: [vm()], next_cursor: 'next' };
  }), (error) => error === failure);
});

test('binding projects an exact tuple from a fresh GET on every read', async () => {
  let calls = 0;
  const read = async (selected) => {
    assert.equal(selected, a);
    const current = vm();
    if (++calls === 2) {
      current.dashboardContext.generation = current.onboarding.generation = 3;
      current.dashboardContext.enrollmentId = current.onboarding.enrollmentId = b;
    }
    return current;
  };
  const exact = {
    server_id: a, managed_node_id: nodeId, enrollment_id: enrollmentId,
    native_6370755f746f74616c_637075: 'cpu-total',
    native_726f6f745f6469736b_646576696365: 'sda1',
    native_726f6f745f6469736b_667374797065: 'ext4',
    native_726f6f745f6469736b_70617468: '/',
    native_65746830_696e74657266616365: 'eth0',
  };
  assert.deepEqual(await readBinding(read, a), exact);
  assert.deepEqual(await readBinding(read, a), { ...exact, enrollment_id: b });
  assert.equal(calls, 2);
});

test('binding rejects unexpected server, expired generation, unbound, retired, archived and unavailable Windows', async () => {
  for (const mutate of [
    (v) => { v.id = b; },
    (v) => { v.onboarding.generation++; },
    (v) => { v.dashboardContext = null; },
    (v) => { v.onboarding.bindingState = 'Retired'; },
    (v) => { v.archived_at = sample; },
    (v) => { v.onboarding.availability = { available: false, reason: 'release_missing', configurationVersion: null }; },
    (v) => { v.os = v.dashboardContext.platform = 'windows'; },
  ]) {
    const current = vm(); mutate(current);
    assert.equal(await readBinding(async () => current, a), null, String(mutate));
  }
  assert.equal(await readBinding(async () => assert.fail('invalid selection must not perform I/O'), '*'), null);
});

test('binding fails closed for wildcards, multivalues and unresolved dimensions', async () => {
  for (const value of ['*', 'nic?', 'eth0,eth1', '$other', '${input}', '{eth0,eth1}', 'eth0\n', ' ']) {
    const current = vm(); current.dashboardContext.resources[2].dimensions[0].value = value;
    assert.equal(await readBinding(async () => current, a), null, JSON.stringify(value));
  }
});

test('lookup failure never reuses a successful tuple, and a cancelled response cannot return dimensions', async () => {
  assert.ok(await readBinding(async () => vm(), a));
  for (const status of [403, 500]) {
    assert.equal(await readBinding(async () => { throw Object.assign(new Error('upstream'), { status }); }, a), null);
  }
  const controller = new AbortController();
  await assert.rejects(readBinding(async (_, signal) => {
    assert.equal(signal, controller.signal);
    controller.abort();
    return vm();
  }, a, controller.signal), { name: 'AbortError' });
  await assert.rejects(listFleet(async () => assert.fail('cancelled scan must not perform I/O'), controller.signal), { name: 'AbortError' });
});
