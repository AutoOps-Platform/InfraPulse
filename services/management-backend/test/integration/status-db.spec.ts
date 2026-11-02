import request from 'supertest';
import { createHash, randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { INestApplication } from '@nestjs/common';
import { createManagementApp } from '../../src/bootstrap.js';
import { signedFixture } from '../support/keys.js';
import { admin, identity } from '../support/db.js';
import { readTestUrl } from '../support/pg-harness.js';

const EPOCH = '/internal/v1/status/epoch',
  REPORT = '/internal/v1/status/reports';
const hash = (x: unknown) =>
  createHash('sha256').update(canonicalize(x)!).digest('hex');
type RecordProof = {
  agent_id: string;
  server_id: string;
  credential_id: string;
  last_success_at: string;
};
// Real signatures + actual runtime-role transactions. Administrative SQL is only
// fixture setup/inspection: no implementation clock, fake DB or Grafana claim.
describe('Task10 durable epoch/chunk observation protocol', () => {
  let app: INestApplication,
    fixture: ReturnType<typeof signedFixture>,
    gateway: string;
  async function start() {
    app = await createManagementApp({
      ...fixture.config,
      databaseUrl: readTestUrl(identity().runtimeFile),
      serviceTrust: {
        gateway: {
          ...fixture.config.serviceTrust.gateway,
          subject: gateway,
          scopes: ['status:write'],
        },
      },
      MANAGEMENT_REQUEST_RATE_PER_SECOND: 1000,
      MANAGEMENT_REQUEST_BURST: 1000,
    });
    await app.init();
  }
  beforeEach(async () => {
    fixture = signedFixture();
    gateway = randomUUID();
    const db = await admin();
    try {
      await db.query(
        'INSERT INTO management.gateway_sources(gateway_id) VALUES($1)',
        [gateway],
      );
    } finally {
      await db.end();
    }
    await start();
  });
  afterEach(async () => {
    await app?.close();
    fixture.cleanup();
  });
  async function call(
    method: string,
    target: string,
    payload?: unknown,
    kind: 'service' | 'user' = 'service',
  ) {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const token = await fixture.sign({
      kind,
      role: 'Admin',
      method,
      target,
      body,
      claims: kind === 'service' ? { sub: gateway } : undefined,
    });
    const h = request(app.getHttpServer());
    const r = method === 'GET' ? h.get(target) : h.post(target);
    r.set('Authorization', `Bearer ${token}`);
    if (body) r.set('Content-Type', 'application/json').send(body);
    return r;
  }
  async function timestamp(): Promise<string> {
    return (
      await sql('SELECT clock_timestamp() AS now')
    ).rows[0].now.toISOString();
  }
  async function open() {
    const r = await call('POST', EPOCH, {
      boot_id: randomUUID(),
      boot_started_at: await timestamp(),
      expected_epoch: 0,
    });
    expect(r.status).toBe(200);
    return r.body;
  }
  async function proof(): Promise<RecordProof> {
    const server = await call(
      'POST',
      '/api/v1/servers',
      { name: 'task10', os: 'linux', environment: 'task10' },
      'user',
    );
    expect(server.status).toBe(201);
    const agent = await call(
      'POST',
      `/api/v1/servers/${server.body.id}/agents`,
      {},
      'user',
    );
    expect(agent.status).toBe(201);
    const db = await admin();
    const id = randomUUID();
    try {
      await db.query(
        "INSERT INTO management.api_credentials(id,agent_id,public_prefix,secret_hash,scopes,expires_at,issuance_request_id,created_by) VALUES($1,$2,'test',decode(repeat('00',32),'hex'),ARRAY['metrics:write'],clock_timestamp()+interval '1 day',$3,$4)",
        [
          id,
          agent.body.id,
          randomUUID(),
          JSON.stringify({
            kind: 'user',
            issuer: 'fixture',
            subject: 'fixture',
          }),
        ],
      );
    } finally {
      await db.end();
    }
    return {
      agent_id: agent.body.id,
      server_id: server.body.id,
      credential_id: id,
      last_success_at: await timestamp(),
    };
  }
  async function chunks(
    epoch: number,
    sequence: number,
    records: RecordProof[],
    count = 1,
    extra = {},
  ) {
    // Valid fixture evidence uses the real DB clock, not a host/VM clock race
    // immediately after epoch activation. Production clock validation is unchanged.
    const end = await timestamp();
    const logical = {
      epoch,
      sequence,
      snapshot_start: end,
      snapshot_end: end,
      gap: false,
      records: [...records].sort((a, b) =>
        a.agent_id.localeCompare(b.agent_id),
      ),
      ...extra,
    };
    const groups = Array.from({ length: count }, (_, i) =>
      records.filter((_, j) => j % count === i),
    );
    return groups.map((records, chunk_index) => ({
      ...logical,
      records,
      chunk_index,
      chunk_count: count,
      snapshot_hash: hash(logical),
      chunk_hash: hash(records),
    }));
  }
  async function state() {
    const db = await admin();
    try {
      return (
        await db.query(
          'SELECT * FROM management.gateway_epochs WHERE gateway_id=$1 ORDER BY epoch DESC LIMIT 1',
          [gateway],
        )
      ).rows[0];
    } finally {
      await db.end();
    }
  }
  async function sql(query: string, args: unknown[] = []) {
    const db = await admin();
    try {
      return await db.query(query, args);
    } finally {
      await db.end();
    }
  }
  it('server assigns epoch CAS; current boot retry stable; stale/retired boots never reactivate', async () => {
    const current = await call('GET', EPOCH);
    expect(current.status).toBe(200);
    expect(current.body.epoch).toBe(0);
    const boot = {
      boot_id: randomUUID(),
      boot_started_at: new Date().toISOString(),
      expected_epoch: 0,
    };
    const first = await call('POST', EPOCH, boot);
    expect(first.status).toBe(200);
    expect(first.body.epoch).toBe(1);
    expect((await call('POST', EPOCH, boot)).body).toEqual(first.body);
    const next = {
      ...boot,
      boot_id: randomUUID(),
      boot_started_at: new Date().toISOString(),
    };
    expect((await call('POST', EPOCH, next)).status).toBe(409);
    expect(
      (await call('POST', EPOCH, { ...next, expected_epoch: 1 })).body.epoch,
    ).toBe(2);
    expect(
      (await call('POST', EPOCH, { ...boot, expected_epoch: 2 })).status,
    ).toBe(409);
    expect(
      (await call('POST', REPORT, (await chunks(1, 1, []))[0])).status,
    ).toBe(409);
  });
  it('recovers a delayed truthful first boot without changing its UUID/start or backfilling activation coverage', async () => {
    const boot = {
      boot_id: randomUUID(),
      boot_started_at: new Date(
        new Date(await timestamp()).getTime() - 20000,
      ).toISOString(),
      expected_epoch: 0,
    };
    const first = await call('POST', EPOCH, boot);
    expect(first.status).toBe(200);
    expect(first.body.boot_id).toBe(boot.boot_id);
    const activated = await state();
    expect(activated.boot_started_at.toISOString()).toBe(boot.boot_started_at);
    expect(
      activated.activated_at.getTime() - activated.boot_started_at.getTime(),
    ).toBeGreaterThan(5000);
    expect((await call('POST', EPOCH, boot)).body).toEqual(first.body);
    expect(
      (await call('POST', EPOCH, {
        ...boot,
        boot_started_at: new Date(
          new Date(boot.boot_started_at).getTime() + 1,
        ).toISOString(),
      })).status,
    ).toBe(409);
    const snapshot = (await chunks(1, 1, [], 1, {
      snapshot_start: boot.boot_started_at,
    }))[0];
    expect((await call('POST', REPORT, snapshot)).status).toBe(200);
    const completed = await state();
    expect(completed.coverage_start.getTime()).toBeGreaterThanOrEqual(
      activated.activated_at.getTime(),
    );
    expect(completed.coverage_start).toEqual(completed.snapshot_end);
    const later = {
      ...boot,
      boot_id: randomUUID(),
      boot_started_at: new Date(
        new Date(boot.boot_started_at).getTime() + 1000,
      ).toISOString(),
      expected_epoch: 1,
    };
    expect((await call('POST', EPOCH, later)).body.epoch).toBe(2);
    expect(
      (await call('POST', EPOCH, { ...boot, expected_epoch: 2 })).status,
    ).toBe(409);
    expect((await state()).boot_id).toBe(later.boot_id);
  });
  it.each([-1000, 0])(
    'rejects an unseen older/equal boot offset%s despite matching current CAS',
    async (offset) => {
      await open();
      const current = await state();
      const boot = {
        boot_id: randomUUID(),
        boot_started_at: new Date(
          current.boot_started_at.getTime() + offset,
        ).toISOString(),
        expected_epoch: 1,
      };
      expect((await call('POST', EPOCH, boot)).status).toBe(409);
      const unchanged = await state();
      expect(unchanged.epoch).toBe('1');
      expect(unchanged.boot_id).toBe(current.boot_id);
      expect(unchanged.activated_at).toEqual(current.activated_at);
    },
  );
  it('competing CAS registrations have exactly one winner', async () => {
    const replies = await Promise.all(
      [1, 2].map(() =>
        call('POST', EPOCH, {
          boot_id: randomUUID(),
          boot_started_at: new Date().toISOString(),
          expected_epoch: 0,
        }),
      ),
    );
    expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await state()).epoch).toBe('1');
  });
  it('rejects future clock skew, unknown fields, query selectors and non-service principal', async () => {
    expect(
      (
        await call('POST', EPOCH, {
          boot_id: randomUUID(),
          boot_started_at: new Date(
            new Date(await timestamp()).getTime() + 10000,
          ).toISOString(),
          expected_epoch: 0,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('POST', EPOCH, {
          boot_id: randomUUID(),
          boot_started_at: new Date().toISOString(),
          expected_epoch: 0,
          gateway_id: gateway,
        })
      ).status,
    ).toBe(400);
    expect((await call('GET', EPOCH + '?gateway_id=' + gateway)).status).toBe(
      400,
    );
    expect((await call('GET', EPOCH, undefined, 'user')).status).toBe(403);
  });
  it('out-of-order chunks stage atomically; exact committed replay never refreshes heartbeat', async () => {
    const e = await open();
    const p = await proof();
    const c = await chunks(e.epoch, 1, [p], 2);
    const staged = await call('POST', REPORT, c[1]);
    expect(staged.status).toBe(200);
    expect(staged.body).toMatchObject({
      state: 'staged',
      accepted_chunk_indexes: [1],
    });
    let s = await state();
    expect(s.received_at).toBeNull();
    expect(
      (
        await sql(
          'SELECT last_metric_seen_at FROM management.agents WHERE id=$1',
          [p.agent_id],
        )
      ).rows[0].last_metric_seen_at,
    ).toBeNull();
    expect((await call('POST', REPORT, c[1])).body).toEqual(staged.body);
    const done = await call('POST', REPORT, c[0]);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({
      state: 'committed',
      accepted_chunk_indexes: [0, 1],
    });
    s = await state();
    expect(s.pending_sequence).toBeNull();
    expect(s.last_sequence).toBe('1');
    const heartbeat = s.received_at;
    expect((await call('POST', REPORT, c[0])).body.state).toBe('committed');
    expect((await state()).received_at).toEqual(heartbeat);
    // Controller ruling: committed replay acknowledges the logical digest only,
    // not reconstruction/acceptance of historical transport manifest bytes.
    expect(
      (await call('POST', REPORT, { ...c[0], chunk_count: 1 })).body,
    ).toMatchObject({ state: 'committed', accepted_chunk_indexes: [0] });
    expect(
      (await call('POST', REPORT, { ...c[0], snapshot_hash: '0'.repeat(64) }))
        .status,
    ).toBe(409);
    expect(
      (await call('POST', REPORT, { ...c[0], chunk_hash: '0'.repeat(64) }))
        .status,
    ).toBe(409);
    expect(await state()).toEqual(s);
    const agent = await call(
      'GET',
      `/api/v1/agents/${p.agent_id}`,
      undefined,
      'user',
    );
    expect(agent.body.telemetry).toMatchObject({
      status: 'Online',
      status_as_of: c[0].snapshot_end,
    });
    const server = await call(
      'GET',
      `/api/v1/servers/${p.server_id}`,
      undefined,
      'user',
    );
    expect(server.body.telemetry.status).toBe('Online');
  });
  it('normal staging keeps last completed coverage and heartbeat; expired pending breaks confidence', async () => {
    const e = await open();
    expect(
      (await call('POST', REPORT, (await chunks(e.epoch, 1, []))[0])).status,
    ).toBe(200);
    const before = await state();
    const c = await chunks(e.epoch, 2, [], 2);
    expect((await call('POST', REPORT, c[0])).body.state).toBe('staged');
    const staged = await state();
    for (const k of ['received_at', 'coverage_start', 'coverage_end', 'gap'])
      expect(staged[k]).toEqual(before[k]);
    await sql(
      "UPDATE management.gateway_epochs SET pending_deadline=clock_timestamp()-interval '1 second' WHERE gateway_id=$1",
      [gateway],
    );
    expect((await call('POST', REPORT, c[1])).status).toBe(409);
    const expired = await state();
    expect(expired.gap).toBe(true);
    expect(expired.coverage_start).toBeNull();
    expect(expired.received_at).toEqual(before.received_at);
  });
  it('persists staged data across app restart then finalizes exactly once', async () => {
    const e = await open();
    const c = await chunks(e.epoch, 1, [], 2);
    expect((await call('POST', REPORT, c[1])).body.state).toBe('staged');
    await app.close();
    await start();
    expect((await call('POST', REPORT, c[0])).body.state).toBe('committed');
    expect((await state()).last_sequence).toBe('1');
  });
  it('tamper and changed manifest reject409, clear bounded pending and invalidate coverage', async () => {
    const e = await open();
    const c = await chunks(e.epoch, 1, [], 2);
    expect((await call('POST', REPORT, c[0])).status).toBe(200);
    expect((await call('POST', REPORT, { ...c[1], gap: true })).status).toBe(
      409,
    );
    const s = await state();
    expect(s.pending_sequence).toBeNull();
    expect(s.gap).toBe(true);
    expect(
      (
        await call('POST', REPORT, {
          ...(await chunks(e.epoch, 2, []))[0],
          snapshot_hash: '0'.repeat(64),
        })
      ).status,
    ).toBe(409);
  });
  it('validates whole manifest before any Agent update; duplicate Agent or cross-owner proof rejected', async () => {
    const e = await open();
    const a = await proof();
    const b = await proof();
    expect(
      (await call('POST', REPORT, (await chunks(e.epoch, 1, [a, a]))[0]))
        .status,
    ).toBe(400);
    expect(
      (
        await call(
          'POST',
          REPORT,
          (
            await chunks(e.epoch, 2, [
              a,
              { ...b, credential_id: a.credential_id },
            ])
          )[0],
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await sql(
          'SELECT last_metric_seen_at FROM management.agents WHERE id=ANY($1::uuid[])',
          [[a.agent_id, b.agent_id]],
        )
      ).rows.every((r) => r.last_metric_seen_at === null),
    ).toBe(true);
    expect((await state()).last_sequence).toBe('0');
  });
  it('enforces end freshness/boot/observation future and ten-minute limits without timestamp substitution', async () => {
    const e = await open();
    const p = await proof();
    for (const t of [
      new Date(Date.now() + 6000).toISOString(),
      new Date(Date.now() - 601000).toISOString(),
    ])
      expect(
        (
          await call(
            'POST',
            REPORT,
            (await chunks(e.epoch, 1, [{ ...p, last_success_at: t }]))[0],
          )
        ).status,
      ).toBe(400);
    const old = new Date(Date.now() - 31000).toISOString();
    expect(
      (
        await call(
          'POST',
          REPORT,
          (
            await chunks(e.epoch, 1, [], 1, {
              snapshot_start: old,
              snapshot_end: old,
            })
          )[0],
        )
      ).status,
    ).toBe(400);
    expect((await state()).received_at).toBeNull();
  });
  it('historical disabled/retired evidence preserves lifecycle and does not make replacement Online', async () => {
    const e = await open();
    const p = await proof();
    expect(
      (await call('POST', `/api/v1/agents/${p.agent_id}/retire`, {}, 'user'))
        .status,
    ).toBe(201);
    expect(
      (await call('POST', REPORT, (await chunks(e.epoch, 1, [p]))[0])).status,
    ).toBe(200);
    const old = await call(
      'GET',
      `/api/v1/agents/${p.agent_id}`,
      undefined,
      'user',
    );
    expect(old.body.lifecycle).toBe('retired');
    expect(old.body.telemetry).toMatchObject({
      status: 'Unknown',
      confidence_reason: 'lifecycle_inactive',
      last_metric_seen_at: p.last_success_at,
    });
    const next = await call(
      'POST',
      `/api/v1/servers/${p.server_id}/agents`,
      {},
      'user',
    );
    expect(next.status).toBe(201);
    expect(
      (await call('GET', `/api/v1/servers/${p.server_id}`, undefined, 'user'))
        .body.telemetry,
    ).toMatchObject({ status: 'Unknown', confidence_reason: 'never_seen' });
  });
  it('projects real completed-source coverage, normal pending, expiry and stale heartbeat on bounded inventory reads', async () => {
    await open();
    const p = await proof();
    const times = await sql(
      "UPDATE management.gateway_epochs SET boot_started_at=clock_timestamp()-interval '600 seconds',activated_at=clock_timestamp()-interval '599 seconds',snapshot_start=clock_timestamp()-interval '400 seconds',snapshot_end=clock_timestamp()-interval '2 seconds',received_at=clock_timestamp()-interval '1 second',coverage_start=clock_timestamp()-interval '400 seconds',coverage_end=clock_timestamp()-interval '2 seconds',gap=false WHERE gateway_id=$1 RETURNING snapshot_end",
      [gateway],
    );
    const end = times.rows[0].snapshot_end;
    await sql(
      "UPDATE management.agents SET last_metric_seen_at=$2::timestamptz-interval '301 seconds' WHERE id=$1",
      [p.agent_id, end],
    );
    const path = `/api/v1/agents/${p.agent_id}`;
    expect(
      (await call('GET', path, undefined, 'user')).body.telemetry,
    ).toMatchObject({ status: 'Offline', status_as_of: end.toISOString() });
    const staged = await chunks(1, 1, [], 2);
    expect((await call('POST', REPORT, staged[0])).body.state).toBe('staged');
    expect(
      (await call('GET', path, undefined, 'user')).body.telemetry.status,
    ).toBe('Offline');
    const list = await call(
      'GET',
      `/api/v1/servers?environment=task10&limit=100`,
      undefined,
      'user',
    );
    expect(list.status).toBe(200);
    expect(
      list.body.items.find((s: { id: string }) => s.id === p.server_id)
        .telemetry.status,
    ).toBe('Offline');
    await sql(
      "UPDATE management.gateway_epochs SET pending_deadline=clock_timestamp()-interval '1 second' WHERE gateway_id=$1",
      [gateway],
    );
    expect(
      (await call('GET', path, undefined, 'user')).body.telemetry,
    ).toMatchObject({
      status: 'Unknown',
      source_health: 'gap',
      confidence_reason: 'coverage_gap',
    });
    await sql(
      "UPDATE management.gateway_epochs SET received_at=clock_timestamp()-interval '31 seconds' WHERE gateway_id=$1",
      [gateway],
    );
    expect(
      (await call('GET', path, undefined, 'user')).body.telemetry,
    ).toMatchObject({ status: 'Unknown', source_health: 'stale' });
  });
  it('cannot backfill missing-sequence coverage by claiming an old snapshot start', async () => {
    await open();
    const p = await proof();
    const seeded = await sql(
      "UPDATE management.gateway_epochs SET boot_started_at=clock_timestamp()-interval '600 seconds',activated_at=clock_timestamp()-interval '599 seconds' WHERE gateway_id=$1 RETURNING boot_started_at",
      [gateway],
    );
    await sql(
      "UPDATE management.agents SET last_metric_seen_at=clock_timestamp()-interval '400 seconds' WHERE id=$1",
      [p.agent_id],
    );
    const c = await chunks(1, 3, [], 1, {
      snapshot_start: seeded.rows[0].boot_started_at.toISOString(),
    });
    expect((await call('POST', REPORT, c[0])).status).toBe(200);
    const s = await state();
    expect(s.coverage_start).toEqual(s.snapshot_end);
    expect(
      (await call('GET', `/api/v1/agents/${p.agent_id}`, undefined, 'user'))
        .body.telemetry.status,
    ).toBe('Unknown');
  });
  it('documents explicit200 internal contracts and typed honest nested telemetry', async () => {
    const { managementOpenApi } = await import('../../src/common/openapi.js');
    const doc = managementOpenApi(app);
    expect(doc.paths[EPOCH].post!.responses['200']).toBeDefined();
    expect(doc.paths[REPORT].post!.responses['200']).toBeDefined();
    expect(doc.paths[REPORT].post!.security).toEqual([
      { InternalServiceAssertion: [] },
    ]);
    expect(doc.components!.schemas!.StatusDto).toMatchObject({
      properties: {
        status: { enum: ['Online', 'Stale', 'Offline', 'Unknown'] },
        status_as_of: { type: 'string', format: 'date-time', nullable: true },
        last_metric_seen_at: {
          type: 'string',
          format: 'date-time',
          nullable: true,
        },
      },
    });
    expect(doc.components!.schemas!.ReportChunkDto).toMatchObject({
      additionalProperties: false,
      properties: { records: { maxItems: 256 } },
    });
  });
  it('rejects noncanonical/unseeded configured sources without runtime registry creation', async () => {
    await app.close();
    gateway = randomUUID();
    await start();
    expect((await call('GET', EPOCH)).status).toBe(403);
    await app.close();
    gateway = 'gateway-opaque';
    await start();
    expect((await call('GET', EPOCH)).status).toBe(403);
  });
  it('retains positive success between boot and activation without inventing earlier coverage', async () => {
    const e = await open();
    const p = await proof();
    const s = await state();
    await sql(
      "UPDATE management.gateway_epochs SET boot_started_at=activated_at-interval '2 seconds' WHERE gateway_id=$1",
      [gateway],
    );
    const seen = new Date(s.activated_at.getTime() - 1000).toISOString();
    const c = await chunks(e.epoch, 1, [{ ...p, last_success_at: seen }], 1, {
      snapshot_start: new Date(s.activated_at.getTime() - 2000).toISOString(),
    });
    expect((await call('POST', REPORT, c[0])).status).toBe(200);
    const completed = await state();
    expect(completed.coverage_start.getTime()).toBeGreaterThanOrEqual(
      s.activated_at.getTime(),
    );
    expect(completed.coverage_start).toEqual(completed.snapshot_end);
    expect(
      (await call('GET', `/api/v1/agents/${p.agent_id}`, undefined, 'user'))
        .body.telemetry.status,
    ).toBe('Online');
  });
  it('keeps GREATEST historical timestamps and rejects invalid DB-staged hashes after restart', async () => {
    const e = await open();
    const p = await proof();
    expect(
      (await call('POST', REPORT, (await chunks(e.epoch, 1, [p]))[0])).status,
    ).toBe(200);
    const prior = await state();
    const c = await chunks(e.epoch, 2, [], 2);
    expect((await call('POST', REPORT, c[0])).status).toBe(200);
    await sql(
      "UPDATE management.gateway_epochs SET pending_chunk_hashes=jsonb_build_object('0',repeat('0',64)) WHERE gateway_id=$1",
      [gateway],
    );
    await app.close();
    await start();
    expect((await call('POST', REPORT, c[1])).status).toBe(409);
    expect((await state()).received_at).toEqual(prior.received_at);
    expect((await state()).coverage_start).toBeNull();
    const older = new Date(
      new Date(p.last_success_at).getTime() - 1,
    ).toISOString();
    expect(
      (
        await call(
          'POST',
          REPORT,
          (await chunks(e.epoch, 3, [{ ...p, last_success_at: older }]))[0],
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await sql(
          'SELECT last_metric_seen_at FROM management.agents WHERE id=$1',
          [p.agent_id],
        )
      ).rows[0].last_metric_seen_at.toISOString(),
    ).toBe(p.last_success_at);
  });
  it('commits the supported 4x256 maximum within the bounded transaction and rejects257 before staging', async () => {
    const e = await open();
    const p = await proof();
    const records = Array.from({ length: 1024 }, () => ({
      ...p,
      agent_id: randomUUID(),
      credential_id: randomUUID(),
      last_success_at: p.last_success_at,
    }));
    const data = JSON.stringify(records);
    await sql(
      "INSERT INTO management.agents(id,server_id,os_at_registration,agent_type,lifecycle,registered_at) SELECT agent_id,server_id,'linux','telegraf','disabled',clock_timestamp() FROM jsonb_to_recordset($1::jsonb) AS x(agent_id uuid,server_id uuid)",
      [data],
    );
    await sql(
      "INSERT INTO management.api_credentials(id,agent_id,public_prefix,secret_hash,scopes,expires_at,issuance_request_id,created_by) SELECT credential_id,agent_id,'test',decode(repeat('00',32),'hex'),ARRAY['metrics:write'],clock_timestamp()+interval '1 day',credential_id,'{}'::jsonb FROM jsonb_to_recordset($1::jsonb) AS x(agent_id uuid,credential_id uuid)",
      [data],
    );
    const cs = await chunks(e.epoch, 1, records, 4);
    for (let i = 3; i >= 0; i--) {
      expect(Buffer.byteLength(JSON.stringify(cs[i]))).toBeLessThanOrEqual(
        65536,
      );
      const r = await call('POST', REPORT, cs[i]);
      expect(r.status).toBe(200);
      expect(r.body.state).toBe(i === 0 ? 'committed' : 'staged');
    }
    expect(
      (
        await sql(
          'SELECT count(*)::int AS n FROM management.agents WHERE server_id=$1 AND last_metric_seen_at IS NOT NULL',
          [p.server_id],
        )
      ).rows[0].n,
    ).toBe(1024);
    const bad = { ...(await chunks(e.epoch, 2, records.slice(0, 257), 1))[0] };
    expect((await call('POST', REPORT, bad)).status).toBe(400);
    expect((await state()).pending_sequence).toBeNull();
  });
  it('bounds chunk count/record count and stores at most one sequence; loss resets coverage', async () => {
    const e = await open();
    expect(
      (
        await call('POST', REPORT, {
          ...(await chunks(e.epoch, 1, []))[0],
          chunk_count: 5,
        })
      ).status,
    ).toBe(400);
    const c = await chunks(e.epoch, 1, [], 2);
    expect((await call('POST', REPORT, c[0])).status).toBe(200);
    const next = await chunks(e.epoch, 3, [], 2);
    expect((await call('POST', REPORT, next[1])).status).toBe(200);
    const s = await state();
    expect(s.pending_sequence).toBe('3');
    expect(s.gap).toBe(true);
    expect(s.coverage_start).toBeNull();
    expect((await call('POST', REPORT, next[0])).body.state).toBe('committed');
    expect((await state()).last_sequence).toBe('3');
  });
});
