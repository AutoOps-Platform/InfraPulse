import request from 'supertest';
import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module.js';
import { NonceService } from '../../src/auth/nonce.service.js';
import { installHttpBoundary } from '../../src/common/http-boundary.js';
import { managementOpenApi } from '../../src/common/openapi.js';
import {
  matchesVerifier,
  newCredential,
  parseCredential,
  verificationTtl,
} from '../../src/credentials/credential-verifier.js';
import { signedFixture } from '../support/keys.js';
import { countLeaks } from '../support/config.js';

const comparisons = vi.hoisted(() => ({ lengths: [] as number[][] }));
vi.mock('node:crypto', async (importOriginal) => {
  const crypto = await importOriginal<typeof import('node:crypto')>();
  return {
    ...crypto,
    timingSafeEqual: (left: Uint8Array, right: Uint8Array) => {
      comparisons.lengths.push([left.byteLength, right.byteLength]);
      return crypto.timingSafeEqual(left, right);
    },
  };
});

// Instrument only operand lengths, delegating comparison to actual Node crypto.
// Secret-bearing assertions consume values in memory and emit only booleans/counts on failure.
describe('Task5 credential verifier primitives', () => {
  it('floors remaining DB-snapshot milliseconds and never emits zero/submillisecond positive TTL', () => {
    expect(
      [0, -1, 0.999, 1, 1.999, 1234.9, 30000.9, 999999].map(verificationTtl),
    ).toEqual([0, 0, 0, 1, 1, 1234, 30000, 30000]);
    expect([NaN, Infinity, -Infinity].map(verificationTtl)).toEqual([0, 0, 0]);
  });
  it('generates canonical UUID +32 random bytes, hashes decoded secret only, prefix from public ID', () => {
    const keys = Array.from({ length: 64 }, () => newCredential());
    expect(new Set(keys.map((key) => key.apiKey)).size).toBe(64);
    expect(new Set(keys.map((key) => key.id)).size).toBe(64);
    for (const key of keys) {
      const parsed = parseCredential(key.apiKey);
      expect(parsed !== null).toBe(true);
      expect(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(key.apiKey)).toBe(true);
      const bytes = Buffer.from(key.apiKey.split('.')[1]!, 'base64url');
      expect(bytes.length).toBe(32);
      expect(key.hash.length).toBe(32);
      expect(key.hash.equals(createHash('sha256').update(bytes).digest())).toBe(
        true,
      );
      expect(
        key.hash.equals(createHash('sha256').update(key.apiKey).digest()),
      ).toBe(false);
      expect(key.publicPrefix === key.id.slice(0, 8)).toBe(true);
      expect(matchesVerifier(parsed!.hash, key.hash)).toBe(true);
    }
  });
  it('rejects malformed/normalized/aliased tokens without throwing or comparing variable-length hashes', () => {
    comparisons.lengths.length = 0;
    const key = newCredential();
    const secret = key.apiKey.split('.')[1]!;
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const alias =
      secret.slice(0, -1) + alphabet[alphabet.indexOf(secret.at(-1)!) + 1];
    const malformed = [
      '',
      ` ${key.apiKey}`,
      `${key.apiKey} `,
      `${key.apiKey}\n`,
      `DEADBEEF-0000-4000-8000-000000000000.${secret}`,
      `${key.apiKey}=`,
      `${key.id}.${secret.slice(1)}`,
      `${key.id}.${alias}`,
      `${key.apiKey}.more`,
      `not-uuid.${secret}`,
    ];
    expect(
      malformed.filter((value) => parseCredential(value) !== null).length,
    ).toBe(0);
    const other = newCredential();
    expect(matchesVerifier(other.hash, key.hash)).toBe(false);
    for (const n of [0, 1, 31, 33, 64]) {
      expect(matchesVerifier(key.hash, Buffer.alloc(n))).toBe(false);
      expect(matchesVerifier(Buffer.alloc(n), key.hash)).toBe(false);
    }
    expect(matchesVerifier(key.hash, null)).toBe(false);
    expect(comparisons.lengths.length).toBe(12);
    expect(
      comparisons.lengths.every(([left, right]) => left === 32 && right === 32),
    ).toBe(true);
  });
});

