import request from 'supertest';
import { request as nativeRequest } from 'node:http';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module.js';
import { NonceService } from '../../src/auth/nonce.service.js';
import { installHttpBoundary } from '../../src/common/http-boundary.js';
import { signedFixture } from '../support/keys.js';
import { createHash } from 'node:crypto';
import { ApiError } from '../../src/common/errors.js';
import { parseStrictJson } from '../../src/common/http-boundary.js';
import {
  validateProfileConfig,
  canonicalProfile,
  profileChecksum,
} from '../../src/profiles/profile-config.js';

const base = {
  schema_version: 1 as const,
  os: 'linux' as const,
  interval_seconds: 15,
  metric_groups: { cpu: true, memory: true, disk: true, network: true },
  options: {},
};
const manual =
  '{"interval_seconds":15,"metric_groups":{"cpu":true,"disk":true,"memory":true,"network":true},"options":{},"os":"linux","schema_version":1}';
// Breaks caught: wrong canonical sort/escaping/hash input, lossy Unicode or number
// acceptance, permissive schema/OS options, mutation of caller config or defaults.
describe('Task6 ProfileConfigV1 canonical JSON and OS allowlist', () => {
  it('matches independently hand-sorted literal and crypto SHA256, regardless insertion order', () => {
    const input = {
      options: {},
      metric_groups: { network: true, disk: true, memory: true, cpu: true },
      os: 'linux',
      schema_version: 1,
      interval_seconds: 15,
    };
    const valid = validateProfileConfig(input, 'linux');
    expect(canonicalProfile(valid)).toBe(manual);
    expect(profileChecksum(valid)).toBe(
      createHash('sha256').update(manual, 'utf8').digest('hex'),
    );
    expect(profileChecksum(valid)).toBe(profileChecksum(base));
    expect(
      validateProfileConfig({ ...base, interval_seconds: undefined }, 'linux')
        .interval_seconds,
    ).toBe(15);
  });
  it('canonicalizes Unicode/escaping/array order without normalization and retains concrete Windows options', () => {
    const input = {
      ...base,
      os: 'windows' as const,
      options: {
        network: { interfaces: ['réseau', 'e\u0301', 'é', 'a"b', 'a\\b'] },
        disk: { include_volumes: ['C:', 'D:'] },
      },
    };
    const literal =
      '{"interval_seconds":15,"metric_groups":{"cpu":true,"disk":true,"memory":true,"network":true},"options":{"disk":{"include_volumes":["C:","D:"]},"network":{"interfaces":["réseau","é","é","a\\"b","a\\\\b"]}},"os":"windows","schema_version":1}';
    const config = validateProfileConfig(input, 'windows');
    expect(canonicalProfile(config)).toBe(literal);
    expect(profileChecksum(config)).toBe(
      createHash('sha256').update(literal, 'utf8').digest('hex'),
    );
    const linux = validateProfileConfig(
      {
        ...base,
        options: {
          disk: {
            exclude_filesystems: ['tmpfs'],
            mount_points: ['/', '/srv/data'],
          },
          network: { interfaces: ['eth0'] },
        },
      },
      'linux',
    );
    expect(linux.options).toEqual({
      disk: {
        exclude_filesystems: ['tmpfs'],
        mount_points: ['/', '/srv/data'],
      },
      network: { interfaces: ['eth0'] },
    });
    input.options.disk.include_volumes[0] = 'Z:';
    expect(
      (config.options.disk as { include_volumes: string[] }).include_volumes[0],
    ).toBe('C:');
  });
  it.each([5, 15, 300])('accepts integer interval boundary %s', (interval) =>
    expect(
      validateProfileConfig({ ...base, interval_seconds: interval }, 'linux')
        .interval_seconds,
    ).toBe(interval),
  );
  it.each([
    4,
    301,
    1.1,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    null,
    '15',
  ])('rejects invalid numeric input %s', (interval) =>
    expect(() =>
      validateProfileConfig({ ...base, interval_seconds: interval }, 'linux'),
    ).toThrow(ApiError),
  );
  it.each([
    null,
    [],
    {},
    { ...base, schema_version: 2 },
    { ...base, os: 'windows' },
    { ...base, extra: true },
    { ...base, options: { shell: 'sh' } },
    { ...base, options: { url: 'https://example.invalid' } },
    { ...base, options: { secret: 'x' } },
    { ...base, options: { disk: { include_volumes: ['C:'] } } },
    { ...base, options: { disk: { mount_points: ['relative'] } } },
    { ...base, options: { network: { interfaces: ['${secret}'] } } },
    { ...base, options: { network: { interfaces: ['{{token}}'] } } },
    {
      ...base,
      options: { network: { interfaces: ['https://example.invalid'] } },
    },
    { ...base, options: { network: { interfaces: ['$(sh)'] } } },
    { ...base, options: { network: { interfaces: ['a;sh'] } } },
    { ...base, options: { network: { interfaces: ['a\n'] } } },
    { ...base, options: { network: { interfaces: ['\ud800'] } } },
    { ...base, options: { network: { interfaces: ['\udc00'] } } },
    { ...base, options: { network: { interfaces: [''] } } },
    { ...base, options: { network: { interfaces: ['x'.repeat(129)] } } },
    { ...base, options: { network: { interfaces: Array(65).fill('eth0') } } },
    { ...base, options: { network: { interfaces: [1] } } },
    {
      ...base,
      metric_groups: {
        cpu: true,
        memory: true,
        disk: true,
        network: true,
        system: true,
      },
    },
    { ...base, metric_groups: { cpu: true, memory: true, disk: true } },
    {
      ...base,
      metric_groups: { cpu: 1, memory: true, disk: true, network: true },
    },
  ])(
    'rejects malformed, unknown, executable or other-OS config case %#',
    (value) =>
      expect(() => validateProfileConfig(value, 'linux')).toThrow(ApiError),
  );
  it('rejects Linux-only Windows disk keys and duplicate raw keys including Unicode aliases', () => {
    expect(() =>
      validateProfileConfig(
        { ...base, os: 'windows', options: { disk: { mount_points: ['/'] } } },
        'windows',
      ),
    ).toThrow(ApiError);
    for (const text of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"x":1e400}'])
      expect(() => parseStrictJson(Buffer.from(text))).toThrow(ApiError);
    expect(() =>
      parseStrictJson(Buffer.from([0x7b, 0x22, 0xc3, 0x22, 0x3a, 0x31, 0x7d])),
    ).toThrow(ApiError);
  });
  it('rejects over64KiB of individually legal UTF8 options', () => {
    const config = {
      ...base,
      options: {
        disk: {
          exclude_filesystems: Array(64).fill('漢'.repeat(128)),
          mount_points: Array(64).fill('/' + '漢'.repeat(127)),
        },
        network: { interfaces: Array(64).fill('漢'.repeat(128)) },
      },
    };
    expect(() => validateProfileConfig(config, 'linux')).toThrow(
      expect.objectContaining({ code: 'payload_too_large' }),
    );
  });
});

