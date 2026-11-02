import request from 'supertest';
import { createHash, randomUUID } from 'node:crypto';
import { openSync, closeSync, readFileSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { createManagementApp } from '../../src/bootstrap.js';
import { signedFixture } from '../support/keys.js';
import { admin, identity } from '../support/db.js';
import { readTestUrl } from '../support/pg-harness.js';
import { managementOpenApi } from '../../src/common/openapi.js';

const base = (os = 'linux', interval = 15) => ({
  schema_version: 1,
  os,
  interval_seconds: interval,
  metric_groups: { cpu: true, memory: true, disk: true, network: true },
  options: {},
});
const profiles = '/api/v1/monitoring-profiles';
const versions = '/api/v1/profile-versions';
// Breaks caught: missing signed CRUD, mutable publication, latest-following or
// cross-OS assignment, draft disclosure, lifecycle races, non-atomic audit, seed drift.
describe('Task6 validated published profiles and exact assignment', () => {
  let app: INestApplication;
  let fixture: ReturnType<typeof signedFixture>;
  beforeEach(async () => {
    fixture = signedFixture();
    app = await createManagementApp({
      ...fixture.config,
      databaseUrl: readTestUrl(identity().runtimeFile),
    });
    await app.init();
  });
  afterEach(async () => {
    await app.close();
    fixture.cleanup();
  });
  async function call(
    method: string,
    target: string,
    payload?: unknown,
    role = 'Admin',
    raw?: string,
  ) {
    const body = raw ?? (payload === undefined ? '' : JSON.stringify(payload));
    const token = await fixture.sign({ role, method, target, body });
    const http = request(app.getHttpServer());
    const req =
      method === 'GET'
        ? http.get(target)
        : method === 'POST'
          ? http.post(target)
          : method === 'PUT'
            ? http.put(target)
            : method === 'PATCH'
              ? http.patch(target)
              : http.delete(target);
    req
      .set('Authorization', `Bearer ${token}`)
      .set('X-Request-Id', randomUUID());
    if (body) req.set('Content-Type', 'application/json').send(body);
    return req;
  }
  async function profile(os = 'linux') {
    const response = await call('POST', profiles, {
      slug: `t6-${randomUUID()}`,
      name: 'Profile',
      description: 'Bounded data only',
      os,
    });
    expect(response.status).toBe(201);
    return response.body;
  }
  async function draft(id: string, os = 'linux', interval = 15) {
    const response = await call('POST', `${profiles}/${id}/versions`, {
      config: base(os, interval),
    });
    expect(response.status).toBe(201);
    return response.body;
  }
  async function publish(id: string) {
    const response = await call('POST', `${versions}/${id}/publish`, {});
    expect(response.status).toBe(201);
    return response.body;
  }
  async function server(os = 'linux') {
    const response = await call('POST', '/api/v1/servers', {
      name: 'profile server',
      os,
      environment: 'task6',
    });
    expect(response.status).toBe(201);
    return response.body;
  }
  const pinPath = (id: string) => `/api/v1/servers/${id}/profile`;
  it('existing retired published OS-compatible pins permit enable and replacement registration (T4 regression)', async () => {
    const a = await server();
    const b = await server();
    const agent = await call('POST', `/api/v1/servers/${a.id}/agents`, {});
    expect(agent.status).toBe(201);
    await call('POST', `/api/v1/agents/${agent.body.id}/disable`, {});
    const previous = await call('POST', `/api/v1/servers/${b.id}/agents`, {});
    expect(previous.status).toBe(201);
    expect(
      (await call('POST', `/api/v1/agents/${previous.body.id}/retire`, {}))
        .status,
    ).toBe(201);
    const db = await admin();
    try {
      const pid = randomUUID();
      const vid = randomUUID();
      await db.query(
        "INSERT INTO management.monitoring_profiles(id,slug,name,description,os,retired_at) VALUES($1,$2,'retired','test','linux',clock_timestamp())",
        [pid, `retired-${pid}`],
      );
      const literal =
        '{"interval_seconds":15,"metric_groups":{"cpu":true,"disk":true,"memory":true,"network":true},"options":{},"os":"linux","schema_version":1}';
      await db.query(
        "INSERT INTO management.profile_versions(id,profile_id,version,config,checksum,status,created_by,published_at) VALUES($1,$2,1,$3,$4,'published','{}',clock_timestamp())",
        [vid, pid, literal, createHash('sha256').update(literal).digest('hex')],
      );
      for (const id of [a.id, b.id])
        await db.query(
          "INSERT INTO management.server_profiles(server_id,profile_version_id,assigned_by) VALUES($1,$2,'{}')",
          [id, vid],
        );
      const enabled = await call(
        'POST',
        `/api/v1/agents/${agent.body.id}/enable`,
        {},
      );
      const replacement = await call(
        'POST',
        `/api/v1/servers/${b.id}/agents`,
        {},
      );
      expect([enabled.status, replacement.status]).toEqual([201, 201]);
    } finally {
      await db.end();
    }
  });
  it('edits only drafts, publishes immutable RFC8785 config, pins and rolls back exact versions with history intact', async () => {
    const p = await profile();
    const v1 = await draft(p.id);
    const edited = await call('PATCH', `${versions}/${v1.id}`, {
      config: base('linux', 20),
    });
    expect(edited.status).toBe(200);
    const published = await publish(v1.id);
    const literal =
      '{"interval_seconds":20,"metric_groups":{"cpu":true,"disk":true,"memory":true,"network":true},"options":{},"os":"linux","schema_version":1}';
    expect(published.checksum).toBe(
      createHash('sha256').update(literal).digest('hex'),
    );
    expect(published.published_at).toMatch(/Z$/);
    expect(
      (await call('PATCH', `${versions}/${v1.id}`, { config: base() })).status,
    ).toBe(409);
    const s = await server();
    expect(
      (await call('PUT', pinPath(s.id), { profile_version_id: v1.id })).status,
    ).toBe(200);
    const v2 = await draft(p.id, 'linux', 30);
    await publish(v2.id);
    expect((await call('GET', pinPath(s.id))).body.profile_version_id).toBe(
      v1.id,
    );
    await call('PUT', pinPath(s.id), { profile_version_id: v2.id });
    expect(
      (await call('PUT', pinPath(s.id), { profile_version_id: v1.id })).body
        .profile_version_id,
    ).toBe(v1.id);
    const db = await admin();
    try {
      await expect(
        db.query(
          "UPDATE management.profile_versions SET config='{}' WHERE id=$1",
          [v1.id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        db.query('DELETE FROM management.profile_versions WHERE id=$1', [
          v1.id,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM management.audit_logs WHERE operation='assignment' AND resource_id=$1",
            [s.id],
          )
        ).rows[0].n,
      ).toBe(3);
      expect(
        (
          await db.query(
            'SELECT count(*)::int AS n FROM management.profile_versions WHERE profile_id=$1',
            [p.id],
          )
        ).rows[0].n,
      ).toBe(2);
    } finally {
      await db.end();
    }
  });
  it('denies cross-OS, draft, retired, archived and latest-like assignments, but keeps an existing retired pin usable', async () => {
    const p = await profile();
    const v = await draft(p.id);
    const s = await server();
    expect(
      (await call('PUT', pinPath(s.id), { profile_version_id: v.id })).status,
    ).toBe(409);
    await publish(v.id);
    const win = await profile('windows');
    const wv = await draft(win.id, 'windows');
    await publish(wv.id);
    expect(
      (await call('PUT', pinPath(s.id), { profile_version_id: wv.id })).status,
    ).toBe(409);
    expect(
      (await call('PUT', pinPath(s.id), { profile_version_id: 'latest' }))
        .status,
    ).toBe(400);
    expect(
      (await call('PUT', pinPath(s.id), { profile_version_id: v.id })).status,
    ).toBe(200);
    expect(
      (await call('PATCH', `/api/v1/servers/${s.id}`, { os: 'windows' }))
        .status,
    ).toBe(409);
    expect((await call('POST', `${profiles}/${p.id}/retire`, {})).status).toBe(
      201,
    );
    expect(
      (await call('GET', pinPath(s.id), undefined, 'Viewer')).body
        .profile_version_id,
    ).toBe(v.id);
    expect(
      (await call('GET', `${versions}/${v.id}`, undefined, 'Viewer')).body
        .config,
    ).toEqual(base());
    const a = await call('POST', `/api/v1/servers/${s.id}/agents`, {});
    expect(a.status).toBe(201);
    await call('POST', `/api/v1/agents/${a.body.id}/disable`, {});
    expect(
      (await call('POST', `/api/v1/agents/${a.body.id}/enable`, {})).status,
    ).toBe(201);
    const other = await server();
    expect(
      (await call('PUT', pinPath(other.id), { profile_version_id: v.id }))
        .status,
    ).toBe(409);
    expect(
      (await call('PUT', pinPath(s.id), { profile_version_id: v.id })).status,
    ).toBe(409);
    await call('DELETE', `/api/v1/servers/${other.id}`);
    expect(
      (await call('PUT', pinPath(other.id), { profile_version_id: wv.id }))
        .status,
    ).toBe(409);
  });
  it.each(['Viewer', 'Editor'])(
    'keeps %s published-only across lists, guessed IDs and query filters; denies every mutation',
    async (role) => {
      const p = await profile();
      const draftOnly = await draft(p.id);
      const hiddenList = await call(
        'GET',
        `${profiles}?limit=100`,
        undefined,
        role,
      );
      expect(
        hiddenList.body.items.some((x: { id: string }) => x.id === p.id),
      ).toBe(false);
      expect(
        (await call('GET', `${profiles}/${p.id}`, undefined, role)).status,
      ).toBe(404);
      expect(
        (await call('GET', `${versions}/${draftOnly.id}`, undefined, role))
          .status,
      ).toBe(404);
      const published = await draft(p.id);
      await publish(published.id);
      const detail = await call('GET', `${profiles}/${p.id}`, undefined, role);
      expect(detail.body.versions.map((x: { id: string }) => x.id)).toEqual([
        published.id,
      ]);
      const visibleList = await call(
        'GET',
        `${profiles}?status=published&limit=100`,
        undefined,
        role,
      );
      expect(
        visibleList.body.items.some((x: { id: string }) => x.id === p.id),
      ).toBe(true);
      const draftCursor = Buffer.from(
        JSON.stringify({ id: draftOnly.id, created_at: draftOnly.created_at }),
      ).toString('base64url');
      expect(
        (
          await call(
            'GET',
            `${profiles}/${p.id}/versions?cursor=${draftCursor}`,
            undefined,
            role,
          )
        ).status,
      ).toBe(400);
      const listed = await call(
        'GET',
        `${profiles}/${p.id}/versions`,
        undefined,
        role,
      );
      expect(listed.body.items.map((x: { id: string }) => x.id)).toEqual([
        published.id,
      ]);
      expect(
        (
          await call(
            'GET',
            `${profiles}/${p.id}/versions?status=draft`,
            undefined,
            role,
          )
        ).status,
      ).toBe(403);
      expect(
        (await call('GET', `${profiles}?status=draft`, undefined, role)).status,
      ).toBe(403);
      expect(
        (
          await call(
            'GET',
            `${versions}/${draftOnly.id}?status=published`,
            undefined,
            role,
          )
        ).status,
      ).toBe(400);
      for (const [method, target, body] of [
        [
          'POST',
          profiles,
          { slug: 'forbidden', name: 'x', description: '', os: 'linux' },
        ],
        ['PATCH', `${profiles}/${p.id}`, { name: 'x' }],
        ['POST', `${profiles}/${p.id}/versions`, { config: base() }],
        ['PATCH', `${versions}/${draftOnly.id}`, { config: base() }],
        ['POST', `${versions}/${draftOnly.id}/publish`, {}],
        ['POST', `${profiles}/${p.id}/retire`, {}],
        ['PUT', pinPath(randomUUID()), { profile_version_id: published.id }],
      ] as const)
        expect((await call(method, target, body, role)).status).toBe(403);
    },
  );
  it('rejects malformed/duplicate/unsafe/other-OS/oversize configuration and unknown mutation fields', async () => {
    const p = await profile();
    for (const config of [
      { ...base(), options: { shell: 'sh' } },
      { ...base(), options: { disk: { include_volumes: ['C:'] } } },
      { ...base(), options: { network: { interfaces: ['${secret}'] } } },
      { ...base(), options: { network: { interfaces: ['https://host'] } } },
      { ...base(), metric_groups: { ...base().metric_groups, system: true } },
      { ...base(), os: 'windows' },
    ])
      expect(
        (await call('POST', `${profiles}/${p.id}/versions`, { config })).status,
      ).toBe(400);
    for (const raw of [
      '{"config":{"schema_version":1,"schema_version":1}}',
      '{"config":{"interval_seconds":1e400}}',
      '{"config":{"interval_seconds":9007199254740993}}',
    ])
      expect(
        (
          await call(
            'POST',
            `${profiles}/${p.id}/versions`,
            undefined,
            'Admin',
            raw,
          )
        ).status,
      ).toBe(400);
    const huge = {
      ...base(),
      options: {
        disk: {
          exclude_filesystems: Array(64).fill('漢'.repeat(128)),
          mount_points: Array(64).fill('/' + '漢'.repeat(127)),
        },
        network: { interfaces: Array(64).fill('漢'.repeat(128)) },
      },
    };
    expect(
      (await call('POST', `${profiles}/${p.id}/versions`, { config: huge }))
        .status,
    ).toBe(413);
    expect(
      (await call('PATCH', `${profiles}/${p.id}`, { os: 'windows' })).status,
    ).toBe(400);
    expect((await call('GET', `${profiles}?unknown=1`)).status).toBe(400);
  });
  it('allocates unique sequential versions under concurrency and never lets publication change an existing pin', async () => {
    const p = await profile();
    const created = await Promise.all(
      Array.from({ length: 6 }, () => draft(p.id)),
    );
    expect(created.map((x) => x.version).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    await publish(created[0].id);
    const s = await server();
    const results = await Promise.all([
      call('PUT', pinPath(s.id), { profile_version_id: created[0].id }),
      call('POST', `${versions}/${created[1].id}/publish`, {}),
      call('POST', `${profiles}/${p.id}/versions`, {
        config: base('linux', 25),
      }),
    ]);
    expect(results.map((x) => x.status)).toEqual([200, 201, 201]);
    expect((await call('GET', pinPath(s.id))).body.profile_version_id).toBe(
      created[0].id,
    );
  });
  it('serializes real retirement/assignment/publication race and preserves all committed pins', async () => {
    const p = await profile();
    const v = await draft(p.id);
    await publish(v.id);
    const d = await draft(p.id);
    const s = await server();
    const blocker = await admin();
    await blocker.query('SELECT pg_advisory_lock(913748,6)');
    let waiting = 0;
    const pending = Promise.all([
      call('PUT', pinPath(s.id), { profile_version_id: v.id }),
      call('POST', `${profiles}/${p.id}/retire`, {}),
      call('POST', `${versions}/${d.id}/publish`, {}),
    ]);
    try {
      const deadline = performance.now() + 700;
      do {
        waiting = (
          await blocker.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock(913748,6)%'",
          )
        ).rows[0].n;
        if (waiting === 3) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      } while (performance.now() < deadline);
    } finally {
      await blocker.query('SELECT pg_advisory_unlock(913748,6)');
      await blocker.end();
    }
    const results = await pending;
    expect(waiting).toBe(3); // All three real transactions waited simultaneously before release.
    expect([200, 409]).toContain(results[0].status);
    expect(results[1].status).toBe(201);
    expect([201, 409]).toContain(results[2].status);
    expect(
      (await call('PUT', pinPath(s.id), { profile_version_id: v.id })).status,
    ).toBe(409);
    const pin = await call('GET', pinPath(s.id));
    expect(pin.status).toBe(results[0].status === 200 ? 200 : 404);
    if (pin.status === 200) expect(pin.body.profile_version_id).toBe(v.id);
  });
  it('serializes assignment against OS change and archival through the existing Server lock', async () => {
    const p = await profile();
    const v = await draft(p.id);
    await publish(v.id);
    const s = await server();
    const raced = await Promise.all([
      call('PUT', pinPath(s.id), { profile_version_id: v.id }),
      call('PATCH', `/api/v1/servers/${s.id}`, { os: 'windows' }),
    ]);
    expect(raced.filter((x) => x.status === 409)).toHaveLength(1);
    const now = await call('GET', `/api/v1/servers/${s.id}`);
    const pin = await call('GET', pinPath(s.id));
    expect(
      (now.body.os === 'linux' && pin.body.profile_version_id === v.id) ||
        (now.body.os === 'windows' && pin.status === 404),
    ).toBe(true);
    const s2 = await server();
    const archive = await Promise.all([
      call('PUT', pinPath(s2.id), { profile_version_id: v.id }),
      call('DELETE', `/api/v1/servers/${s2.id}`),
    ]);
    expect([200, 409]).toContain(archive[0].status);
    expect(archive[1].status).toBe(204);
    expect(
      (await call('PUT', pinPath(s2.id), { profile_version_id: v.id })).status,
    ).toBe(409);
  });
  it('rolls back create/edit/version/publish/retire/assignment when actual audit INSERT fails', async () => {
    const p = await profile();
    const v = await draft(p.id);
    const old = await draft(p.id);
    await publish(old.id);
    const s = await server();
    const db = await admin();
    try {
      const before = (
        await db.query(
          'SELECT config,checksum,status FROM management.profile_versions WHERE id=$1',
          [v.id],
        )
      ).rows;
      await db.query(
        'REVOKE INSERT ON management.audit_logs FROM management_runtime',
      );
      for (const [method, target, body] of [
        [
          'POST',
          profiles,
          {
            slug: `fail-${randomUUID()}`,
            name: 'fail',
            description: '',
            os: 'linux',
          },
        ],
        ['PATCH', `${profiles}/${p.id}`, { name: 'fail' }],
        ['POST', `${profiles}/${p.id}/versions`, { config: base() }],
        ['PATCH', `${versions}/${v.id}`, { config: base('linux', 40) }],
        ['POST', `${versions}/${v.id}/publish`, {}],
        ['POST', `${profiles}/${p.id}/retire`, {}],
        ['PUT', pinPath(s.id), { profile_version_id: old.id }],
      ] as const)
        expect((await call(method, target, body)).status).toBe(503);
      expect(
        (
          await db.query(
            'SELECT config,checksum,status FROM management.profile_versions WHERE id=$1',
            [v.id],
          )
        ).rows,
      ).toEqual(before);
      expect(
        (
          await db.query(
            'SELECT name,retired_at FROM management.monitoring_profiles WHERE id=$1',
            [p.id],
          )
        ).rows,
      ).toEqual([{ name: 'Profile', retired_at: null }]);
      expect(
        (
          await db.query(
            'SELECT count(*)::int AS n FROM management.profile_versions WHERE profile_id=$1',
            [p.id],
          )
        ).rows[0].n,
      ).toBe(2);
      expect(
        (
          await db.query(
            'SELECT count(*)::int AS n FROM management.server_profiles WHERE server_id=$1',
            [s.id],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM management.monitoring_profiles WHERE name='fail'",
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await db.query(
        'GRANT INSERT ON management.audit_logs TO management_runtime',
      );
      await db.end();
    }
  });
  it('documents published-only reads, Admin mutation, exact assignment, bounded OS options and separate own-Agent provisioning policies', () => {
    const doc = managementOpenApi(app);
    expect(doc.paths[profiles]?.get?.description).toMatch(/published/);
    expect(doc.paths[`${versions}/{id}/publish`]?.post?.security).toEqual([
      { AdminAssertion: [] },
    ]);
    expect(
      doc.paths['/api/v1/servers/{serverId}/profile']?.put?.description,
    ).toMatch(/exact/);
    expect(doc.components?.schemas?.ProfileConfigV1).toMatchObject({
      additionalProperties: false,
    });
    expect(doc.paths['/api/v1/agent/provisioning']?.get?.security).toEqual([
      { AgentApiKey: [] },
    ]);
    expect(doc.paths['/api/v1/agent/config-reports']?.post?.security).toEqual([
      { AgentApiKey: [] },
    ]);
  });
});

describe('Task6 actual native explicit seed operation', () => {
  it('runs CLI twice preserving checksum/history, uses shared validation and fails fixed on seed drift', async () => {
    const db = identity();
    const env = {
      ...process.env,
      MANAGEMENT_MIGRATION_DATABASE_URL_FILE: db.ownerFile,
      INGEST_GATEWAY_ID: '00000000-0000-4000-8000-000000000006',
    };
    const output = resolve(db.privateDir, 'task6-native-seed.log');
    function seed() {
      const fd = openSync(output, 'w');
      try {
        return spawnSync(process.execPath, ['scripts/seed-db.ts'], {
          cwd: resolve(import.meta.dirname, '../..'),
          env,
          stdio: ['ignore', fd, fd],
          timeout: 10000,
        }).status;
      } finally {
        closeSync(fd);
      }
    }
    const client = await admin();
    try {
      expect(seed()).toBe(0);
      const sql =
        "SELECT p.slug,v.id,v.config,v.checksum,v.published_at FROM management.monitoring_profiles p JOIN management.profile_versions v ON v.profile_id=p.id WHERE p.slug IN ('linux-base','windows-base') ORDER BY p.slug,v.version";
      const before = (await client.query(sql)).rows;
      expect(seed()).toBe(0);
      expect((await client.query(sql)).rows).toEqual(before);
      expect(before).toHaveLength(2);
      expect(readFileSync(output, 'utf8').trim()).toBe('management_db_seed_ok');
      const compiled = resolve(
        import.meta.dirname,
        '../../dist/profiles/profile-config.js',
      );
      if (
        compiled !== resolve(process.cwd(), 'dist/profiles/profile-config.js')
      )
        throw new Error('Unexpected compiled prerequisite path.');
      const original = readFileSync(compiled);
      const compiledBackup = `${compiled}.${randomUUID()}.missing-test`;
      renameSync(compiled, compiledBackup); // Only this verified, ignored build artifact; restored even on failed assertion.
      try {
        expect(seed()).toBe(1);
        expect(readFileSync(output, 'utf8').trim()).toBe(
          'management_db_seed_failed',
        );
      } finally {
        renameSync(compiledBackup, compiled);
      }
      expect(readFileSync(compiled).equals(original)).toBe(true);
      // Model an incompatible pre-existing slug without weakening either DB history trigger.
      const backup = `seed-backup-${randomUUID()}`;
      const conflict = randomUUID();
      await client.query(
        "UPDATE management.monitoring_profiles SET slug=$1 WHERE slug='linux-base'",
        [backup],
      );
      await client.query(
        "INSERT INTO management.monitoring_profiles(id,slug,name,description,os) VALUES($1,'linux-base','conflict','','windows')",
        [conflict],
      );
      try {
        expect(seed()).toBe(1);
        expect(readFileSync(output, 'utf8').trim()).toBe(
          'management_db_seed_failed',
        );
      } finally {
        await client.query(
          'DELETE FROM management.monitoring_profiles WHERE id=$1',
          [conflict],
        );
        await client.query(
          "UPDATE management.monitoring_profiles SET slug='linux-base' WHERE slug=$1",
          [backup],
        );
      }
      expect((await client.query(sql)).rows).toEqual(before);
      // A published v1 with a wrong checksum is not repaired/overwritten either.
      const driftProfile = randomUUID(),
        driftVersion = randomUUID(),
        retainedSlug = `t6-drift-${randomUUID()}`;
      await client.query(
        "UPDATE management.monitoring_profiles SET slug=$1 WHERE slug='linux-base'",
        [backup],
      );
      await client.query(
        "INSERT INTO management.monitoring_profiles(id,slug,name,description,os) VALUES($1,'linux-base','drift','','linux')",
        [driftProfile],
      );
      await client.query(
        "INSERT INTO management.profile_versions(id,profile_id,version,config,checksum,status,created_by,published_at) VALUES($1,$2,1,$3,$4,'published','{}',clock_timestamp())",
        [driftVersion, driftProfile, JSON.stringify(base()), '0'.repeat(64)],
      );
      try {
        expect(seed()).toBe(1);
        expect(readFileSync(output, 'utf8').trim()).toBe(
          'management_db_seed_failed',
        );
        expect(
          (
            await client.query(
              'SELECT checksum FROM management.profile_versions WHERE id=$1',
              [driftVersion],
            )
          ).rows[0].checksum,
        ).toBe('0'.repeat(64));
      } finally {
        await client.query(
          'UPDATE management.monitoring_profiles SET slug=$1 WHERE id=$2',
          [retainedSlug, driftProfile],
        );
        await client.query(
          "UPDATE management.monitoring_profiles SET slug='linux-base' WHERE slug=$1",
          [backup],
        );
      }
      expect((await client.query(sql)).rows).toEqual(before);
    } finally {
      await client.end();
    }
  });
});
