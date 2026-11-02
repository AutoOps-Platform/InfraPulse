import request from 'supertest';
import { createManagementApp } from '../../src/bootstrap.js';
import { signedFixture } from '../support/keys.js';
import { identity } from '../support/db.js';
import { readTestUrl } from '../support/pg-harness.js';
import { Controller, Get, Post, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { AuthModule } from '../../src/auth/auth.module.js';
import { DatabaseModule } from '../../src/database/database.module.js';
import {
  UserRoles,
  ServiceScope,
  AgentScope,
} from '../../src/auth/policies.js';
import { installHttpBoundary } from '../../src/common/http-boundary.js';
import { signedClient } from '../support/signed-client.js';
import { admin } from '../support/db.js';
import {
  AGENT_AUTHENTICATOR,
  type AgentAuthenticatorPort,
  type UserPrincipal,
} from '../../src/auth/principal.js';
import { CurrentUser } from '../../src/auth/current-user.js';
import { ApiError } from '../../src/common/errors.js';

// Only this TestingModule registers these probe routes; production AppModule never does.
@Controller('__test__')
class TestAdminController {
  @Post('admin-only') @UserRoles('Admin') admin() {
    return { ok: true };
  }
  @Get('unannotated') unannotated() {
    return { ok: true };
  }
  @Get('internal') @ServiceScope('credentials:verify') internal() {
    return { ok: true };
  }
  @Get('status') @ServiceScope('status:write') status() {
    return { ok: true };
  }
  @Get('agent') @AgentScope('provisioning:read') agent() {
    return { ok: true };
  }
  @Get('agent-user') @AgentScope('provisioning:read') agentUser(
    @CurrentUser() user: UserPrincipal,
  ) {
    return user;
  }
}

describe('real HTTP role, principal separation and exact byte binding', () => {
  let fixture: ReturnType<typeof signedFixture>;
  let app: INestApplication;
  beforeEach(async () => {
    fixture = signedFixture();
    const config = {
      ...fixture.config,
      databaseUrl: readTestUrl(identity().runtimeFile),
    };
    const module = await Test.createTestingModule({
      imports: [AppModule.register(config)],
      controllers: [TestAdminController],
    }).compile();
    app = module.createNestApplication({ bodyParser: false, logger: false });
    installHttpBoundary(app, config);
    await app.init();
  });
  afterEach(async () => {
    await app.close();
    fixture.cleanup();
  });
  it.each([
    ['Viewer', 'Viewer'],
    ['Editor', 'Operator'],
    ['Admin', 'Admin'],
  ] as const)(
    'exposes %s as %s, with no assertion and no cache',
    async (role, mapped) => {
      const response = await signedClient(app, fixture)
        .as(role)
        .get('/api/v1/me');
      expect(response.status).toBe(200);
      expect(response.body.role).toBe(mapped);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(Object.keys(response.body).sort()).toEqual([
        'context',
        'issuer',
        'kind',
        'role',
        'subject',
      ]);
    },
  );
  it.each(['Viewer', 'Editor'] as const)(
    'denies %s admin mutation before reserving its nonce',
    async (role) => {
      const target = '/__test__/admin-only';
      const token = await fixture.sign({
        role,
        method: 'POST',
        target,
        body: '{}',
      });
      expect(
        (
          await request(app.getHttpServer())
            .post(target)
            .set('Authorization', `Bearer ${token}`)
            .send({})
        ).status,
      ).toBe(403);
      const client = await admin();
      try {
        const jti = JSON.parse(
          Buffer.from(token.split('.')[1], 'base64url').toString(),
        ).jti;
        const result = await client.query(
          'SELECT count(*)::int AS n FROM management.request_nonces WHERE issuer=$1 AND jti=$2',
          ['grafana-fixture', jti],
        );
        expect(result.rows[0].n).toBe(0);
      } finally {
        await client.end();
      }
    },
  );
  it('allows an Admin only with the exact signed raw JSON bytes', async () => {
    const target = '/__test__/admin-only';
    const body = '{ "a": 1 }';
    const token = await fixture.sign({
      role: 'Admin',
      method: 'POST',
      target,
      body,
    });
    expect(
      (
        await request(app.getHttpServer())
          .post(target)
          .set('Authorization', `Bearer ${token}`)
          .set('Content-Type', 'application/json')
          .send('{"a":1}')
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app.getHttpServer())
          .post(target)
          .set('Authorization', `Bearer ${token}`)
          .set('Content-Type', 'application/json')
          .send(body)
      ).status,
    ).toBe(201);
  });
  it('rejects equivalent normalized query bytes and order, but accepts the original exact target', async () => {
    const target = '/api/v1/me?a=%2f&b=2';
    const token = await fixture.sign({ target });
    for (const changed of ['/api/v1/me?a=%2F&b=2', '/api/v1/me?b=2&a=%2f']) {
      expect(
        (
          await request(app.getHttpServer())
            .get(changed)
            .set('Authorization', `Bearer ${token}`)
        ).status,
      ).toBe(401);
    }
    expect(
      (
        await request(app.getHttpServer())
          .get(target)
          .set('Authorization', `Bearer ${token}`)
      ).status,
    ).toBe(200);
  });
  it('denies unannotated routes and returns 503 when the Agent authenticator is absent', async () => {
    // Deliberately omit CredentialsModule: AppModule now owns the real Agent port.
    await app.close();
    const config = {
      ...fixture.config,
      databaseUrl: readTestUrl(identity().runtimeFile),
    };
    const module = await Test.createTestingModule({
      imports: [DatabaseModule.register(config), AuthModule.register(config)],
      controllers: [TestAdminController],
    }).compile();
    app = module.createNestApplication({ bodyParser: false, logger: false });
    installHttpBoundary(app, config);
    await app.init();
    expect(
      (await request(app.getHttpServer()).get('/__test__/unannotated')).status,
    ).toBe(403);
    expect(
      (await request(app.getHttpServer()).get('/__test__/agent')).status,
    ).toBe(503);
    for (const kind of ['user', 'service'] as const) {
      const target = '/__test__/agent';
      expect(
        (
          await request(app.getHttpServer())
            .get(target)
            .set(
              'Authorization',
              `Bearer ${await fixture.sign({ kind, target })}`,
            )
        ).status,
      ).toBe(503);
    }
  });
  it('separates internal service from user Admin and ignores claimed extra service scopes', async () => {
    const adminTarget = '/__test__/admin-only';
    const service = await fixture.sign({
      kind: 'service',
      target: adminTarget,
      method: 'POST',
      body: '{}',
    });
    expect(
      (
        await request(app.getHttpServer())
          .post(adminTarget)
          .set('Authorization', `Bearer ${service}`)
          .send({})
      ).status,
    ).toBe(404);
    const target = '/__test__/internal';
    const user = await fixture.sign({ role: 'Admin', target });
    expect(
      (
        await request(app.getHttpServer())
          .get(target)
          .set('Authorization', `Bearer ${user}`)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app.getHttpServer())
          .get(target)
          .set(
            'Authorization',
            `Bearer ${await fixture.sign({ kind: 'service', target })}`,
          )
      ).status,
    ).toBe(200);
    const forbidden = '/__test__/status';
    expect(
      (
        await request(app.getHttpServer())
          .get(forbidden)
          .set(
            'Authorization',
            `Bearer ${await fixture.sign({ kind: 'service', target: forbidden, claims: { scopes: ['status:write'] } })}`,
          )
      ).status,
    ).toBe(403);
  });
  it('uses a registered Agent port across module boundaries, never exposes Agent as CurrentUser', async () => {
    // Explicitly override the now-owned credential port. JWT, guards, HTTP and nonce DB remain real.
    const port: AgentAuthenticatorPort = {
      async authenticate(key, scope) {
        if (key !== 'fixture.agent-proof' || scope !== 'provisioning:read')
          throw new ApiError('unauthorized');
        return Object.freeze({
          kind: 'agent',
          credential_id: 'credential-fixture',
          server_id: 'server-fixture',
          agent_id: 'agent-fixture',
          scopes: Object.freeze(['provisioning:read'] as const),
        });
      },
    };
    const config = {
      ...fixture.config,
      databaseUrl: readTestUrl(identity().runtimeFile),
    };
    const module = await Test.createTestingModule({
      imports: [AppModule.register(config)],
      controllers: [TestAdminController],
    }).overrideProvider(AGENT_AUTHENTICATOR).useValue(port).compile();
    const other = module.createNestApplication({
      bodyParser: false,
      logger: false,
    });
    installHttpBoundary(other, config);
    try {
      await other.init();
      expect(
        (
          await request(other.getHttpServer())
            .get('/__test__/agent')
            .set('Authorization', 'Bearer fixture.agent-proof')
        ).status,
      ).toBe(200);
      expect(
        (
          await request(other.getHttpServer())
            .get('/__test__/agent-user')
            .set('Authorization', 'Bearer fixture.agent-proof')
        ).status,
      ).toBe(403);
      for (const kind of ['user', 'service'] as const) {
        const target = '/__test__/agent';
        expect(
          (
            await request(other.getHttpServer())
              .get(target)
              .set(
                'Authorization',
                `Bearer ${await fixture.sign({ kind, target })}`,
              )
          ).status,
        ).toBe(401);
      }
    } finally {
      await other.close();
    }
  });
  it('never exposes the test-only admin controller in the runtime factory', async () => {
    const runtime = await createManagementApp({
      ...fixture.config,
      databaseUrl: readTestUrl(identity().runtimeFile),
    });
    try {
      await runtime.init();
      expect(
        (await request(runtime.getHttpServer()).post('/__test__/admin-only'))
          .status,
      ).toBe(404);
    } finally {
      await runtime.close();
    }
  });
});

describe('real signed user and durable replay HTTP', () => {
  it('returns only the verified Viewer snapshot', async () => {
    const fixture = signedFixture();
    const app = await createManagementApp({
      ...fixture.config,
      databaseUrl: readTestUrl(identity().runtimeFile),
    });
    try {
      await app.init();
      const token = await fixture.sign();
      const response = await request(app.getHttpServer())
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${token}`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        kind: 'user',
        issuer: 'grafana-fixture',
        subject: 'opaque-user-17',
        context: 'fixture-grafana',
        role: 'Viewer',
      });
    } finally {
      await app.close();
      fixture.cleanup();
    }
  });
});
