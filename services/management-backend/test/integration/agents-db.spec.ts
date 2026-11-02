import request from 'supertest';
import { randomUUID, randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createManagementApp } from '../../src/bootstrap.js';
import { signedFixture } from '../support/keys.js';
import { admin, identity } from '../support/db.js';
import { readTestUrl } from '../support/pg-harness.js';
import { seedDatabase } from '../../scripts/seed-db.js';

// Breaks caught: absent Server→Agent serialization, omitted key revocation,
// audit failure committed state, revived keys, moved Agent, incompatible OS.
describe('Task4 lifecycle on real isolated PostgreSQL', () => {
  let app: INestApplication;
  let fixture: ReturnType<typeof signedFixture>;
  beforeAll(async () => {
    await seedDatabase({
      MANAGEMENT_MIGRATION_DATABASE_URL_FILE: identity().ownerFile,
      INGEST_GATEWAY_ID: randomUUID(),
    });
  });
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
  async function call(method: string, target: string, payload?: unknown) {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const token = await fixture.sign({ role: 'Admin', method, target, body });
    const req = request(app.getHttpServer());
    const operation =
      method === 'GET'
        ? req.get(target)
        : method === 'PATCH'
          ? req.patch(target)
          : method === 'DELETE'
            ? req.delete(target)
            : req.post(target);
    operation.set('Authorization', `Bearer ${token}`);
    if (body) operation.set('Content-Type', 'application/json').send(body);
    return operation;
  }
  async function server() {
    const result = await call('POST', '/api/v1/servers', {
      name: 'lifecycle',
      os: 'linux',
      environment: 'test',
    });
    expect(result.status).toBe(201);
    return result.body.id as string;
  }
  async function register(id: string) {
    return call('POST', `/api/v1/servers/${id}/agents`, {});
  }
  async function key(agentId: string) {
    const db = await admin();
    const id = randomUUID();
    try {
      await db.query(
        "INSERT INTO management.api_credentials(id,agent_id,public_prefix,secret_hash,scopes,expires_at,issuance_request_id,created_by) VALUES($1,$2,'fixture',$3,ARRAY['metrics:write'],clock_timestamp()+interval '1 day',$4,'{}')",
        [id, agentId, randomBytes(32), randomUUID()],
      );
      return id;
    } finally {
      await db.end();
    }
  }
  it('serializes concurrent real HTTP registration with one 201 and one 409, retaining history', async () => {
    const id = await server();
    const results = await Promise.all([register(id), register(id)]);
    expect(results.map((x) => x.status).sort()).toEqual([201, 409]);
    const agent = results.find((x) => x.status === 201)!.body;
    const keyId = await key(agent.id);
    expect(agent).toMatchObject({
      server_id: id,
      os_at_registration: 'linux',
      agent_type: 'telegraf',
      lifecycle: 'active',
    });
    expect(agent).not.toHaveProperty('status');
    const db = await admin();
    try {
      expect(
        (
          await db.query(
            "SELECT id FROM management.agents WHERE server_id=$1 AND lifecycle='active'",
            [id],
          )
        ).rowCount,
      ).toBe(1);
      expect((await call('DELETE', `/api/v1/servers/${id}`)).status).toBe(204);
      expect(
        (
          await db.query(
            'SELECT lifecycle FROM management.agents WHERE id=$1',
            [agent.id],
          )
        ).rows[0].lifecycle,
      ).toBe('disabled');
      expect(
        (
          await db.query(
            'SELECT revoked_at FROM management.api_credentials WHERE id=$1',
            [keyId],
          )
        ).rows[0].revoked_at,
      ).toBeInstanceOf(Date);
      expect((await register(id)).status).toBe(409);
      expect(
        (await call('POST', `/api/v1/agents/${agent.id}/enable`, {})).status,
      ).toBe(409);
    } finally {
      await db.end();
    }
  });
  it('disable/enable/retire revoke every DB key atomically and never restore historical keys', async () => {
    const id = await server();
    const a = await register(id);
    expect(a.status).toBe(201);
    const keys = [await key(a.body.id), await key(a.body.id)];
    expect(
      (await call('POST', `/api/v1/agents/${a.body.id}/disable`, {})).body
        .lifecycle,
    ).toBe('disabled');
    const db = await admin();
    try {
      const before = (
        await db.query(
          'SELECT id,revoked_at FROM management.api_credentials WHERE id=ANY($1::uuid[]) ORDER BY id',
          [keys],
        )
      ).rows;
      expect(before).toHaveLength(2);
      expect(before.every((row) => row.revoked_at instanceof Date)).toBe(true);
      expect(
        (await call('POST', `/api/v1/agents/${a.body.id}/enable`, {})).body
          .lifecycle,
      ).toBe('active');
      expect(
        (
          await db.query(
            'SELECT id,revoked_at FROM management.api_credentials WHERE id=ANY($1::uuid[]) ORDER BY id',
            [keys],
          )
        ).rows,
      ).toEqual(before);
      await key(a.body.id);
      expect(
        (await call('POST', `/api/v1/agents/${a.body.id}/retire`, {})).body,
      ).toMatchObject({
        lifecycle: 'retired',
        retired_at: expect.stringMatching(/Z$/),
      });
      for (const action of ['enable', 'disable'])
        expect(
          (await call('POST', `/api/v1/agents/${a.body.id}/${action}`, {}))
            .status,
        ).toBe(409);
      expect(
        (await call('POST', `/api/v1/agents/${a.body.id}/retire`, {})).status,
      ).toBe(201);
      expect(
        (
          await db.query(
            'SELECT id FROM management.api_credentials WHERE agent_id=$1 AND revoked_at IS NULL',
            [a.body.id],
          )
        ).rowCount,
      ).toBe(0);
      expect((await register(id)).status).toBe(201);
      expect(
        (
          await call('GET', `/api/v1/agents?server=${id}&lifecycle=retired`)
        ).body.items.map((x: { id: string }) => x.id),
      ).toEqual([a.body.id]);
    } finally {
      await db.end();
    }
  });
  it('two disabled Agents racing enable leave one active and a 409 loser', async () => {
    const id = await server();
    const a = await register(id);
    expect(
      (await call('POST', `/api/v1/agents/${a.body.id}/disable`, {})).status,
    ).toBe(201);
    const b = await register(id);
    expect(
      (await call('POST', `/api/v1/agents/${b.body.id}/disable`, {})).status,
    ).toBe(201);
    const results = await Promise.all(
      [a, b].map((x) => call('POST', `/api/v1/agents/${x.body.id}/enable`, {})),
    );
    expect(results.map((x) => x.status).sort()).toEqual([201, 409]);
    const db = await admin();
    try {
      expect(
        (
          await db.query(
            "SELECT id FROM management.agents WHERE server_id=$1 AND lifecycle='active'",
            [id],
          )
        ).rowCount,
      ).toBe(1);
    } finally {
      await db.end();
    }
  });
  it('archive racing register or enable never leaves active Agent or live keys on archived Server', async () => {
    for (const race of ['register', 'enable']) {
      const id = await server();
      const a = await register(id);
      expect(a.status).toBe(201);
      await key(a.body.id);
      expect(
        (await call('POST', `/api/v1/agents/${a.body.id}/disable`, {})).status,
      ).toBe(201);
      const results = await Promise.all([
        call('DELETE', `/api/v1/servers/${id}`),
        race === 'register'
          ? register(id)
          : call('POST', `/api/v1/agents/${a.body.id}/enable`, {}),
      ]);
      expect(results[0].status).toBe(204);
      expect([201, 409]).toContain(results[1].status);
      const db = await admin();
      try {
        expect(
          (
            await db.query(
              "SELECT id FROM management.agents WHERE server_id=$1 AND lifecycle='active'",
              [id],
            )
          ).rowCount,
        ).toBe(0);
        expect(
          (
            await db.query(
              'SELECT c.id FROM management.api_credentials c JOIN management.agents a ON a.id=c.agent_id WHERE a.server_id=$1 AND c.revoked_at IS NULL',
              [id],
            )
          ).rowCount,
        ).toBe(0);
        expect(
          (
            await db.query('SELECT id FROM management.agents WHERE id=$1', [
              a.body.id,
            ])
          ).rowCount,
        ).toBe(1);
      } finally {
        await db.end();
      }
    }
  });
  it('enforces active/registered OS and seeded published assignment compatibility without moving Agent', async () => {
    const id = await server();
    const other = await server();
    expect(
      (await call('POST', `/api/v1/servers/${id}/agents`, { server_id: other }))
        .status,
    ).toBe(400);
    expect(
      (
        await call('POST', `/api/v1/servers/${id}/agents`, {
          os_at_registration: 'windows',
        })
      ).status,
    ).toBe(400);
    const a = await register(id);
    expect(a.status).toBe(201);
    expect(
      (await call('PATCH', `/api/v1/servers/${id}`, { os: 'windows' })).status,
    ).toBe(409);
    expect(
      (
        await call('POST', `/api/v1/agents/${a.body.id}/disable`, {
          server_id: other,
        })
      ).status,
    ).toBe(400);
    expect(
      (await call('POST', `/api/v1/agents/${a.body.id}/disable`, {})).status,
    ).toBe(201);
    const db = await admin();
    try {
      const version = (
        await db.query(
          "SELECT v.id FROM management.profile_versions v JOIN management.monitoring_profiles p ON p.id=v.profile_id WHERE p.slug='linux-base' AND v.status='published' AND v.version=1",
        )
      ).rows[0].id;
      await db.query(
        "INSERT INTO management.server_profiles(server_id,profile_version_id,assigned_by) VALUES($1,$2,'{}')",
        [id, version],
      );
      expect(
        (await call('PATCH', `/api/v1/servers/${id}`, { os: 'windows' }))
          .status,
      ).toBe(409);
      await db.query(
        'DELETE FROM management.server_profiles WHERE server_id=$1',
        [id],
      );
      expect(
        (await call('PATCH', `/api/v1/servers/${id}`, { os: 'windows' }))
          .status,
      ).toBe(200);
      expect(
        (await call('POST', `/api/v1/agents/${a.body.id}/enable`, {})).status,
      ).toBe(409);
      // Deliberately inject an invalid assignment in guarded test DB, proving service rechecks it.
      await db.query(
        "INSERT INTO management.server_profiles(server_id,profile_version_id,assigned_by) VALUES($1,$2,'{}')",
        [id, version],
      );
      expect((await register(id)).status).toBe(409);
      expect(
        (
          await db.query(
            'SELECT server_id FROM management.agents WHERE id=$1',
            [a.body.id],
          )
        ).rows[0].server_id,
      ).toBe(id);
    } finally {
      await db.end();
    }
  });
  it('audit database failure rolls back disable, retire, archive, enable and registration with keys/history intact', async () => {
    const id = await server();
    const a = await register(id);
    const keyId = await key(a.body.id);
    const empty = await server();
    const disabled = await server();
    const b = await register(disabled);
    expect(
      (await call('POST', `/api/v1/agents/${b.body.id}/disable`, {})).status,
    ).toBe(201);
    const db = await admin();
    try {
      await db.query(
        'REVOKE INSERT ON management.audit_logs FROM management_runtime',
      );
      for (const action of ['disable', 'retire'])
        expect(
          (await call('POST', `/api/v1/agents/${a.body.id}/${action}`, {}))
            .status,
        ).toBe(503);
      expect((await call('DELETE', `/api/v1/servers/${id}`)).status).toBe(503);
      expect((await register(empty)).status).toBe(503);
      expect(
        (await call('POST', `/api/v1/agents/${b.body.id}/enable`, {})).status,
      ).toBe(503);
      expect(
        (
          await db.query(
            'SELECT lifecycle FROM management.agents WHERE id=$1',
            [a.body.id],
          )
        ).rows[0].lifecycle,
      ).toBe('active');
      expect(
        (
          await db.query(
            'SELECT lifecycle FROM management.agents WHERE id=$1',
            [b.body.id],
          )
        ).rows[0].lifecycle,
      ).toBe('disabled');
      expect(
        (
          await db.query(
            'SELECT archived_at FROM management.servers WHERE id=$1',
            [id],
          )
        ).rows[0].archived_at,
      ).toBeNull();
      expect(
        (
          await db.query(
            'SELECT revoked_at FROM management.api_credentials WHERE id=$1',
            [keyId],
          )
        ).rows[0].revoked_at,
      ).toBeNull();
      expect(
        (
          await db.query(
            'SELECT id FROM management.agents WHERE server_id=$1',
            [empty],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      await db.query(
        'GRANT INSERT ON management.audit_logs TO management_runtime',
      );
      await db.end();
    }
  });
});