describe('Task5 credential signed service boundary', () => {
  let fixture: ReturnType<typeof signedFixture>;
  let app: INestApplication;
  beforeEach(async () => {
    fixture = signedFixture();
    const module = await Test.createTestingModule({
      imports: [AppModule.register(fixture.config)],
    })
      // Unit collection never connects; real durable nonces are exercised by DB tests.
      .overrideProvider(NonceService)
      .useValue({ reserve: async () => undefined })
      .compile();
    app = module.createNestApplication({ bodyParser: false, logger: false });
    installHttpBoundary(app, fixture.config);
    await app.init();
  });
  afterEach(async () => {
    await app.close();
    fixture.cleanup();
  });
  async function verify(
    target: string,
    body: string,
    kind: 'service' | 'user' = 'service',
  ) {
    const token = await fixture.sign({ kind, method: 'POST', target, body });
    return request(app.getHttpServer())
      .post(target)
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json')
      .send(body);
  }
  it('rejects a verify body over8KiB before DTO validation (including accepted route variants)', async () => {
    const body = JSON.stringify({ api_key: 'x'.repeat(8200) });
    for (const target of [
      '/internal/v1/credentials/verify',
      '/INTERNAL/v1/Credentials/VERIFY/',
      '/internal/v1/credentials/verify?test=1',
    ]) {
      expect((await verify(target, body)).status).toBe(413);
    }
    // These really route to the same handler with the unmodified, exactly signed target.
    expect(
      (
        await verify(
          '/INTERNAL/v1/Credentials/VERIFY/',
          '{"api_key":"malformed"}',
        )
      ).body,
    ).toEqual({ active: false });
    expect(
      (
        await verify(
          '/internal/v1/credentials/verify?test=1',
          '{"api_key":"malformed"}',
        )
      ).status,
    ).toBe(400);
    const exact = '{"api_key":"' + 'x'.repeat(8192 - 14) + '"}';
    expect(Buffer.byteLength(exact)).toBe(8192);
    expect(
      (await verify('/internal/v1/credentials/verify', exact)).status,
    ).toBe(200);
  });
  it('rejects chunked overflow at8KiB without Content-Length on an accepted case/trailing-slash variant', async () => {
    await app.listen(0, '127.0.0.1');
    const target = '/INTERNAL/v1/Credentials/VERIFY/';
    const body = JSON.stringify({ api_key: 'x'.repeat(8300) });
    const token = await fixture.sign({
      kind: 'service',
      method: 'POST',
      target,
      body,
    });
    const port = (app.getHttpServer().address() as { port: number }).port;
    const result = await new Promise<{ status: number; bytes: string }>(
      (resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            path: target,
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'Transfer-Encoding': 'chunked',
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () =>
              resolve({
                status: res.statusCode!,
                bytes: Buffer.concat(chunks).toString('utf8'),
              }),
            );
          },
        );
        req.on('error', reject);
        req.write(body.slice(0, 4096));
        req.end(body.slice(4096));
      },
    );
    expect(result.status).toBe(413);
    expect(countLeaks(result.bytes, [token, body])).toBe(0);
  });
  it('accepts a fresh scope-bound service assertion at credentials health without a real key', async () => {
    const target = '/internal/v1/credentials/health';
    const assertion = await fixture.sign({ kind: 'service', target });
    const response = await request(app.getHttpServer())
      .get(target)
      .set('Authorization', `Bearer ${assertion}`);
    expect(response.status).toBe(204);
    expect(response.text.length).toBe(0);
    expect(response.headers['cache-control']).toBe('no-store');
    expect((await request(app.getHttpServer()).get(target)).status).toBe(401);
  });
  it('requires the sole JSON api_key member, never allows key/query or DTO/JSON/error echo', async () => {
    const target = '/internal/v1/credentials/verify';
    const key = newCredential().apiKey;
    const bad = [
      JSON.stringify({ api_key: key, scope: 'metrics:write' }),
      JSON.stringify({ api_key: null }),
      '{}',
      '[]',
      JSON.stringify({ api_key: key }).slice(0, -1),
      `{"api_key":${JSON.stringify(key)},"api_key":"second"}`,
    ];
    for (const body of bad) {
      const response = await verify(target, body);
      expect(response.status).toBe(400);
      expect(countLeaks(response.text, [key, key.split('.')[1]!])).toBe(0);
    }
    const user = await verify(target, '{"api_key":"malformed"}', 'user');
    expect(user.status).toBe(403);
    expect((await verify(target, '{"api_key":"malformed"}')).body).toEqual({
      active: false,
    });
    const token = await fixture.sign({
      kind: 'service',
      method: 'POST',
      target,
      body: '{"api_key":"malformed"}',
    });
    expect(
      (
        await request(app.getHttpServer())
          .post(target)
          .set('Authorization', `Bearer ${token}`)
          .send('{"api_key":"changed"}')
      ).status,
    ).not.toBe(200);
  });
  it('publishes Admin-only safe metadata, strict verification union and service-only status contract, not generic provisioning', () => {
    const doc = managementOpenApi(app);
    expect(doc.paths['/api/v1/credentials']?.get?.security).toEqual([
      { AdminAssertion: [] },
    ]);
    expect(
      doc.paths['/internal/v1/credentials/verify']?.post?.security,
    ).toEqual([{ InternalServiceAssertion: [] }]);
    expect(
      doc.paths['/internal/v1/credentials/verify']?.post?.responses['200'],
    ).toMatchObject({
      content: {
        'application/json': {
          schema: {
            oneOf: [
              { additionalProperties: false, required: ['active'] },
              {
                additionalProperties: false,
                required: [
                  'active',
                  'credential_id',
                  'server_id',
                  'agent_id',
                  'scopes',
                  'expires_at',
                  'cache_ttl_ms',
                ],
              },
            ],
          },
        },
      },
    });
    const safe = JSON.stringify(doc.components?.schemas?.CredentialDto);
    expect(/secret_hash|api_key/.test(safe)).toBe(false);
    expect(doc.paths['/api/v1/provisioning']).toBeUndefined();
    expect(
      doc.paths['/internal/v1/status/reports']?.post?.security,
    ).toEqual([{ InternalServiceAssertion: [] }]);
    expect(
      doc.paths['/internal/v1/status/reports']?.post?.responses['200'],
    ).toBeDefined();
  });
});
