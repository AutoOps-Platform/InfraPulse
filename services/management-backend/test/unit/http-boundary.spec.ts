import { Body, Controller, Get, Module, Post, Req } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { IsDefined, IsInt, IsString, MaxLength, Min } from 'class-validator';
import request from 'supertest';
import type { Request } from 'express';
import { request as httpRequest } from 'node:http';
import {
  parseStrictJson,
  installHttpBoundary,
} from '../../src/common/http-boundary.js';
import { ApiError } from '../../src/common/errors.js';
import type { ApiCode } from '../../src/common/errors.js';
import { loadConfig } from '../../src/config/config.js';
import { createManagementApp } from '../../src/bootstrap.js';
import { configFixture, countLeaks } from '../support/config.js';
import { TestClock } from '../support/clock.js';

class Input {
  @IsDefined() @IsString() @MaxLength(32) name!: string;
  @IsDefined() @IsInt() @Min(1) count!: number;
}
const sentinel = 'PRIVATE_URL_SENTINEL';
let held: (() => void)[] = [];
let admitted: ((req: Request) => void) | undefined;
@Controller()
class BoundaryController {
  @Post('input') input(
    @Body() body: Input,
    @Req() req: Request & { rawBody: Buffer },
  ) {
    return { body, raw: req.rawBody.toString('utf8') };
  }
  @Get('fail') fail() {
    throw new Error(sentinel);
  }
  @Get('hold') async hold(@Req() req: Request) {
    const pending = new Promise<void>((resolve) => held.push(resolve));
    admitted?.(req);
    await pending;
    return { ok: true };
  }
}
@Module({ controllers: [BoundaryController] })
class BoundaryModule {}

describe('finite error contract', () => {
  it.each<[ApiCode, number]>([
    ['invalid_request', 400],
    ['unauthorized', 401],
    ['forbidden', 403],
    ['not_found', 404],
    ['conflict', 409],
    ['payload_too_large', 413],
    ['rate_limited', 429],
    ['dependency_unavailable', 503],
    ['audit_unavailable', 503],
    ['internal_error', 500],
    ['provisioning_not_ready', 409],
    ['profile_not_provisioned', 409],
    ['secret_already_issued', 409],
  ])('maps %s to finite HTTP status', (code, status) => {
    expect(new ApiError(code).status).toBe(status);
  });
});

describe('strict raw JSON', () => {
  it('preserves valid JSON meaning including nested independent property names', () => {
    expect(
      parseStrictJson(Buffer.from('{ "a":1,"nested":{"a":2},"text":"✓" }')),
    ).toEqual({ a: 1, nested: { a: 2 }, text: '✓' });
  });
  it.each([
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '{"a":{"b":1,"b":2}}',
    '{/*x*/"a":1}',
    '{"a":1,}',
    '{"__proto__":1}',
    '{"nested":{"constructor":1}}',
    '{"prototype":1}',
    '{',
    'true false',
    '{"n":1e999}',
  ])('rejects ambiguous, unsafe or malformed JSON %#', (raw) => {
    expect(() => parseStrictJson(Buffer.from(raw))).toThrow(ApiError);
  });
  it('permits legitimate credential syntax without logging or globally interpreting metadata', () => {
    const parsed = parseStrictJson(
      Buffer.from(JSON.stringify({ api_key: sentinel })),
    ) as { api_key: string };
    expect(parsed.api_key === sentinel).toBe(true);
  });
  it('rejects malformed UTF8 rather than replacing bytes', () => {
    expect(() =>
      parseStrictJson(
        Buffer.from([123, 34, 120, 34, 58, 34, 0xc0, 0xaf, 34, 125]),
      ),
    ).toThrow(ApiError);
  });
});

