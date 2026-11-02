import request from 'supertest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  Controller,
  Get,
  Param,
  Req,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { AgentScope } from '../../src/auth/policies.js';
import {
  AGENT_AUTHENTICATOR,
  type AgentAuthenticatorPort,
  type AgentPrincipal,
} from '../../src/auth/principal.js';
import { ApiError } from '../../src/common/errors.js';
import { installHttpBoundary } from '../../src/common/http-boundary.js';
import { signedFixture } from '../support/keys.js';
import { countLeaks } from '../support/config.js';
import { identity, admin } from '../support/db.js';
import { readTestUrl } from '../support/pg-harness.js';

// Isolated test controller, NEVER registered in runtime. Proves T3 global guard resolves
// the real Task5 DI provider and derives identity/scope instead of trusting the route.
@Controller('_task5/own-agents')
class OwnAgentProbe {
  @Get(':id')
  @AgentScope('provisioning:read')
  read(@Param('id') id: string, @Req() req: { principal: AgentPrincipal }) {
    if (req.principal.agent_id !== id) throw new ApiError('forbidden');
    return req.principal;
  }
}

describe('Task5 primary DB credential lifecycle', () => {
  let app: INestApplication;
  let fixture: ReturnType<typeof signedFixture>;
  beforeEach(async () => {
    fixture = signedFixture();
    const config = {
      ...fixture.config,
      databaseUrl: readTestUrl(identity().runtimeFile),
    };
    const module = await Test.createTestingModule({
      imports: [AppModule.register(config)],
      controllers: [OwnAgentProbe],
    }).compile();
    app = module.createNestApplication({ bodyParser: false, logger: false });
    installHttpBoundary(app, config);
    await app.init();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    fixture.cleanup();
  });
  async function call(
    method: string,
    target: string,
    payload?: unknown,
    role = 'Admin',
    kind: 'user' | 'service' = 'user',
  ) {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const token = await fixture.sign({ method, target, body, role, kind });
    const client = request(app.getHttpServer());
    const req =
      method === 'GET'
        ? client.get(target)
        : method === 'DELETE'
          ? client.delete(target)
          : client.post(target);
    req.set('Authorization', `Bearer ${token}`);
    if (body) req.set('Content-Type', 'application/json').send(body);
    return req;
  }
  async function agent() {
    const server = await call('POST', '/api/v1/servers', {
      name: 'credential',
      os: 'linux',
      environment: randomUUID(),
    });
    expect(server.status).toBe(201);
    const agent = await call(
      'POST',
      `/api/v1/servers/${server.body.id}/agents`,
      {},
    );
    expect(agent.status).toBe(201);
    return {
      serverId: server.body.id as string,
      agentId: agent.body.id as string,
    };
  }
  async function issue(agentId: string, options: Record<string, unknown> = {}) {
    const response = await call(
      'POST',
      `/api/v1/agents/${agentId}/credentials`,
      { issuance_request_id: randomUUID(), ...options },
    );
    expect(response.status).toBe(201);
    return response;
  }
  async function verify(api_key: string) {
    return call(
      'POST',
      '/internal/v1/credentials/verify',
      { api_key },
      'Admin',
      'service',
    );
  }
  async function inactive(api_key: string) {
    const response = await verify(api_key);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ active: false });
  }
  it('commits once even when the first secret response is discarded; retry conflicts with safe metadata and recovery', async () => {
    const { agentId } = await agent();
    const issuance_request_id = randomUUID();
    // Deliberately discard the committed response (including secret) before retrying.
    const firstStatus = (
      await call('POST', `/api/v1/agents/${agentId}/credentials`, {
        issuance_request_id,
      })
    ).status;
    expect(firstStatus).toBe(201);
    const retry = await call('POST', `/api/v1/agents/${agentId}/credentials`, {
      issuance_request_id,
    });
    expect(retry.status).toBe(409);
    expect(retry.body.code).toBe('secret_already_issued');
    expect(retry.body.credential.issuance_request_id).toBe(issuance_request_id);
    expect(/api_key|secret_hash/.test(JSON.stringify(retry.body))).toBe(false);
    const db = await admin();
    try {
      const count = await db.query(
        'SELECT count(*)::int AS n FROM management.api_credentials WHERE issuance_request_id=$1',
        [issuance_request_id],
      );
      expect(count.rows[0].n).toBe(1);
      expect(
        (await call('GET', `/api/v1/credentials/${retry.body.credential.id}`))
          .status,
      ).toBe(200);
      expect(
        (
          await call(
            'POST',
            `/api/v1/credentials/${retry.body.credential.id}/revoke`,
            {},
          )
        ).status,
      ).toBe(204);
      const replacement = await issue(agentId);
      expect(replacement.body.id !== retry.body.credential.id).toBe(true);
    } finally {
      await db.end();
    }
  });
  it('globally deduplicates concurrent issuance UUID across different Agent locks and operation kinds', async () => {
    const a = await agent(),
      b = await agent();
    const issuance_request_id = randomUUID();
    const results = await Promise.all(
      [a, b].map(({ agentId }) =>
        call('POST', `/api/v1/agents/${agentId}/credentials`, {
          issuance_request_id,
        }),
      ),
    );
    expect(results.map((x) => x.status).sort()).toEqual([201, 409]);
    const winner = results.find((x) => x.status === 201)!;
    const loser = results.find((x) => x.status === 409)!;
    expect(loser.body.credential.id).toBe(winner.body.id);
    expect(countLeaks(JSON.stringify(loser.body), [winner.body.api_key])).toBe(
      0,
    );
    const rotate = await call(
      'POST',
      `/api/v1/credentials/${winner.body.id}/rotate`,
      { issuance_request_id },
    );
    expect(rotate.status).toBe(409);
    expect(rotate.body.credential.id).toBe(winner.body.id);
    const db = await admin();
    try {
      expect(
        (
          await db.query(
            'SELECT count(*)::int AS n FROM management.api_credentials WHERE issuance_request_id=$1',
            [issuance_request_id],
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      await db.end();
    }
  });
  it('stores exactly SHA256(decoded32bytes), defaults expiry/scopes, projects metadata and never persists/logs plaintext', async () => {
    const { agentId, serverId } = await agent();
    const issued = await issue(agentId);
    expect(issued.headers['cache-control']).toBe('no-store');
    const key: string = issued.body.api_key,
      secret = key.split('.')[1]!;
    expect(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(key)).toBe(true);
    const proof = await verify(key);
    expect(proof.status).toBe(200);
    expect(proof.body).toEqual({
      active: true,
      credential_id: issued.body.id,
      agent_id: agentId,
      server_id: serverId,
      scopes: ['metrics:write', 'provisioning:read', 'config:report'],
      expires_at: issued.body.expires_at,
      cache_ttl_ms: 30000,
    });
    expect(proof.headers['cache-control']).toBe('no-store');
    const db = await admin();
    try {
      const row = (
        await db.query(
          'SELECT *, (extract(epoch FROM (expires_at-created_at))*1000)::bigint AS duration FROM management.api_credentials WHERE id=$1',
          [issued.body.id],
        )
      ).rows[0];
      expect(row.secret_hash.length).toBe(32);
      expect(
        Buffer.from(row.secret_hash).equals(
          createHash('sha256')
            .update(Buffer.from(secret, 'base64url'))
            .digest(),
        ),
      ).toBe(true);
      expect(Number(row.duration)).toBe(30 * 86400000);
      expect(row.public_prefix === issued.body.id.slice(0, 8)).toBe(true);
      const metadata = await call(
        'GET',
        `/api/v1/credentials/${issued.body.id}`,
      );
      const list = await call('GET', `/api/v1/credentials?agent=${agentId}`);
      const audit = await call(
        'GET',
        `/api/v1/audit-logs?resource_type=credential&resource_id=${issued.body.id}`,
      );
      expect(list.body.items.map((x: { id: string }) => x.id)).toEqual([
        issued.body.id,
      ]);
      const surfaces = JSON.stringify([
        metadata.body,
        list.body,
        audit.body,
        proof.body,
      ]);
      expect(
        countLeaks(surfaces, [
          key,
          secret,
          row.secret_hash.toString('hex'),
          row.secret_hash.toString('base64'),
        ]),
      ).toBe(0);
      expect(/secret_hash|api_key/.test(surfaces)).toBe(false);
      expect(countLeaks(JSON.stringify(row), [key, secret])).toBe(0);
      expect(
        audit.body.items.map((x: { operation: string }) => x.operation),
      ).toEqual(['issue']);
    } finally {
      await db.end();
    }
  });
  it('makes malformed, same-ID wrong-secret, unknown-ID, missing-scope and stale proofs indistinguishable', async () => {
    const { agentId } = await agent();
    const issued = await issue(agentId);
    const wrong = `${issued.body.id}.${randomBytes(32).toString('base64url')}`;
    for (const value of [
      '',
      'not-a-key',
      `${issued.body.api_key} `,
      wrong,
      `${randomUUID()}.${randomBytes(32).toString('base64url')}`,
    ])
      await inactive(value);
    const limited = await issue(agentId, { scopes: ['config:report'] });
    await inactive(limited.body.api_key);
    const db = await admin();
    try {
      await db.query(
        "UPDATE management.api_credentials SET created_at=clock_timestamp()-interval '401 days',expires_at=clock_timestamp()-interval '400 days' WHERE id=$1",
        [issued.body.id],
      );
      await inactive(issued.body.api_key);
    } finally {
      await db.end();
    }
  });
  it('independently enforces owner lifecycle/archive even for nonrevoked rows left by an administrative fixture', async () => {
    const { agentId, serverId } = await agent();
    const issued = await issue(agentId);
    const db = await admin();
    try {
      await db.query(
        "UPDATE management.agents SET lifecycle='disabled' WHERE id=$1",
        [agentId],
      );
      await inactive(issued.body.api_key);
      await db.query(
        "UPDATE management.agents SET lifecycle='active' WHERE id=$1",
        [agentId],
      );
      await db.query(
        'UPDATE management.servers SET archived_at=clock_timestamp() WHERE id=$1',
        [serverId],
      );
      await inactive(issued.body.api_key);
      expect(
        (
          await call('POST', `/api/v1/agents/${agentId}/credentials`, {
            issuance_request_id: randomUUID(),
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await call('POST', `/api/v1/credentials/${issued.body.id}/rotate`, {
            issuance_request_id: randomUUID(),
          })
        ).status,
      ).toBe(409);
    } finally {
      await db.end();
    }
  });
  it('floors DB-snapshot TTL, respects effective expiry/retirement equality, and never positive-caches', async () => {
    const { agentId } = await agent();
    const issued = await issue(agentId);
    const db = await admin();
    try {
      const before = (
        await db.query(
          "UPDATE management.api_credentials SET retire_at=clock_timestamp()+interval '1234.9 milliseconds' WHERE id=$1 RETURNING floor(extract(epoch FROM (retire_at-clock_timestamp()))*1000)::int AS ttl,retire_at",
          [issued.body.id],
        )
      ).rows[0];
      const proof = await verify(issued.body.api_key);
      expect(proof.body.active).toBe(true);
      expect(Number.isInteger(proof.body.cache_ttl_ms)).toBe(true);
      expect(
        proof.body.cache_ttl_ms >= 1 && proof.body.cache_ttl_ms <= before.ttl,
      ).toBe(true);
      expect(proof.body.expires_at).toBe(before.retire_at.toISOString());
      await db.query(
        'UPDATE management.api_credentials SET retire_at=clock_timestamp() WHERE id=$1',
        [issued.body.id],
      );
      await inactive(issued.body.api_key);
      await db.query(
        "UPDATE management.api_credentials SET retire_at=NULL,expires_at=clock_timestamp()+interval '1 day' WHERE id=$1",
        [issued.body.id],
      );
      expect((await verify(issued.body.api_key)).body.active).toBe(true);
      await db.query(
        'UPDATE management.api_credentials SET expires_at=clock_timestamp() WHERE id=$1',
        [issued.body.id],
      );
      await inactive(issued.body.api_key);
    } finally {
      await db.end();
    }
  });
  it('rotates one same-Agent successor in a real race, commits once despite discarded response, and preserves overlap/expiry', async () => {
    const { agentId } = await agent();
    const old = await issue(agentId);
    const issuance_request_id = randomUUID();
    // First committed rotation response is intentionally discarded.
    expect(
      (
        await call('POST', `/api/v1/credentials/${old.body.id}/rotate`, {
          issuance_request_id,
        })
      ).status,
    ).toBe(201);
    const retry = await call(
      'POST',
      `/api/v1/credentials/${old.body.id}/rotate`,
      { issuance_request_id },
    );
    expect(retry.status).toBe(409);
    expect(retry.body.credential.agent_id).toBe(agentId);
    expect(/api_key|secret_hash/.test(JSON.stringify(retry.body))).toBe(false);
    const db = await admin();
    try {
      const row = (
        await db.query(
          'SELECT c.*,extract(epoch FROM (o.retire_at-c.created_at))::int AS overlap FROM management.api_credentials c JOIN management.api_credentials o ON o.id=c.rotated_from_id WHERE o.id=$1',
          [old.body.id],
        )
      ).rows[0];
      expect(row.agent_id).toBe(agentId);
      expect(row.overlap).toBe(300);
      const metadata = await call('GET', `/api/v1/credentials/${old.body.id}`);
      expect(metadata.body.status).toBe('rotating');
      expect(metadata.body.expires_at).toBe(old.body.expires_at);
      expect((await verify(old.body.api_key)).body.active).toBe(true);
      const again = await call(
        'POST',
        `/api/v1/credentials/${old.body.id}/rotate`,
        { issuance_request_id: randomUUID() },
      );
      expect(again.status).toBe(409);
      const other = await issue(agentId);
      const race = await Promise.all(
        [0, 1].map(() =>
          call('POST', `/api/v1/credentials/${other.body.id}/rotate`, {
            issuance_request_id: randomUUID(),
          }),
        ),
      );
      expect(race.map((x) => x.status).sort()).toEqual([201, 409]);
      const winner = race.find((x) => x.status === 201)!;
      expect(winner.body.agent_id).toBe(agentId);
      expect(winner.body.rotated_from_id).toBe(other.body.id);
      expect(
        (
          await db.query(
            'SELECT count(*)::int AS n FROM management.api_credentials WHERE rotated_from_id=$1',
            [other.body.id],
          )
        ).rows[0].n,
      ).toBe(1);
      await db.query(
        'UPDATE management.api_credentials SET retire_at=clock_timestamp() WHERE id=$1',
        [other.body.id],
      );
      await inactive(other.body.api_key);
      expect((await verify(winner.body.api_key)).body.active).toBe(true);
      // A preexisting earlier retirement and earlier expiry are never extended.
      const short = await issue(agentId);
      const cutoff = (
        await db.query(
          "UPDATE management.api_credentials SET retire_at=clock_timestamp()+interval '60 seconds',expires_at=clock_timestamp()+interval '30 seconds' WHERE id=$1 RETURNING retire_at,expires_at",
          [short.body.id],
        )
      ).rows[0];
      expect(
        (
          await call('POST', `/api/v1/credentials/${short.body.id}/rotate`, {
            issuance_request_id: randomUUID(),
          })
        ).status,
      ).toBe(201);
      const after = (
        await db.query(
          'SELECT retire_at,expires_at FROM management.api_credentials WHERE id=$1',
          [short.body.id],
        )
      ).rows[0];
      expect(after).toEqual(cutoff);
      expect((await verify(short.body.api_key)).body.expires_at).toBe(
        cutoff.expires_at.toISOString(),
      );
    } finally {
      await db.end();
    }
  });
  it('makes revoke idempotent and irreversible, leaves sibling valid, and disable/enable/retire/archive cannot revive keys', async () => {
    const { agentId } = await agent();
    const key = await issue(agentId),
      sibling = await issue(agentId);
    for (let i = 0; i < 2; i++)
      expect(
        (await call('POST', `/api/v1/credentials/${key.body.id}/revoke`, {}))
          .status,
      ).toBe(204);
    await inactive(key.body.api_key);
    expect((await verify(sibling.body.api_key)).body.active).toBe(true);
    expect(
      (
        await call('POST', `/api/v1/credentials/${key.body.id}/rotate`, {
          issuance_request_id: randomUUID(),
        })
      ).status,
    ).toBe(409);
    expect(
      (await call('POST', `/api/v1/agents/${agentId}/disable`, {})).status,
    ).toBe(201);
    await inactive(sibling.body.api_key);
    expect(
      (await call('POST', `/api/v1/agents/${agentId}/enable`, {})).status,
    ).toBe(201);
    await inactive(sibling.body.api_key);
    const fresh = await issue(agentId);
    expect(
      (await call('POST', `/api/v1/agents/${agentId}/retire`, {})).status,
    ).toBe(201);
    await inactive(fresh.body.api_key);
    expect(
      (
        await call('POST', `/api/v1/agents/${agentId}/credentials`, {
          issuance_request_id: randomUUID(),
        })
      ).status,
    ).toBe(409);
    const b = await agent(),
      archived = await issue(b.agentId);
    expect((await call('DELETE', `/api/v1/servers/${b.serverId}`)).status).toBe(
      204,
    );
    await inactive(archived.body.api_key);
    const db = await admin();
    try {
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM management.audit_logs WHERE resource_id=$1 AND operation='revoke'",
            [key.body.id],
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      await db.end();
    }
  });
  it.each(['disable', 'retire', 'archive'])(
    'serializes issue AND rotate against %s under the shared Server→Agent→credential locks',
    async (action) => {
      for (const writer of ['issue', 'rotate']) {
        const { agentId, serverId } = await agent();
        const old = await issue(agentId);
        const target =
          writer === 'issue'
            ? `/api/v1/agents/${agentId}/credentials`
            : `/api/v1/credentials/${old.body.id}/rotate`;
        const [mutation, lifecycle] = await Promise.all([
          call('POST', target, { issuance_request_id: randomUUID() }),
          action === 'archive'
            ? call('DELETE', `/api/v1/servers/${serverId}`)
            : call('POST', `/api/v1/agents/${agentId}/${action}`, {}),
        ]);
        expect([201, 409]).toContain(mutation.status);
        expect(lifecycle.status).toBe(action === 'archive' ? 204 : 201);
        const db = await admin();
        try {
          expect(
            (
              await db.query(
                'SELECT count(*)::int AS n FROM management.api_credentials WHERE agent_id=$1 AND revoked_at IS NULL',
                [agentId],
              )
            ).rows[0].n,
          ).toBe(0);
        } finally {
          await db.end();
        }
        await inactive(old.body.api_key);
        if (mutation.status === 201) await inactive(mutation.body.api_key);
        expect(
          (await call('POST', target, { issuance_request_id: randomUUID() }))
            .status,
        ).toBe(409);
      }
    },
  );
  it('rolls back real issue/rotate/revoke and their audit together on audit INSERT failure', async () => {
    const { agentId } = await agent();
    const old = await issue(agentId);
    const db = await admin();
    try {
      await db.query(
        'REVOKE INSERT ON management.audit_logs FROM management_runtime',
      );
      const issuance_request_id = randomUUID();
      const fresh = await call(
        'POST',
        `/api/v1/agents/${agentId}/credentials`,
        { issuance_request_id },
      );
      expect(fresh.status).toBe(503);
      expect(
        (
          await db.query(
            'SELECT count(*)::int AS n FROM management.api_credentials WHERE issuance_request_id=$1',
            [issuance_request_id],
          )
        ).rows[0].n,
      ).toBe(0);
      const rotate = await call(
        'POST',
        `/api/v1/credentials/${old.body.id}/rotate`,
        { issuance_request_id: randomUUID() },
      );
      expect(rotate.status).toBe(503);
      const revoke = await call(
        'POST',
        `/api/v1/credentials/${old.body.id}/revoke`,
        {},
      );
      expect(revoke.status).toBe(503);
      const row = (
        await db.query(
          'SELECT revoked_at,retire_at FROM management.api_credentials WHERE id=$1',
          [old.body.id],
        )
      ).rows[0];
      expect(row).toEqual({ revoked_at: null, retire_at: null });
      expect(
        (
          await db.query(
            'SELECT count(*)::int AS n FROM management.api_credentials WHERE rotated_from_id=$1',
            [old.body.id],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        countLeaks(JSON.stringify([fresh.body, rotate.body, revoke.body]), [
          old.body.api_key,
        ]),
      ).toBe(0);
      expect((await verify(old.body.api_key)).body.active).toBe(true);
    } finally {
      await db.query(
        'GRANT INSERT ON management.audit_logs TO management_runtime',
      );
      await db.end();
    }
  });
  it.each(['Viewer', 'Editor'])(
    '%s is denied actual credential metadata AND every mutation; service cannot become Admin',
    async (role) => {
      const { agentId } = await agent();
      const key = await issue(agentId);
      for (const [method, target, payload] of [
        ['GET', '/api/v1/credentials', undefined],
        ['GET', `/api/v1/credentials/${key.body.id}`, undefined],
        [
          'POST',
          `/api/v1/agents/${agentId}/credentials`,
          { issuance_request_id: randomUUID() },
        ],
        [
          'POST',
          `/api/v1/credentials/${key.body.id}/rotate`,
          { issuance_request_id: randomUUID() },
        ],
        ['POST', `/api/v1/credentials/${key.body.id}/revoke`, {}],
      ] as const) {
        expect((await call(method, target, payload, role)).status).toBe(403);
        expect(
          (await call(method, target, payload, 'Admin', 'service')).status,
        ).toBe(404);
      }
    },
  );
  it('rejects expiry/scope/operation mass assignment without persisting keys, using DB-owned30/365-day bounds', async () => {
    const { agentId } = await agent();
    const db = await admin();
    const now = (
      await db.query('SELECT clock_timestamp() AS now')
    ).rows[0].now.getTime();
    try {
      const bad = [
        {},
        { issuance_request_id: 'invalid' },
        { scopes: [] },
        { scopes: ['admin'] },
        { scopes: ['metrics:write', 'metrics:write'] },
        { scopes: null },
        { expires_at: new Date(now - 1000).toISOString() },
        { expires_at: new Date(now + 366 * 86400000).toISOString() },
        { expires_at: null },
        { expires_at: '2027-02-30T12:00:00Z' },
        { agent_id: randomUUID() },
        { secret_hash: 'forged' },
        { retire_at: new Date(now + 10000).toISOString() },
      ];
      for (const options of bad) {
        const input = Object.keys(options).length
          ? { issuance_request_id: randomUUID(), ...options }
          : {};
        expect(
          (await call('POST', `/api/v1/agents/${agentId}/credentials`, input))
            .status,
        ).toBe(400);
      }
      expect(
        (
          await db.query(
            'SELECT count(*)::int AS n FROM management.api_credentials WHERE agent_id=$1',
            [agentId],
          )
        ).rows[0].n,
      ).toBe(0);
      const max = await issue(agentId, {
        scopes: ['metrics:write'],
        expires_at: new Date(now + 365 * 86400000).toISOString(),
      });
      expect((await verify(max.body.api_key)).body.active).toBe(true);
      await db.query(
        'UPDATE management.api_credentials SET expires_at=clock_timestamp() WHERE id=$1',
        [max.body.id],
      );
      expect(
        (
          await call('POST', `/api/v1/credentials/${max.body.id}/rotate`, {
            issuance_request_id: randomUUID(),
          })
        ).status,
      ).toBe(409);
    } finally {
      await db.end();
    }
  });
  it('uses real DI Agent provider for own-resource scope checks; user/service assertions never pass as Agent keys', async () => {
    const { agentId } = await agent();
    const issued = await issue(agentId);
    const target = `/_task5/own-agents/${agentId}`;
    const provider = app.get<AgentAuthenticatorPort>(AGENT_AUTHENTICATOR);
    expect(typeof provider.authenticate).toBe('function');
    const own = await request(app.getHttpServer())
      .get(target)
      .set('Authorization', `Bearer ${issued.body.api_key}`);
    expect(own.status).toBe(200);
    expect(own.body.agent_id).toBe(agentId);
    expect(own.body.kind).toBe('agent');
    expect(countLeaks(own.text, [issued.body.api_key])).toBe(0);
    expect(
      (
        await request(app.getHttpServer())
          .get(`/_task5/own-agents/${randomUUID()}`)
          .set('Authorization', `Bearer ${issued.body.api_key}`)
      ).status,
    ).toBe(403);
    const limited = await issue(agentId, { scopes: ['metrics:write'] });
    expect(
      (
        await request(app.getHttpServer())
          .get(target)
          .set('Authorization', `Bearer ${limited.body.api_key}`)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app.getHttpServer())
          .get(target)
          .set(
            'Authorization',
            `Bearer ${issued.body.id}.${randomBytes(32).toString('base64url')}`,
          )
      ).status,
    ).toBe(401);
    for (const kind of ['user', 'service'] as const)
      expect((await call('GET', target, undefined, 'Admin', kind)).status).toBe(
        401,
      );
    const principal = await provider.authenticate(
      issued.body.api_key,
      'provisioning:read',
    );
    expect(
      Object.isFrozen(principal) && Object.isFrozen(principal.scopes),
    ).toBe(true);
  });
  it('requires signed fresh service health/verify, durable replay protection, exact binding and trusted scope', async () => {
    const target = '/internal/v1/credentials/health';
    const token = await fixture.sign({ kind: 'service', target });
    expect(
      (
        await request(app.getHttpServer())
          .get(target)
          .set('Authorization', `Bearer ${token}`)
      ).status,
    ).toBe(204);
    expect(
      (
        await request(app.getHttpServer())
          .get(target)
          .set('Authorization', `Bearer ${token}`)
      ).status,
    ).toBe(401);
    expect((await call('GET', target)).status).toBe(403);
    const verificationTarget = '/internal/v1/credentials/verify',
      body = '{"api_key":"malformed"}';
    const bound = await fixture.sign({
      kind: 'service',
      method: 'POST',
      target: verificationTarget,
      body,
    });
    const mutated = await request(app.getHttpServer())
      .post(verificationTarget)
      .set('Authorization', `Bearer ${bound}`)
      .set('Content-Type', 'application/json')
      .send('{ "api_key":"malformed"}');
    expect(mutated.status).toBe(401);
    // Recreate with a legitimate service trust entry that lacks credentials:verify.
    await app.close();
    const config = {
      ...fixture.config,
      databaseUrl: readTestUrl(identity().runtimeFile),
      serviceTrust: Object.fromEntries(
        Object.entries(fixture.config.serviceTrust).map(([id, trust]) => [
          id,
          { ...trust, scopes: ['status:write'] },
        ]),
      ),
    };
    const module = await Test.createTestingModule({
      imports: [AppModule.register(config)],
    }).compile();
    app = module.createNestApplication({ bodyParser: false, logger: false });
    installHttpBoundary(app, config);
    await app.init();
    expect(
      (await call('GET', target, undefined, 'Admin', 'service')).status,
    ).toBe(403);
    expect((await verify('malformed')).status).toBe(403);
  });
  it('fails closed with sanitized503 on a real primary-DB statement deadline, without stale-positive fallback or logs leaking key/URL', async () => {
    const { agentId } = await agent();
    const issued = await issue(agentId);
    expect((await verify(issued.body.api_key)).body.active).toBe(true);
    const db = await admin();
    const lines: string[] = [];
    const output = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        lines.push(String(chunk));
        return true;
      });
    const errors = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => {
        lines.push(String(chunk));
        return true;
      });
    try {
      await db.query('BEGIN');
      await db.query(
        'LOCK TABLE management.api_credentials IN ACCESS EXCLUSIVE MODE',
      );
      // HTTP nonce uses another table and succeeds; the actual primary credential SELECT times out.
      const response = await verify(issued.body.api_key);
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('dependency_unavailable');
      expect(
        countLeaks(JSON.stringify(response.body) + lines.join(''), [
          issued.body.api_key,
          issued.body.api_key.split('.')[1]!,
          readTestUrl(identity().runtimeFile),
        ]),
      ).toBe(0);
    } finally {
      output.mockRestore();
      errors.mockRestore();
      await db.query('ROLLBACK');
      await db.end();
    }
  });
});
