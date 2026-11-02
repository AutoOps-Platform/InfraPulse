import request from 'supertest';
import { createManagementApp } from '../../src/bootstrap.js';
import { signedFixture } from '../support/keys.js';
import { AssertionVerifier } from '../../src/auth/assertions.js';
import { TestClock } from '../support/clock.js';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';

const binding = {
  method: 'GET',
  target: '/api/v1/me',
  rawBody: new Uint8Array(),
};
describe('actual Ed25519 assertion verification', () => {
  let fixture: ReturnType<typeof signedFixture>;
  beforeEach(() => {
    fixture = signedFixture();
  });
  afterEach(() => fixture.cleanup());
  const now = 1_800_000_000;
  it.each([
    ['Viewer', 'Viewer'],
    ['Editor', 'Operator'],
    ['Admin', 'Admin'],
  ])(
    'maps signed %s to %s and freezes only a snapshot',
    async (role, effective) => {
      const verifier = new AssertionVerifier(
        fixture.config,
        new TestClock(now * 1000),
      );
      const result = await verifier.verify(
        await fixture.sign({ role, now }),
        binding,
      );
      expect(result.principal).toEqual({
        kind: 'user',
        issuer: 'grafana-fixture',
        subject: 'opaque-user-17',
        context: 'fixture-grafana',
        role: effective,
      });
      expect(Object.isFrozen(result.principal)).toBe(true);
      expect(result.expiresAt.getTime()).toBe((now + 60) * 1000);
    },
  );
  it.each([
    { iss: 'untrusted' },
    { aud: 'other' },
    { sub: '' },
    { sub: 'x'.repeat(129) },
    { ctx: 'other' },
    { grafana_role: 'SuperAdmin' },
    { grafana_role: 'toString' },
    { jti: 'not-a-uuid' },
    { exp: now + 61 },
    { iat: now + 6, nbf: now + 6, exp: now + 60 },
    { nbf: now + 6 },
    { exp: now - 6, iat: now - 60, nbf: now - 60 },
    { iat: now + 0.1 },
    { display: 'bad\nname' },
    { aud: ['admin-fixture'] },
    { kind: 'agent' },
    { m: 'get' },
    { b: 'wrong' },
    { iss: undefined },
    { aud: undefined },
    { sub: undefined },
    { iat: undefined },
    { nbf: undefined },
    { exp: undefined },
    { jti: undefined },
    { kind: undefined },
    { grafana_role: undefined },
    { ctx: undefined },
  ])(
    'rejects untrusted, malformed, stale or unbound claims %#',
    async (claims) => {
      const verifier = new AssertionVerifier(
        fixture.config,
        new TestClock(now * 1000),
      );
      await expect(
        verifier.verify(await fixture.sign({ now, claims }), binding),
      ).rejects.toMatchObject({ code: 'unauthorized' });
    },
  );
  it('rejects a different trusted signer selected under the wrong kid and corrupted signatures', async () => {
    const verifier = new AssertionVerifier(
      fixture.config,
      new TestClock(now * 1000),
    );
    await expect(
      verifier.verify(
        await fixture.sign({ kind: 'service', now, header: { kid: 'admin' } }),
        binding,
      ),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    const token = await fixture.sign({ now });
    const parts = token.split('.');
    const signature = Buffer.from(parts[2], 'base64url');
    signature[0] ^= 1;
    parts[2] = signature.toString('base64url');
    await expect(
      verifier.verify(parts.join('.'), binding),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });
  it('accepts standard nbf backdating without extending the 60-second issued lifetime', async () => {
    const verifier = new AssertionVerifier(
      fixture.config,
      new TestClock(now * 1000),
    );
    await expect(
      verifier.verify(
        await fixture.sign({ now, claims: { nbf: now - 5 } }),
        binding,
      ),
    ).resolves.toMatchObject({ issuer: 'grafana-fixture' });
  });
  it('has exactly five seconds of expiry leeway', async () => {
    const token = await fixture.sign({ now });
    await expect(
      new AssertionVerifier(
        fixture.config,
        new TestClock((now + 64) * 1000),
      ).verify(token, binding),
    ).resolves.toMatchObject({ issuer: 'grafana-fixture' });
    await expect(
      new AssertionVerifier(
        fixture.config,
        new TestClock((now + 65) * 1000),
      ).verify(token, binding),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });
  it.each([
    { alg: 'HS256' },
    { kid: 'stale' },
  ])('rejects invalid algorithm or unknown kid %#', async (header) => {
    // Change the protected header of a genuinely signed JWT, never a fixed private-key fixture.
    const signed = await fixture.sign({ now });
    const parts = signed.split('.');
    parts[0] = Buffer.from(
      JSON.stringify({ alg: 'EdDSA', kid: 'admin', ...header }),
    ).toString('base64url');
    await expect(
      new AssertionVerifier(fixture.config, new TestClock(now * 1000)).verify(
        parts.join('.'),
        binding,
      ),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });
  it.each(['jku', 'x5u', 'jwk'] as const)(
    'rejects genuinely signed forbidden %s without relying on a bad signature',
    async (name) => {
      const publicKey = createPublicKey(fixture.config.adminTrust.admin.public_key_pem);
      const value = name === 'jwk'
        ? publicKey.export({ format: 'jwk' })
        : `https://untrusted.invalid/${name}`;
      const token = await fixture.sign({ now, header: { [name]: value } });
      const [protectedHeader, payload, signature] = token.split('.');
      // Independent local-key verification: no remote key lookup or private export.
      expect(verify(
        null,
        Buffer.from(`${protectedHeader}.${payload}`),
        publicKey,
        Buffer.from(signature, 'base64url'),
      )).toBe(true);
      await expect(
        new AssertionVerifier(fixture.config, new TestClock(now * 1000)).verify(
          token,
          binding,
        ),
      ).rejects.toMatchObject({ code: 'unauthorized' });
    },
  );
  it('uses service scopes from trust, never claimed escalation, and pins its subject', async () => {
    const verifier = new AssertionVerifier(
      fixture.config,
      new TestClock(now * 1000),
    );
    const result = await verifier.verify(
      await fixture.sign({
        now,
        kind: 'service',
        claims: { scopes: ['status:write', 'Admin'] },
      }),
      binding,
    );
    expect(result.principal).toEqual({
      kind: 'service',
      issuer: 'gateway-fixture',
      subject: 'gateway-opaque',
      scopes: ['credentials:verify'],
    });
    if (result.principal.kind === 'service')
      expect(Object.isFrozen(result.principal.scopes)).toBe(true);
    await expect(
      verifier.verify(
        await fixture.sign({ now, kind: 'service', claims: { sub: 'other' } }),
        binding,
      ),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      verifier.verify(
        await fixture.sign({
          now,
          kind: 'service',
          claims: { grafana_role: 'Admin' },
        }),
        binding,
      ),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });
  it('rejects non-Ed25519 trust and shared signer trust at startup without parser details', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();
    expect(
      () =>
        new AssertionVerifier({
          ...fixture.config,
          adminTrust: {
            admin: { ...fixture.config.adminTrust.admin, public_key_pem: rsa },
          },
        }),
    ).toThrow('Dependency unavailable.');
    expect(
      () =>
        new AssertionVerifier({
          ...fixture.config,
          serviceTrust: {
            gateway: {
              ...fixture.config.serviceTrust.gateway,
              public_key_pem: fixture.config.adminTrust.admin.public_key_pem,
            },
          },
        }),
    ).toThrow('Dependency unavailable.');
  });
});

// Missing signature enforcement (including exact bytes/target) must not become an anonymous route.
describe('signed request HTTP boundary', () => {
  it.each([
    'missing',
    'target mutation',
    'body mutation',
    'wrong audience',
    'unknown kid',
  ])('rejects %s before any database reservation', async (mode) => {
    const fixture = signedFixture();
    const app = await createManagementApp(fixture.config);
    try {
      await app.init();
      const token = await fixture.sign({
        target: mode === 'target mutation' ? '/api/v1/me?x=%2f' : '/api/v1/me',
        body: mode === 'body mutation' ? '{ "a":1 }' : '',
        claims: mode === 'wrong audience' ? { aud: 'other' } : {},
        header: mode === 'unknown kid' ? { kid: 'unknown' } : {},
      });
      const call = request(app.getHttpServer()).get('/api/v1/me');
      if (mode !== 'missing') call.set('Authorization', `Bearer ${token}`);
      const response = await call;
      expect(response.status).toBe(401);
      expect(response.body.code).toBe('unauthorized');
    } finally {
      await app.close();
      fixture.cleanup();
    }
  });
});
