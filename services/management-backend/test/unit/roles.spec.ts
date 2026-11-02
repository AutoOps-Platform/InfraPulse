import request from 'supertest';
import { createManagementApp } from '../../src/bootstrap.js';
import { signedFixture } from '../support/keys.js';
import {
  authorize,
  routePolicy,
  UserRoles,
  ServiceScope,
} from '../../src/auth/policies.js';
import { managementOpenApi, installOpenApi } from '../../src/common/openapi.js';

// Removing kind checks or inheriting a policy silently must not open a route.
describe('server-owned default-deny policies', () => {
  it('separates user, service and Agent proofs and never upgrades Viewer/Operator', () => {
    for (const role of ['Viewer', 'Operator'] as const) {
      const user = {
        kind: 'user' as const,
        issuer: 'i',
        subject: 's',
        context: 'c',
        role,
      };
      expect(() => authorize({ kind: 'user', roles: ['Admin'] }, user)).toThrow(
        'Forbidden.',
      );
      expect(() =>
        authorize({ kind: 'service', scope: 'credentials:verify' }, user),
      ).toThrow('Forbidden.');
      expect(() =>
        authorize({ kind: 'agent', scope: 'provisioning:read' }, user),
      ).toThrow('Forbidden.');
    }
    const service = {
      kind: 'service' as const,
      issuer: 'g',
      subject: 'g',
      scopes: ['credentials:verify'],
    };
    expect(() =>
      authorize({ kind: 'user', roles: ['Admin'] }, service),
    ).toThrow('Resource not found.');
    expect(() =>
      authorize({ kind: 'service', scope: 'status:write' }, service),
    ).toThrow('Forbidden.');
    expect(() =>
      authorize({ kind: 'agent', scope: 'provisioning:read' }, service),
    ).toThrow('Resource not found.');
    expect(() =>
      authorize(
        { kind: 'user', roles: ['Admin'] },
        {
          kind: 'agent',
          credential_id: 'c',
          agent_id: 'a',
          server_id: 's',
          scopes: ['provisioning:read'],
        },
      ),
    ).toThrow('Forbidden.');
  });
  it('denies missing, inherited and mutually conflicting policy metadata', () => {
    class Parent {}
    UserRoles('Admin')(Parent);
    class Child extends Parent {}
    expect(() => routePolicy(() => {}, Child)).toThrow('Forbidden.');
    expect(() => routePolicy(() => {}, class {})).toThrow('Forbidden.');
    ServiceScope('credentials:verify')(Parent);
    expect(() => routePolicy(() => {}, Parent)).toThrow('Forbidden.');
  });
  it('serves only opted-in loopback documentation without persistent authorization or raw schema endpoints', async () => {
    const fixture = signedFixture();
    const app = await createManagementApp(fixture.config);
    try {
      installOpenApi(app, { enabled: true, listenHost: '127.0.0.1' });
      await app.init();
      expect((await request(app.getHttpServer()).get('/docs/')).status).toBe(
        200,
      );
      const init = await request(app.getHttpServer()).get(
        '/docs/swagger-ui-init.js',
      );
      expect(init.status).toBe(200);
      expect(init.text).toMatch(/"persistAuthorization":\s*false/);
      expect(
        (await request(app.getHttpServer()).get('/docs-json')).status,
      ).toBe(404);
      expect(
        (await request(app.getHttpServer()).get('/api/v1/me')).status,
      ).toBe(401);
    } finally {
      await app.close();
      fixture.cleanup();
    }
  });
  it('publishes separate schemes and verified DTOs without enabling anonymous docs', async () => {
    const fixture = signedFixture();
    const app = await createManagementApp(fixture.config);
    try {
      await app.init();
      const document = managementOpenApi(app);
      expect(Object.keys(document.components!.securitySchemes!)).toEqual([
        'AdminAssertion',
        'AgentApiKey',
        'InternalServiceAssertion',
      ]);
      expect(document.paths['/api/v1/me'].get!.security).toEqual([
        { AdminAssertion: [] },
      ]);
      expect(document.components!.schemas!.ApiErrorDto).toBeDefined();
      expect((await request(app.getHttpServer()).get('/docs')).status).toBe(
        404,
      );
      expect(() =>
        installOpenApi(app, { enabled: true, listenHost: '0.0.0.0' }),
      ).toThrow('Loopback docs required.');
    } finally {
      await app.close();
      fixture.cleanup();
    }
  });
});

describe('protected application defaults', () => {
  it('does not serve the anonymous scaffold root', async () => {
    const fixture = signedFixture();
    const app = await createManagementApp(fixture.config);
    try {
      await app.init();
      expect((await request(app.getHttpServer()).get('/')).status).toBe(404);
    } finally {
      await app.close();
      fixture.cleanup();
    }
  });
});