// Break caught: a missing profile configuration boundary or permissive DTO reaches
// persistence (unavailable in this unit fixture) instead of rejecting unsafe data.
describe('Task6 signed profile configuration boundary', () => {
  let app: INestApplication;
  let fixture: ReturnType<typeof signedFixture>;
  beforeEach(async () => {
    fixture = signedFixture();
    const module = await Test.createTestingModule({
      imports: [AppModule.register(fixture.config)],
    })
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
  it.each(['POST', 'PATCH'] as const)(
    'caps %s profile writes before parsing/auth, including case/query/trailing slash and chunked bytes',
    async (method) => {
      const target =
        method === 'POST'
          ? '/API/V1/MONITORING-PROFILES/00000000-0000-4000-8000-000000000006/VeRsIoNs/?q=x'
          : '/API/V1/PROFILE-VERSIONS/00000000-0000-4000-8000-000000000006/?q=x';
      const body = '{}' + ' '.repeat(65535); // 65537 raw UTF8 bytes, below unchanged general 128KiB cap.
      const http = request(app.getHttpServer());
      const reply = await (
        method === 'POST' ? http.post(target) : http.patch(target)
      )
        .set('Content-Type', 'application/json')
        .send(body);
      await app.listen(0, '127.0.0.1');
      const address = app.getHttpServer().address();
      const status = await new Promise<number>((resolve, reject) => {
        const req = nativeRequest(
          {
            hostname: '127.0.0.1',
            port: address.port,
            path: target,
            method,
            headers: {
              'Content-Type': 'application/json',
              'Transfer-Encoding': 'chunked',
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode!));
          },
        );
        req.on('error', reject);
        req.write(body.slice(0, 32000));
        req.end(body.slice(32000));
      });
      expect([reply.status, status]).toEqual([413, 413]);
      const invalid = JSON.stringify({
        config: { ...base, interval_seconds: 4 },
      });
      const exact = invalid + ' '.repeat(65536 - Buffer.byteLength(invalid));
      const token = await fixture.sign({
        role: 'Admin',
        method,
        target,
        body: exact,
      });
      const under = request(app.getHttpServer());
      const accepted = await (
        method === 'POST' ? under.post(target) : under.patch(target)
      )
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send(exact);
      expect(accepted.status).toBe(400); // Exactly64KiB reaches schema validation, not413.
      const utf8 = JSON.stringify({ x: '漢'.repeat(22000) });
      expect(utf8.length < 65536 && Buffer.byteLength(utf8) > 65536).toBe(true);
      const bytes = request(app.getHttpServer());
      expect(
        (
          await (method === 'POST' ? bytes.post(target) : bytes.patch(target))
            .set('Content-Type', 'application/json')
            .send(utf8)
        ).status,
      ).toBe(413);
    },
  );
  it.each([4, 301, 15.5, 9007199254740992])(
    'rejects invalid interval %s before persistence',
    async (interval) => {
      const target =
        '/api/v1/monitoring-profiles/00000000-0000-4000-8000-000000000006/versions';
      const body = JSON.stringify({
        config: {
          schema_version: 1,
          os: 'linux',
          interval_seconds: interval,
          metric_groups: { cpu: true, memory: true, disk: true, network: true },
          options: {},
        },
      });
      const token = await fixture.sign({
        role: 'Admin',
        method: 'POST',
        target,
        body,
      });
      const result = await request(app.getHttpServer())
        .post(target)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send(body);
      expect(result.status).toBe(400);
    },
  );
});