describe('bounded real HTTP foundation', () => {
  let app: INestApplication;
  let fixture: ReturnType<typeof configFixture>;
  const clock = new TestClock();
  async function start(rate = '1000', burst = '10000') {
    fixture = configFixture();
    const config = loadConfig({
      ...fixture.env,
      MANAGEMENT_REQUEST_RATE_PER_SECOND: rate,
      MANAGEMENT_REQUEST_BURST: burst,
    });
    app = await NestFactory.create(BoundaryModule, {
      bodyParser: false,
      logger: false,
      abortOnError: false,
    });
    installHttpBoundary(app, config, clock);
    await app.init();
    return app.getHttpServer();
  }
  afterEach(async () => {
    held.splice(0).forEach((resolve) => resolve());
    admitted = undefined;
    await app?.close();
    fixture?.cleanup();
  });

  it('retains exact raw bytes and validates explicit primitive DTOs', async () => {
    const server = await start();
    const raw = '{ "count": 2, "name":"test" }';
    const response = await request(server)
      .post('/input')
      .set('Content-Type', 'application/json')
      .send(raw)
      .expect(201);
    expect(response.body).toEqual({ body: { count: 2, name: 'test' }, raw });
    for (const value of [
      { count: '2', name: 'test' },
      { count: 2, name: 3 },
      { count: 2, name: 'test', extra: true },
      { count: 2 },
    ]) {
      await request(server).post('/input').send(value).expect(400);
    }
  });
  it('sanitizes malformed JSON, unknown exceptions and invalid request IDs', async () => {
    const server = await start();
    for (const response of [
      await request(server)
        .post('/input')
        .set('Content-Type', 'application/json')
        .send(`{"password":"${sentinel}",`),
      await request(server).get('/fail').set('x-request-id', sentinel),
    ]) {
      expect([400, 500]).toContain(response.status);
      expect(Object.keys(response.body).sort()).toEqual([
        'code',
        'message',
        'request_id',
      ]);
      expect(response.body.request_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(
        countLeaks(response.text, [sentinel, fixture.databaseSentinel]),
      ).toBe(0);
    }
    const missing = await request(server).get('/missing').expect(404);
    expect(missing.body.code).toBe('not_found');
  });
  it('rejects the 128KiB body cap before DTO handling', async () => {
    const server = await start();
    const response = await request(server)
      .post('/input')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ name: 'x'.repeat(128 * 1024), count: 2 }))
      .expect(413);
    expect(response.body.code).toBe('payload_too_large');
  });
  it('rate limits before parsing and uses monotonic non-sliding refill', async () => {
    const server = await start('1', '2');
    await request(server).get('/missing').expect(404);
    await request(server).get('/missing').expect(404);
    await request(server)
      .post('/input')
      .set('Content-Type', 'application/json')
      .send('{')
      .expect(429);
    clock.setWall(100000000);
    await request(server).get('/missing').expect(429);
    clock.advance(1000);
    await request(server).get('/missing').expect(404);
    await request(server).get('/missing').expect(429);
  });
  it('admits at most sixteen handlers without queueing and releases on finish', async () => {
    const server = await start();
    // One explicit ephemeral listener: concurrent Supertest auto-listens otherwise
    // attach competing lifecycle listeners to the same initially-unbound server.
    await app.listen(0, '127.0.0.1');
    let reachCapacity!: () => void;
    const capacity = new Promise<void>((resolve) => {
      reachCapacity = resolve;
    });
    admitted = () => {
      if (held.length === 16) reachCapacity();
    };
    const pending = Array.from({ length: 16 }, () =>
      request(server)
        .get('/hold')
        .then((response) => response.status),
    );
    await capacity;
    await request(server).get('/missing').expect(429);
    held.splice(0).forEach((resolve) => resolve());
    expect(await Promise.all(pending)).toEqual(Array(16).fill(200));
    await request(server).get('/missing').expect(404);
  });
  it('releases admission on client close, without double releasing at finish', async () => {
    const server = await start();
    await app.listen(0, '127.0.0.1');
    let atCapacity!: () => void;
    let closed!: () => void;
    const capacity = new Promise<void>((resolve) => {
      atCapacity = resolve;
    });
    const clientClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    admitted = (req) => {
      if (req.headers['x-test-cancel'] === 'yes')
        req.res!.once('close', closed);
      if (held.length === 16) atCapacity();
    };
    const pending = Array.from({ length: 15 }, () =>
      request(server)
        .get('/hold')
        .then((response) => response.status),
    );
    const client = httpRequest({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: '/hold',
      headers: { 'x-test-cancel': 'yes' },
    });
    client.on('error', () => {
      /* Expected local client cancellation only. */
    });
    client.end();
    await capacity;
    await request(server).get('/missing').expect(429);
    client.destroy();
    await clientClosed;
    await request(server).get('/missing').expect(404);
    held.splice(0).forEach((resolve) => resolve());
    expect(await Promise.all(pending)).toEqual(Array(15).fill(200));
  });
  it('caps chunked body bytes even without a Content-Length header', async () => {
    const server = await start();
    await app.listen(0, '127.0.0.1');
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port: server.address().port,
          method: 'POST',
          path: '/input',
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.write(Buffer.alloc(128 * 1024, 32));
      req.end('x');
    });
    expect(status).toBe(413);
  });
  it('ends a slow body after the five second deadline', async () => {
    const server = await start();
    await app.listen(0, '127.0.0.1');
    const address = server.address();
    const response = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const req = httpRequest(
          {
            hostname: '127.0.0.1',
            port: address.port,
            method: 'POST',
            path: '/input',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': '100',
            },
          },
          (res) => {
            let body = '';
            res.on('data', (chunk) => {
              body += String(chunk);
            });
            res.on('end', () => {
              req.destroy();
              resolve({ status: res.statusCode ?? 0, body });
            });
          },
        );
        req.on('error', reject);
        req.write('{');
      },
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).code).toBe('invalid_request');
  }, 10000);
  it('factory does not listen and health is minimal, no-IO, readiness fail-closed', async () => {
    fixture = configFixture();
    app = await createManagementApp(
      loadConfig({ ...fixture.env, MANAGEMENT_REQUEST_BURST: '1' }),
    );
    expect(app.getHttpServer().listening).toBe(false);
    await app.init();
    const server = app.getHttpServer();
    const denied = await request(server).get('/api/v1/me').expect(401);
    expect(denied.body.code).toBe('unauthorized');
    await request(server).get('/api/v1/me').expect(429);
    expect(
      (await request(server).get('/health/live').expect(200)).body,
    ).toEqual({ status: 'ok' });
    const ready = await request(server).get('/health/ready').expect(503);
    expect(ready.body.code).toBe('dependency_unavailable');
    expect(countLeaks(ready.text, [fixture.databaseSentinel])).toBe(0);
  });
});
