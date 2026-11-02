import request from 'supertest';
import { createHash, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createManagementApp } from '../../src/bootstrap.js';
import { managementOpenApi } from '../../src/common/openapi.js';
import { signedFixture } from '../support/keys.js';
import { countLeaks } from '../support/config.js';
import { admin, identity } from '../support/db.js';
import { readTestUrl } from '../support/pg-harness.js';

const GET = '/api/v1/agent/provisioning';
const REPORT = '/api/v1/agent/config-reports';
const base = (os = 'linux', interval = 15) => ({
  schema_version: 1,
  os,
  interval_seconds: interval,
  metric_groups: { cpu: true, memory: true, disk: true, network: true },
  options: {},
});
type Owner = { server: string; agent: string; key: string; credential: string };
type Version = {
  id: string;
  profile_id: string;
  checksum: string;
  version: number;
};

// Breaks caught: cross-owner selection, untrusted ingest origin, GET-as-applied,
// arbitrary historical reports, partial receipt/report commits, stale lifecycle
// authorization after lock waits, changed desired state, and metric/status claims.
describe('Task7 own-Agent provisioning receipts and agent-reported config', () => {
  let app: INestApplication;
  let fixture: ReturnType<typeof signedFixture>;
  let sensitive: string[];
  beforeEach(async () => {
    fixture = signedFixture();
    const databaseUrl = readTestUrl(identity().runtimeFile);
    sensitive = [databaseUrl, new URL(databaseUrl).password];
    app = await createManagementApp({
      ...fixture.config,
      databaseUrl,
      MANAGEMENT_AGENT_INGEST_BASE_URL: 'https://ingest.example.test:8443',
      MANAGEMENT_REQUEST_RATE_PER_SECOND: 1000,
      MANAGEMENT_REQUEST_BURST: 1000,
    });
    await app.init();
  });
  afterEach(async () => {
    await app.close();
    fixture.cleanup();
  });
  async function signed(method: string, target: string, payload?: unknown) {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const token = await fixture.sign({ role: 'Admin', method, target, body });
    sensitive.push(token);
    const http = request(app.getHttpServer());
    const req =
      method === 'GET'
        ? http.get(target)
        : method === 'POST'
          ? http.post(target)
          : method === 'PUT'
            ? http.put(target)
            : http.delete(target);
    req
      .set('Authorization', `Bearer ${token}`)
      .set('X-Request-Id', randomUUID());
    if (body) req.set('Content-Type', 'application/json').send(body);
    return req;
  }
  async function owner(
    os = 'linux',
    scopes = ['metrics:write', 'provisioning:read', 'config:report'],
  ): Promise<Owner> {
    const server = await signed('POST', '/api/v1/servers', {
      name: 'task7 server',
      os,
      environment: 'task7',
    });
    expect(server.status).toBe(201);
    const agent = await signed(
      'POST',
      `/api/v1/servers/${server.body.id}/agents`,
      {},
    );
    expect(agent.status).toBe(201);
    const key = await signed(
      'POST',
      `/api/v1/agents/${agent.body.id}/credentials`,
      { issuance_request_id: randomUUID(), scopes },
    );
    expect(key.status).toBe(201);
    const secret = key.body.api_key.split('.')[1];
    sensitive.push(
      key.body.api_key,
      secret,
      createHash('sha256')
        .update(Buffer.from(secret, 'base64url'))
        .digest('hex'),
      createHash('sha256')
        .update(Buffer.from(secret, 'base64url'))
        .digest('base64'),
    );
    return {
      server: server.body.id,
      agent: agent.body.id,
      key: key.body.api_key,
      credential: key.body.id,
    };
  }
  async function version(
    os = 'linux',
    interval = 15,
    publish = true,
  ): Promise<Version> {
    const p = await signed('POST', '/api/v1/monitoring-profiles', {
      slug: `t7-${randomUUID()}`,
      name: 'task7 profile',
      description: '',
      os,
    });
    expect(p.status).toBe(201);
    const v = await signed(
      'POST',
      `/api/v1/monitoring-profiles/${p.body.id}/versions`,
      { config: base(os, interval) },
    );
    expect(v.status).toBe(201);
    if (publish)
      expect(
        (
          await signed(
            'POST',
            `/api/v1/profile-versions/${v.body.id}/publish`,
            {},
          )
        ).status,
      ).toBe(201);
    return v.body;
  }
  async function assign(o: Owner, v: Version) {
    expect(
      (
        await signed('PUT', `/api/v1/servers/${o.server}/profile`, {
          profile_version_id: v.id,
        })
      ).status,
    ).toBe(200);
  }
  function own(o: Owner, target = GET) {
    return request(app.getHttpServer())
      .get(target)
      .set('Authorization', `Bearer ${o.key}`);
  }
  function report(o: Owner, v: Version, result = 'applied', extra = {}) {
    return request(app.getHttpServer())
      .post(REPORT)
      .set('Authorization', `Bearer ${o.key}`)
      .send({
        profile_version_id: v.id,
        checksum: v.checksum,
        result,
        ...extra,
      });
  }
  async function state(o: Owner) {
    const db = await admin();
    try {
      return (
        await db.query(
          'SELECT last_metric_seen_at,last_applied_profile_version_id,last_applied_at,last_config_report_result,last_config_report_at,version,version_source,version_reported_at FROM management.agents WHERE id=$1',
          [o.agent],
        )
      ).rows[0];
    } finally {
      await db.end();
    }
  }
  async function receipts(o: Owner) {
    const db = await admin();
    try {
      return (
        await db.query(
          'SELECT profile_version_id,checksum,first_provisioned_at,last_provisioned_at FROM management.agent_provisioning_receipts WHERE agent_id=$1 ORDER BY profile_version_id',
          [o.agent],
        )
      ).rows;
    } finally {
      await db.end();
    }
  }
  function safe(text: string) {
    expect(countLeaks(text, sensitive)).toBe(0);
  }

  it('returns409 provisioning_not_ready without assignment and never auto-creates a receipt or applies config', async () => {
    const o = await owner();
    const r = await own(o);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('provisioning_not_ready');
    expect(await receipts(o)).toEqual([]);
    expect(await state(o)).toMatchObject({
      last_applied_profile_version_id: null,
      last_metric_seen_at: null,
      last_config_report_at: null,
    });
    safe(r.text);
  });
  it.each(['linux', 'windows'])(
    'returns trusted %s own config/protocol only, atomically upserts receipt, never marks applied or Online',
    async (os) => {
      const o = await owner(os),
        v = await version(os);
      await assign(o, v);
      const r = await own(o)
        .set('Host', 'attacker.example:9999')
        .set('X-Forwarded-Host', 'other.example')
        .set('X-Forwarded-Proto', 'http');
      expect(r.status).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
      // Count-only leak gate precedes structural diffs: a regression must not
      // print fixture credentials/URLs/assertions as assertion diagnostics.
      safe(r.text);
      expect(r.body).toEqual({
        server_id: o.server,
        agent_id: o.agent,
        os,
        profile: {
          id: v.profile_id,
          version_id: v.id,
          version: 1,
          checksum: v.checksum,
          config: base(os),
        },
        ingestion: {
          base_url: 'https://ingest.example.test:8443',
          path: '/api/v1/ingest/remote-write',
          content_type: 'application/x-protobuf',
          content_encoding: 'snappy',
          remote_write_version: '0.1.0',
          authorization_scheme: 'Bearer',
          identity_headers: { 'X-Server-ID': o.server, 'X-Agent-ID': o.agent },
        },
      });
      for (const field of ['api_key', 'secret_hash', 'databaseUrl', 'status'])
        expect(r.body).not.toHaveProperty(field);
      const first = await receipts(o);
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({
        profile_version_id: v.id,
        checksum: v.checksum,
      });
      expect((await own(o)).status).toBe(200);
      const second = await receipts(o);
      expect(second).toHaveLength(1);
      expect(second[0].first_provisioned_at).toEqual(
        first[0].first_provisioned_at,
      );
      expect(second[0].last_provisioned_at.getTime()).toBeGreaterThanOrEqual(
        first[0].last_provisioned_at.getTime(),
      );
      expect(await state(o)).toEqual({
        last_metric_seen_at: null,
        last_applied_profile_version_id: null,
        last_applied_at: null,
        last_config_report_result: null,
        last_config_report_at: null,
        version: null,
        version_source: null,
        version_reported_at: null,
      });
    },
  );
  it('rejects query resource selection and mismatched/malformed/duplicate optional identity headers, accepts matching claims', async () => {
    const a = await owner(),
      b = await owner(),
      v = await version();
    await assign(a, v);
    for (const q of [
      `server_id=${b.server}`,
      `agent_id=${b.agent}`,
      'unknown=x',
      'server_id[]=x',
    ])
      expect((await own(a, `${GET}?${q}`)).status).toBe(400);
    expect((await own(a).set('X-Server-ID', b.server)).status).toBe(403);
    expect((await own(a).set('X-Agent-ID', b.agent)).status).toBe(403);
    expect((await own(a).set('X-Agent-ID', 'malformed')).status).toBe(400);
    expect(
      (await own(a).set({ 'X-Agent-ID': [a.agent, a.agent] })).status,
    ).toBe(400);
    expect(
      (await own(a).set('X-Server-ID', a.server).set('X-Agent-ID', a.agent))
        .status,
    ).toBe(200);
    expect(await receipts(b)).toEqual([]);
    expect((await report(a, v).set('X-Agent-ID', b.agent)).status).toBe(403);
    expect(
      (
        await request(app.getHttpServer())
          .post(`${REPORT}?server_id=${b.server}`)
          .set('Authorization', `Bearer ${a.key}`)
          .send({
            profile_version_id: v.id,
            checksum: v.checksum,
            result: 'applied',
          })
      ).status,
    ).toBe(400);
    expect((await report(a, v, 'applied', { agent_id: b.agent })).status).toBe(
      400,
    );
  });
  it('enforces the existing primary-DB Agent scopes, rejects Admin/service assertions and emits only bounded safe security records', async () => {
    const read = await owner('linux', ['provisioning:read']),
      write = await owner('linux', ['config:report']);
    const v = await version();
    await assign(read, v);
    await assign(write, v);
    const logs: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    const capture = vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: unknown,
      ...args: unknown[]
    ) => {
      if (
        typeof chunk === 'string' &&
        logs.length < 5 &&
        /^\{"event":"request_failed","code":"(?:forbidden|unauthorized)","status":(?:401|403)\}\n$/.test(
          chunk,
        )
      ) {
        logs.push(chunk);
        return true;
      }
      return (original as (...args: unknown[]) => boolean)(chunk, ...args);
    }) as typeof process.stdout.write);
    try {
      expect((await own(write)).status).toBe(403);
      expect((await report(read, v)).status).toBe(403);
      expect((await request(app.getHttpServer()).get(GET)).status).toBe(401);
      expect((await signed('GET', GET)).status).toBe(401);
      const token = await fixture.sign({
        kind: 'service',
        method: 'GET',
        target: GET,
      });
      sensitive.push(token);
      expect(
        (
          await request(app.getHttpServer())
            .get(GET)
            .set('Authorization', `Bearer ${token}`)
        ).status,
      ).toBe(401);
    } finally {
      capture.mockRestore();
    }
    expect(logs.length).toBe(5);
    expect(logs.map((line) => JSON.parse(line))).toEqual([
      { event: 'request_failed', code: 'forbidden', status: 403 },
      { event: 'request_failed', code: 'forbidden', status: 403 },
      { event: 'request_failed', code: 'unauthorized', status: 401 },
      { event: 'request_failed', code: 'unauthorized', status: 401 },
      { event: 'request_failed', code: 'unauthorized', status: 401 },
    ]);
    safe(logs.join(''));
    expect(await receipts(write)).toEqual([]);
  });
  it('accepts only own historical receipts, records reported version/time and failure retains applied while desired rollback/drift remains visible', async () => {
    const o = await owner(),
      old = await version(),
      next = await version('linux', 30);
    await assign(o, old);
    expect((await own(o)).status).toBe(200);
    await assign(o, next);
    expect((await own(o)).status).toBe(200);
    const applied = await report(o, next, 'applied', {
      agent_version: '1.37.2-lab',
    });
    expect(applied.status).toBe(204);
    safe(applied.text);
    const first = await state(o);
    expect(first).toMatchObject({
      last_applied_profile_version_id: next.id,
      last_config_report_result: 'applied',
      version: '1.37.2-lab',
      version_source: 'agent_reported',
      last_metric_seen_at: null,
    });
    expect(first.last_config_report_at).toBeInstanceOf(Date);
    expect(first.version_reported_at).toEqual(first.last_config_report_at);
    expect((await report(o, old, 'failed')).status).toBe(204);
    const failed = await state(o);
    expect(failed.last_applied_profile_version_id).toBe(next.id);
    expect(failed.last_applied_at).toEqual(first.last_applied_at);
    expect(failed.last_config_report_result).toBe('failed');
    expect(failed.version_reported_at).toEqual(first.version_reported_at);
    expect((await report(o, old)).status).toBe(204); // historical receipt, not current desired
    expect(
      (await signed('GET', `/api/v1/servers/${o.server}/profile`)).body
        .profile_version_id,
    ).toBe(next.id);
    const agent = await signed('GET', `/api/v1/agents/${o.agent}`);
    safe(agent.text);
    expect(agent.body).toMatchObject({
      last_applied_profile_version_id: old.id,
      last_config_report_result: 'applied',
      version_source: 'agent_reported',
    });
    expect(agent.body.last_applied_at).toMatch(/Z$/);
    expect(agent.body.last_config_report_at).toMatch(/Z$/);
    expect(agent.body).not.toHaveProperty('status');
    expect((await state(o)).last_metric_seen_at).toBeNull();
    await assign(o, old); // desired rollback does not mutate the reported state
    expect((await own(o)).body.profile.version_id).toBe(old.id);
    const db = await admin();
    try {
      const audits = (
        await db.query(
          "SELECT actor_kind,actor_issuer,actor_subject,operation,delta FROM management.audit_logs WHERE resource_id=$1 AND operation='config_report' ORDER BY created_at,id",
          [o.agent],
        )
      ).rows;
      safe(JSON.stringify(audits));
      expect(audits).toHaveLength(3);
      expect(audits[0]).toMatchObject({
        actor_kind: 'agent',
        actor_subject: o.agent,
        operation: 'config_report',
        delta: {
          profile_version_id: next.id,
          checksum: next.checksum,
          result: 'applied',
        },
      });
    } finally {
      await db.end();
    }
  });
  it('rejects never-provisioned, other-Agent, wrong-checksum, draft and other-OS reports without partial state', async () => {
    const a = await owner(),
      b = await owner(),
      v = await version(),
      draft = await version('linux', 15, false),
      win = await version('windows');
    await assign(a, v);
    expect((await report(a, v)).status).toBe(409); // assignment alone is not a receipt
    expect((await own(a)).status).toBe(200);
    expect((await report(b, v)).status).toBe(409);
    expect(
      (await report(a, v, 'applied', { checksum: '0'.repeat(64) })).status,
    ).toBe(409);
    const db = await admin();
    try {
      for (const x of [draft, win])
        await db.query(
          'INSERT INTO management.agent_provisioning_receipts(agent_id,profile_version_id,checksum) VALUES($1,$2,$3)',
          [a.agent, x.id, x.checksum],
        );
    } finally {
      await db.end();
    }
    for (const x of [draft, win]) {
      const r = await report(a, x);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('profile_not_provisioned');
      safe(r.text);
    }
    expect(await state(a)).toMatchObject({
      last_applied_profile_version_id: null,
      last_config_report_at: null,
      last_metric_seen_at: null,
    });
  });
  it('rejects raw config/stdout/secret, unknown/invalid report fields and malformed or unbounded reported versions', async () => {
    const o = await owner(),
      v = await version();
    await assign(o, v);
    expect((await own(o)).status).toBe(200);
    for (const extra of [
      { config: base() },
      { stdout: 'not accepted' },
      { api_key: o.key },
      { profile_version_id: 'latest' },
      { checksum: 'A'.repeat(64) },
      { result: 'online' },
      { agent_version: '' },
      { agent_version: null },
      { agent_version: 'x'.repeat(129) },
      { agent_version: 'bad\nversion' },
    ]) {
      const r = await report(o, v, 'applied', extra);
      expect(r.status).toBe(400);
      safe(r.text);
    }
    expect(
      (
        await request(app.getHttpServer())
          .post(REPORT)
          .set('Authorization', `Bearer ${o.key}`)
          .send({})
      ).status,
    ).toBe(400);
    expect(await state(o)).toMatchObject({
      last_applied_profile_version_id: null,
      last_config_report_at: null,
    });
  });
  it('keeps existing retired published pins provisionable and reportable, but cannot newly assign retired profiles', async () => {
    const o = await owner(),
      v = await version();
    await assign(o, v);
    expect(
      (
        await signed(
          'POST',
          `/api/v1/monitoring-profiles/${v.profile_id}/retire`,
          {},
        )
      ).status,
    ).toBe(201);
    expect((await own(o)).status).toBe(200);
    expect((await report(o, v)).status).toBe(204);
    expect(
      (
        await signed('PUT', `/api/v1/servers/${o.server}/profile`, {
          profile_version_id: v.id,
        })
      ).status,
    ).toBe(409);
  });
  it('fails GET closed if the receipt cannot commit and leaves applied/report/metric state untouched', async () => {
    const o = await owner(),
      v = await version();
    await assign(o, v);
    const db = await admin();
    try {
      await db.query(
        'REVOKE INSERT ON management.agent_provisioning_receipts FROM management_runtime',
      );
      const r = await own(o);
      expect(r.status).toBe(503);
      safe(r.text);
      expect(await receipts(o)).toEqual([]);
      expect((await state(o)).last_applied_profile_version_id).toBeNull();
    } finally {
      await db.query(
        'GRANT INSERT ON management.agent_provisioning_receipts TO management_runtime',
      );
      await db.end();
    }
  });
  it('rolls back reported result/version/applied state atomically when the actual config-report audit INSERT fails', async () => {
    const o = await owner(),
      v = await version();
    await assign(o, v);
    expect((await own(o)).status).toBe(200);
    const before = await state(o),
      db = await admin();
    try {
      await db.query(
        'REVOKE INSERT ON management.audit_logs FROM management_runtime',
      );
      const r = await report(o, v, 'applied', { agent_version: '1.2.3' });
      expect(r.status).toBe(503);
      safe(r.text);
      expect(await state(o)).toEqual(before);
    } finally {
      await db.query(
        'GRANT INSERT ON management.audit_logs TO management_runtime',
      );
      await db.end();
    }
  });
  it.each(['disable', 'retire', 'archive', 'revoke'])(
    'denies fresh GET/report after %s without waiting for any Gateway cache',
    async (action) => {
      const o = await owner(),
        v = await version();
      await assign(o, v);
      expect((await own(o)).status).toBe(200);
      const r =
        action === 'archive'
          ? await signed('DELETE', `/api/v1/servers/${o.server}`)
          : action === 'revoke'
            ? await signed(
                'POST',
                `/api/v1/credentials/${o.credential}/revoke`,
                {},
              )
            : await signed('POST', `/api/v1/agents/${o.agent}/${action}`, {});
      expect([201, 204]).toContain(r.status);
      expect((await own(o)).status).toBe(401);
      expect((await report(o, v)).status).toBe(401);
      if (action === 'disable') {
        expect(
          (await signed('POST', `/api/v1/agents/${o.agent}/enable`, {})).status,
        ).toBe(201);
        expect((await own(o)).status).toBe(401); // enable never revives the key
      }
      expect((await state(o)).last_applied_profile_version_id).toBeNull();
    },
  );

  // Real primary proof reads the precommit state. The handler must then wait on
  // the existing Server lock and re-read state/assignment after its owner commits.
  async function whileServerLocked(
    o: Owner,
    start: () => PromiseLike<request.Response>,
    mutate: (db: Awaited<ReturnType<typeof admin>>) => Promise<unknown>,
  ) {
    const db = await admin();
    let pending: Promise<request.Response> | undefined;
    let waiting = 0;
    try {
      await db.query('BEGIN');
      await db.query(
        'SELECT id FROM management.servers WHERE id=$1 FOR UPDATE',
        [o.server],
      );
      pending = Promise.resolve(start());
      const deadline = performance.now() + 800;
      do {
        // PostgreSQL caches statistics per transaction; observe fresh activity,
        // not the first empty snapshot while holding this transaction's lock.
        await db.query('SELECT pg_stat_clear_snapshot()');
        waiting = (
          await db.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM management.servers WHERE id=%'",
          )
        ).rows[0].n;
        if (waiting >= 1) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      } while (performance.now() < deadline);
      await mutate(db);
      await db.query('COMMIT');
    } finally {
      await db.query('ROLLBACK');
      await db.end();
    }
    const r = await pending!;
    expect(waiting).toBe(1);
    return r;
  }
  it.each(
    ['revoke', 'disable', 'archive', 'expire', 'cutoff'].flatMap((action) =>
      ['get', 'report'].map((endpoint) => ({ action, endpoint })),
    ),
  )(
    'rechecks $action for $endpoint committed during the real post-auth Server lock wait',
    async ({ action, endpoint }) => {
      const o = await owner(),
        v = await version();
      await assign(o, v);
      expect((await own(o)).status).toBe(200);
      const before = await receipts(o);
      const r = await whileServerLocked(
        o,
        () => (endpoint === 'get' ? own(o) : report(o, v)),
        async (db) => {
          if (action === 'revoke')
            await db.query(
              'UPDATE management.api_credentials SET revoked_at=clock_timestamp() WHERE id=$1',
              [o.credential],
            );
          if (action === 'disable')
            await db.query(
              "UPDATE management.agents SET lifecycle='disabled' WHERE id=$1",
              [o.agent],
            );
          if (action === 'archive')
            await db.query(
              'UPDATE management.servers SET archived_at=clock_timestamp() WHERE id=$1',
              [o.server],
            );
          if (action === 'expire')
            await db.query(
              "UPDATE management.api_credentials SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",
              [o.credential],
            );
          if (action === 'cutoff')
            await db.query(
              "UPDATE management.api_credentials SET retire_at=clock_timestamp()-interval '1 second' WHERE id=$1",
              [o.credential],
            );
        },
      );
      expect(r.status).toBe(401);
      expect((await state(o)).last_config_report_at).toBeNull();
      expect(await receipts(o)).toEqual(before);
      safe(r.text);
      expect((await own(o)).status).toBe(401);
    },
  );
  it('reads exact assignment after the real Server lock wait and issues only that immutable receipt, not an earlier snapshot', async () => {
    const o = await owner(),
      old = await version(),
      next = await version('linux', 30);
    await assign(o, old);
    const r = await whileServerLocked(
      o,
      () => own(o),
      (db) =>
        db.query(
          'UPDATE management.server_profiles SET profile_version_id=$1 WHERE server_id=$2',
          [next.id, o.server],
        ),
    );
    expect(r.status).toBe(200);
    expect(r.body.profile.version_id).toBe(next.id);
    expect((await receipts(o)).map((x) => x.profile_version_id)).toEqual([
      next.id,
    ]);
    expect((await report(o, old)).status).toBe(409);
    expect((await state(o)).last_metric_seen_at).toBeNull();
  });
  it('keeps an exact published pin after a newer version is published, including concurrent receipt refreshes', async () => {
    const o = await owner(),
      pinned = await version();
    await assign(o, pinned);
    const newer = await signed(
      'POST',
      `/api/v1/monitoring-profiles/${pinned.profile_id}/versions`,
      { config: base('linux', 60) },
    );
    expect(newer.status).toBe(201);
    expect(
      (
        await signed(
          'POST',
          `/api/v1/profile-versions/${newer.body.id}/publish`,
          {},
        )
      ).status,
    ).toBe(201);
    const responses = await Promise.all([own(o), own(o)]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(responses.map((r) => r.body.profile.version_id)).toEqual([
      pinned.id,
      pinned.id,
    ]);
    expect((await receipts(o)).map((r) => r.profile_version_id)).toEqual([
      pinned.id,
    ]);
    expect((await report(o, newer.body)).status).toBe(409);
  });
  it('records first failure/version as Agent-reported without applied state and preserves existing metric receipt through GET/report', async () => {
    const o = await owner(),
      v = await version();
    await assign(o, v);
    const metric = new Date('2026-10-20T10:10:10.123Z'),
      db = await admin();
    try {
      await db.query(
        'UPDATE management.agents SET last_metric_seen_at=$1 WHERE id=$2',
        [metric, o.agent],
      );
    } finally {
      await db.end();
    }
    expect((await own(o)).status).toBe(200);
    const r = await report(o, v, 'failed', {
      agent_version: 'Telegraf 1.37.2+lab',
    });
    expect(r.status).toBe(204);
    expect(r.headers['cache-control']).toBe('no-store');
    const failed = await state(o);
    expect(failed).toMatchObject({
      last_metric_seen_at: metric,
      last_applied_profile_version_id: null,
      last_applied_at: null,
      last_config_report_result: 'failed',
      version: 'Telegraf 1.37.2+lab',
      version_source: 'agent_reported',
    });
    expect(failed.last_config_report_at).toEqual(failed.version_reported_at);
    expect((await own(o)).status).toBe(200);
    expect(await state(o)).toEqual(failed);
    const listed = await signed('GET', `/api/v1/agents?server=${o.server}`);
    safe(listed.text);
    expect(listed.status).toBe(200);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0]).toMatchObject({
      last_applied_profile_version_id: null,
      last_config_report_result: 'failed',
      last_config_report_at: failed.last_config_report_at.toISOString(),
      version_source: 'agent_reported',
    });
  });
  it('documents separate scoped AgentApiKey policies, nonsecret examples/no-store and installer handoff rather than runtime qualification', () => {
    const doc = managementOpenApi(app);
    expect(doc.paths[GET]?.get?.security).toEqual([{ AgentApiKey: [] }]);
    expect(doc.paths[REPORT]?.post?.security).toEqual([{ AgentApiKey: [] }]);
    expect(doc.paths[GET]?.get?.description).toMatch(/provisioning:read/);
    expect(doc.paths[GET]?.get?.description).toMatch(/no-store/i);
    expect(doc.paths[REPORT]?.post?.description).toMatch(/config:report/);
    expect(doc.paths[REPORT]?.post?.description).toMatch(/Agent-reported/);
    expect(doc.components?.schemas?.ConfigReportDto).toMatchObject({
      additionalProperties: false,
    });
    expect(doc.components?.schemas?.ProvisioningDto).toBeDefined();
    safe(JSON.stringify(doc));
  });
});
