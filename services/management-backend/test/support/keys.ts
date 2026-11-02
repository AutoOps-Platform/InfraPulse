import { generateKeyPairSync, createHash, randomUUID } from 'node:crypto';
import { SignJWT, type JWTPayload } from 'jose';
import { loadConfig, type ManagementConfig } from '../../src/config/config.js';
import { configFixture } from './config.js';

// Private keys exist only in this closure, never serialized or written to disk.
export function signedFixture() {
  const user = generateKeyPairSync('ed25519');
  const service = generateKeyPairSync('ed25519');
  const fixture = configFixture();
  const publicPem = (key: typeof user.publicKey) =>
    key.export({ type: 'spki', format: 'pem' }).toString();
  const config: ManagementConfig = Object.freeze({
    ...loadConfig(fixture.env),
    adminTrust: Object.freeze({
      admin: Object.freeze({
        public_key_pem: publicPem(user.publicKey),
        issuer: 'grafana-fixture',
        audience: 'admin-fixture',
      }),
    }),
    serviceTrust: Object.freeze({
      gateway: Object.freeze({
        public_key_pem: publicPem(service.publicKey),
        issuer: 'gateway-fixture',
        audience: 'internal-fixture',
        subject: 'gateway-opaque',
        scopes: Object.freeze(['credentials:verify']),
      }),
    }),
  });
  async function sign(
    options: {
      kind?: 'user' | 'service';
      role?: string;
      method?: string;
      target?: string;
      body?: string;
      now?: number;
      claims?: JWTPayload;
      header?: Record<string, unknown>;
    } = {},
  ) {
    const kind = options.kind ?? 'user';
    const now = options.now ?? Math.floor(Date.now() / 1000);
    const payload = {
      iss: kind === 'user' ? 'grafana-fixture' : 'gateway-fixture',
      aud: kind === 'user' ? 'admin-fixture' : 'internal-fixture',
      sub: kind === 'user' ? 'opaque-user-17' : 'gateway-opaque',
      iat: now,
      nbf: now,
      exp: now + 60,
      jti: randomUUID(),
      kind,
      ...(kind === 'user'
        ? { grafana_role: options.role ?? 'Viewer', ctx: 'fixture-grafana' }
        : {}),
      m: options.method ?? 'GET',
      t: options.target ?? '/api/v1/me',
      b: createHash('sha256')
        .update(options.body ?? '')
        .digest('base64url'),
      ...options.claims,
    };
    return new SignJWT(payload)
      .setProtectedHeader({
        alg: 'EdDSA',
        kid: kind === 'user' ? 'admin' : 'gateway',
        ...options.header,
      })
      .sign(kind === 'user' ? user.privateKey : service.privateKey);
  }
  return { config, sign, cleanup: fixture.cleanup };
}
