import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createManagementApp } from '../../src/bootstrap.js';
import { signedFixture } from '../support/keys.js';
import { admin, identity } from '../support/db.js';
import { readTestUrl } from '../support/pg-harness.js';
import { managementOpenApi } from '../../src/common/openapi.js';

// Breaks caught: missing resource policy, unsafe mass assignment/metadata/query,
// missing persisted CRUD/membership effects, unstable pagination, unaudited commit.
describe('Task4 signed HTTP inventory and Admin audit', () => {
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
    requestId = randomUUID(),
  ) {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const token = await fixture.sign({ method, target, body, role });
    const req = request(app.getHttpServer());
    const operation =
      method === 'GET'
        ? req.get(target)
        : method === 'POST'
          ? req.post(target)
          : method === 'PATCH'
            ? req.patch(target)
            : method === 'PUT'
              ? req.put(target)
              : req.delete(target);
    operation
      .set('Authorization', `Bearer ${token}`)
      .set('X-Request-Id', requestId);
    if (body) operation.set('Content-Type', 'application/json').send(body);
    return operation;
  }
  async function server() {
    const result = await call('POST', '/api/v1/servers', {
      name: 'inventory',
      os: 'linux',
      environment: `env-${randomUUID()}`,
      metadata: { rack: 'a' },
    });
    expect(result.status).toBe(201);
    return result.body;
  }
  it('persists bounded CRUD, idempotent membership and archive without deleting history', async () => {
    const s = await server();
    expect(Object.keys(s).sort()).toEqual([
      'archived_at',
      'created_at',
      'environment',
      'id',
      'metadata',
      'name',
      'os',
      'telemetry',
      'updated_at',
    ]);
    expect(s.telemetry).toMatchObject({
      status: 'Unknown', confidence_reason: 'no_active_agent',
    });
    const g = await call('POST', '/api/v1/server-groups', {
      name: 'group',
      slug: `g-${randomUUID()}`,
    });
    expect(g.status).toBe(201);
    expect(
      (await call('GET', `/api/v1/server-groups/${g.body.id}`)).body.name,
    ).toBe('group');
    expect(
      (
        await call('PATCH', `/api/v1/server-groups/${g.body.id}`, {
          name: 'renamed',
        })
      ).body.name,
    ).toBe('renamed');
    for (let i = 0; i < 2; i++)
      expect(
        (await call('PUT', `/api/v1/servers/${s.id}/groups/${g.body.id}`))
          .status,
      ).toBe(204);
    const db = await admin();
    try {
      expect(
        (
          await db.query(
            'SELECT * FROM management.server_group_members WHERE server_id=$1 AND group_id=$2',
            [s.id, g.body.id],
          )
        ).rowCount,
      ).toBe(1);
      const filtered = await call(
        'GET',
        `/api/v1/servers?group=${g.body.id}&environment=${s.environment}&os=linux&archive=false&name=inv`,
      );
      expect(filtered.body.items.map((x: { id: string }) => x.id)).toEqual([
        s.id,
      ]);
      expect(
        (
          await call('PATCH', `/api/v1/servers/${s.id}`, {
            name: 'updated',
            metadata: { note: ['a', 1, true, null] },
          })
        ).body.name,
      ).toBe('updated');
      expect(
        (await call('DELETE', `/api/v1/server-groups/${g.body.id}`)).status,
      ).toBe(204);
      expect(
        (
          await db.query('SELECT id FROM management.servers WHERE id=$1', [
            s.id,
          ])
        ).rowCount,
      ).toBe(1);
      for (let i = 0; i < 2; i++)
        expect((await call('DELETE', `/api/v1/servers/${s.id}`)).status).toBe(
          204,
        );
      expect(
        (await call('GET', `/api/v1/servers/${s.id}`)).body.archived_at,
      ).toMatch(/Z$/);
      expect(
        (await call('PATCH', `/api/v1/servers/${s.id}`, { name: 'restore' }))
          .status,
      ).toBe(409);
      expect(
        (
          await db.query(
            'SELECT count(*)::int AS n FROM management.audit_logs WHERE resource_id=$1',
            [s.id],
          )
        ).rows[0].n,
      ).toBeGreaterThanOrEqual(3);
    } finally {
      await db.end();
    }
  });
  it.each(['Viewer', 'Editor'])(
    '%s reads inventory but receives actual resource 403 on mutations and audit',
    async (role) => {
      const s = await server();
      const g = await call('POST', '/api/v1/server-groups', {
        name: 'rbac',
        slug: `g-${randomUUID()}`,
      });
      const a = await call('POST', `/api/v1/servers/${s.id}/agents`, {});
      expect(a.status).toBe(201);
      for (const target of [
        '/api/v1/servers',
        `/api/v1/servers/${s.id}`,
        '/api/v1/server-groups',
        `/api/v1/server-groups/${g.body.id}`,
        '/api/v1/agents',
        `/api/v1/agents/${a.body.id}`,
      ])
        expect((await call('GET', target, undefined, role)).status).toBe(200);
      for (const [method, target, body] of [
        ['POST', '/api/v1/servers', {}],
        ['PATCH', `/api/v1/servers/${s.id}`, {}],
        ['DELETE', `/api/v1/servers/${s.id}`, undefined],
        ['POST', '/api/v1/server-groups', {}],
        ['PATCH', `/api/v1/server-groups/${g.body.id}`, {}],
        ['DELETE', `/api/v1/server-groups/${g.body.id}`, undefined],
        ['PUT', `/api/v1/servers/${s.id}/groups/${g.body.id}`, undefined],
        ['DELETE', `/api/v1/servers/${s.id}/groups/${g.body.id}`, undefined],
        ['POST', `/api/v1/servers/${s.id}/agents`, {}],
        ...['disable', 'enable', 'retire'].map((action) => [
          'POST',
          `/api/v1/agents/${a.body.id}/${action}`,
          {},
        ]),
        ['GET', '/api/v1/audit-logs', undefined],
      ] as const)
        expect(
          (await call(method as string, target as string, body, role)).status,
        ).toBe(403);
    },
  );
  it.each([
    { name: '' },
    { name: 'a'.repeat(129) },
    { environment: 'x'.repeat(65) },
    { os: 'macos' },
    { server_id: randomUUID() },
    { metadata: null },
    { metadata: [] },
    { metadata: { nested: { ToKeN: 'rejected' } } },
    { metadata: { a: { b: { c: { d: 1 } } } } },
    { metadata: { ['k'.repeat(65)]: 1 } },
    { metadata: { x: 'x'.repeat(513) } },
    {
      metadata: Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [`k${i}`, 'x'.repeat(500)]),
      ),
    },
  ])('rejects unsafe create DTO %# without persistence', async (patch) => {
    expect(
      (
        await call('POST', '/api/v1/servers', {
          name: 'valid',
          os: 'linux',
          environment: 'test',
          ...patch,
        })
      ).status,
    ).toBe(400);
  });
  it('accepts metadata exactly at depth four, keeps validation local and rejects unsafe group/patch/id', async () => {
    const result = await call('POST', '/api/v1/servers', {
      name: 'a'.repeat(128),
      os: 'windows',
      environment: 'e'.repeat(64),
      metadata: { a: { b: { c: 'ok' } } },
    });
    expect(result.status).toBe(201);
    expect(
      (
        await call('PATCH', `/api/v1/servers/${result.body.id}`, {
          metadata: { api_key: 'no' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('PATCH', `/api/v1/servers/${result.body.id}`, {
          id: randomUUID(),
        })
      ).status,
    ).toBe(400);
    for (const slug of ['Upper', 'x'.repeat(65), 'has space', ''])
      expect(
        (await call('POST', '/api/v1/server-groups', { name: 'group', slug }))
          .status,
      ).toBe(400);
    expect((await call('GET', '/api/v1/servers/not-uuid')).status).toBe(400);
    expect((await call('GET', `/api/v1/servers/${randomUUID()}`)).status).toBe(
      404,
    );
    const slug = `dup-${randomUUID()}`;
    expect(
      (await call('POST', '/api/v1/server-groups', { name: 'a', slug })).status,
    ).toBe(201);
    expect(
      (await call('POST', '/api/v1/server-groups', { name: 'b', slug })).status,
    ).toBe(409);
  });
  it('uses stable tied-time cursor pages, server-owned filters and safe audit projection', async () => {
    const s = await server();
    const db = await admin();
    try {
      const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
      for (const id of ids)
        await db.query(
          "INSERT INTO management.servers(id,name,os,environment,created_at) VALUES($1,'page','linux',$2,'2026-01-01T00:00:00.123456Z')",
          [id, s.environment],
        );
      const page1 = await call(
        'GET',
        `/api/v1/servers?environment=${s.environment}&limit=2`,
      );
      expect(page1.body.items.map((x: { id: string }) => x.id)).toEqual(
        ids.slice(0, 2),
      );
      const page2 = await call(
        'GET',
        `/api/v1/servers?environment=${s.environment}&limit=2&cursor=${page1.body.next_cursor}`,
      );
      expect(page2.body.items.map((x: { id: string }) => x.id)).toEqual([
        ids[2],
        s.id,
      ]);
      expect(page2.body.next_cursor).toBeNull();
      // Prefix is literal, not a caller-controlled SQL LIKE wildcard.
      expect(
        (
          await call(
            'GET',
            `/api/v1/servers?environment=${s.environment}&name=%25`,
          )
        ).body.items,
      ).toEqual([]);
      expect(
        (
          await call(
            'GET',
            `/api/v1/servers?environment=${s.environment}&name=_`,
          )
        ).body.items,
      ).toEqual([]);
      for (const query of [
        'limit=101',
        'limit=0',
        'limit=2&limit=3',
        'cursor=not_valid',
        'orderBy=name',
        'where[x]=1',
        'os=macos',
        'archive=maybe',
        'group=invalid',
      ])
        expect((await call('GET', `/api/v1/servers?${query}`)).status).toBe(
          400,
        );
      const audit = await call(
        'GET',
        `/api/v1/audit-logs?actor_issuer=grafana-fixture&actor_subject=opaque-user-17&resource_type=server&resource_id=${s.id}&action=create&from=2020-01-01T00%3A00%3A00.000Z&to=2099-01-01T00%3A00%3A00.000Z&limit=1`,
      );
      expect(audit.status).toBe(200);
      expect(audit.body.items).toHaveLength(1);
      expect(audit.body.items[0]).toMatchObject({
        resource_id: s.id,
        operation: 'create',
        actor_subject: 'opaque-user-17',
        outcome: 'success',
      });
      expect(audit.body.items[0].delta).not.toHaveProperty('metadata');
      expect(Object.keys(audit.body.items[0]).sort()).toEqual([
        'actor_display',
        'actor_issuer',
        'actor_kind',
        'actor_subject',
        'created_at',
        'delta',
        'id',
        'operation',
        'outcome',
        'request_id',
        'resource_id',
        'resource_type',
      ]);
      for (const query of [
        'action=drop',
        'resource_type=users',
        'from=tomorrow',
        'actor_subject=x&actor_subject=y',
        'secret_hash=x',
        'from=2099-01-01T00%3A00%3A00.000Z&to=2020-01-01T00%3A00%3A00.000Z',
      ])
        expect((await call('GET', `/api/v1/audit-logs?${query}`)).status).toBe(
          400,
        );
    } finally {
      await db.end();
    }
  });
  it('rolls back real inventory and membership writes when audit INSERT is denied', async () => {
    const s = await server();
    const g = await call('POST', '/api/v1/server-groups', {
      name: 'rollback',
      slug: `g-${randomUUID()}`,
    });
    const db = await admin();
    const requestId = randomUUID();
    try {
      await db.query(
        'REVOKE INSERT ON management.audit_logs FROM management_runtime',
      );
      expect(
        (
          await call(
            'POST',
            '/api/v1/servers',
            { name: 'rollback', os: 'linux', environment: requestId },
            'Admin',
            requestId,
          )
        ).status,
      ).toBe(503);
      expect(
        (
          await call('PATCH', `/api/v1/servers/${s.id}`, {
            name: 'must rollback',
          })
        ).status,
      ).toBe(503);
      expect(
        (await call('PUT', `/api/v1/servers/${s.id}/groups/${g.body.id}`))
          .status,
      ).toBe(503);
      expect(
        (await call('DELETE', `/api/v1/server-groups/${g.body.id}`)).status,
      ).toBe(503);
      expect(
        (
          await db.query(
            'SELECT id FROM management.servers WHERE environment=$1',
            [requestId],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await db.query('SELECT name FROM management.servers WHERE id=$1', [
            s.id,
          ])
        ).rows[0].name,
      ).toBe('inventory');
      expect(
        (
          await db.query(
            'SELECT * FROM management.server_group_members WHERE server_id=$1',
            [s.id],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await db.query(
            'SELECT id FROM management.server_groups WHERE id=$1',
            [g.body.id],
          )
        ).rowCount,
      ).toBe(1);
    } finally {
      await db.query(
        'GRANT INSERT ON management.audit_logs TO management_runtime',
      );
      await db.end();
    }
  });
  it('documents inventory/audit assertion policy and service-only status reports', () => {
    const doc = managementOpenApi(app);
    expect(doc.paths['/api/v1/servers']?.get?.security).toEqual([
      { AdminAssertion: [] },
    ]);
    expect(doc.paths['/api/v1/audit-logs']?.get?.description).toMatch(/Admin/);
    expect(doc.paths['/api/v1/servers']?.get?.responses['200']).toMatchObject({
      content: {
        'application/json': {
          schema: {
            properties: {
              items: { items: { $ref: '#/components/schemas/ServerDto' } },
            },
          },
        },
      },
    });
    expect(doc.components?.schemas?.CreateServerDto).toMatchObject({
      required: ['name', 'os', 'environment'],
    });
    expect(doc.components?.schemas?.PatchServerDto).not.toHaveProperty(
      'required',
    );
    expect(doc.components?.schemas?.AgentDto).toMatchObject({
      properties: { lifecycle: { enum: ['active', 'disabled', 'retired'] } },
    });
    expect(doc.components?.schemas?.AgentDto).not.toHaveProperty(
      'properties.status',
    );
    expect(doc.components?.schemas?.AgentDto).not.toHaveProperty(
      'properties.secret_hash',
    );
    expect(
      doc.paths['/internal/v1/status/reports']?.post?.security,
    ).toEqual([{ InternalServiceAssertion: [] }]);
    expect(
      doc.paths['/internal/v1/status/reports']?.post?.responses['200'],
    ).toBeDefined();
  });
});
