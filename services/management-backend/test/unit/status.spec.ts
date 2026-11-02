import {
  Controller,
  Module,
  Post,
  Req,
  type INestApplication,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { request as nativeRequest } from 'node:http';
import request from 'supertest';
import { installHttpBoundary } from '../../src/common/http-boundary.js';
import { loadConfig } from '../../src/config/config.js';
import { configFixture } from '../support/config.js';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { EpochOpenDto } from '../../src/status/status.dto.js';
import { createManagementApp } from '../../src/bootstrap.js';
import { managementOpenApi } from '../../src/common/openapi.js';

// Breaks caught: raw status caps selected too late or with a different route view,
// future/old-source clock substitution and negative inference without lookback.
@Controller()
class Echo {
  @Post(['internal/v1/status/epoch', 'internal/v1/status/reports', 'other'])
  echo(@Req() req: { originalUrl: string; rawBody: Buffer }) {
    return { target: req.originalUrl, bytes: req.rawBody.length };
  }
}
@Module({ controllers: [Echo] })
class BoundaryModule {}
describe('status pre-buffer HTTP caps', () => {
  let app: INestApplication;
  let fixture: ReturnType<typeof configFixture>;
  beforeEach(async () => {
    fixture = configFixture();
    app = await NestFactory.create(BoundaryModule, {
      bodyParser: false,
      logger: false,
    });
    installHttpBoundary(app, loadConfig(fixture.env));
    await app.listen(0, '127.0.0.1');
  });
  afterEach(async () => {
    await app.close();
    fixture.cleanup();
  });
  it.each(['/internal/v1/status/epoch', '/INTERNAL/v1/STATUS/reports/?q=1'])(
    'rejects fixed-length over64KiB before parsing %s',
    async (target) => {
      const r = await request(app.getHttpServer())
        .post(target)
        .set('Content-Type', 'application/json')
        .send(' '.repeat(65537));
      expect(r.status).toBe(413);
    },
  );
  it.each(['/internal/v1/status/reports', '/INTERNAL/V1/STATUS/epoch/?q=1'])(
    'rejects actual chunked over64KiB %s',
    async (target) => {
      const port = (app.getHttpServer().address() as { port: number }).port;
      const status = await new Promise<number>((resolve, reject) => {
        const req = nativeRequest(
          {
            hostname: '127.0.0.1',
            port,
            method: 'POST',
            path: target,
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
        req.write(' '.repeat(32768));
        req.end(' '.repeat(32769));
      });
      expect(status).toBe(413);
    },
  );
  it('preserves signed target/raw bytes and default128/verify8/profile64 distinctions', async () => {
    const target = '/INTERNAL/v1/STATUS/reports/?x=1';
    const raw = '{"x":"' + 'a'.repeat(65528) + '"}';
    expect(Buffer.byteLength(raw)).toBe(65536);
    const r = await request(app.getHttpServer())
      .post(target)
      .set('Content-Type', 'application/json')
      .send(raw);
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ target, bytes: 65536 });
    expect(
      (
        await request(app.getHttpServer())
          .post('/other')
          .send({ x: 'a'.repeat(70000) })
      ).status,
    ).toBe(201);
    expect(
      (
        await request(app.getHttpServer())
          .post('/internal/v1/credentials/verify')
          .send({ x: 'a'.repeat(8192) })
      ).status,
    ).toBe(413);
    expect(
      (
        await request(app.getHttpServer())
          .post('/api/v1/monitoring-profiles')
          .send({ x: 'a'.repeat(65536) })
      ).status,
    ).toBe(413);
  });
});

describe('generated status OpenAPI contract', () => {
  it('publishes truthful boot ordering and nested conservative inventory telemetry', async () => {
    const fixture = configFixture();
    const app = await createManagementApp(loadConfig(fixture.env));
    try {
      const document = managementOpenApi(app);
      const epoch = document.paths['/internal/v1/status/epoch']?.post?.description;
      const server = document.paths['/api/v1/servers/{id}']?.get?.description;
      expect(epoch).toContain('Rejects boot_started_at > DB now + 5s');
      expect(epoch).toContain('truthful delayed unseen boot is allowed');
      expect(epoch).toContain('unseen new boot must start strictly later than current');
      expect(epoch).toContain('Exact current boot retry preserves activation');
      expect(epoch).toContain('retired boot never reactivates');
      expect(server).toContain('Viewer/Operator/Admin inventory read');
      expect(server).toContain('nested conservative telemetry');
      expect(server).toContain('status_as_of');
      expect(server).toContain('Unknown when evidence is insufficient');
      expect(server).toContain('No-store');
    } finally {
      await app.close();
      fixture.cleanup();
    }
  });
});

describe('explicit RFC3339 status timestamp syntax', () => {
  it.each(['2026-11-01', '2026-11-01T12:00:00'])(
    'rejects timezone-less timestamp %s',
    (boot_started_at) => {
      const value = plainToInstance(EpochOpenDto, {
        boot_id: '11111111-1111-1111-1111-111111111111',
        boot_started_at,
        expected_epoch: 0,
      });
      expect(validateSync(value).length).toBeGreaterThan(0);
    },
  );
});

describe('pure conservative status evaluator', () => {
  let evaluate: (input: any) => any;
  const end = 1_800_000_000_000;
  const input = (age: number, extra = {}) => ({
    lifecycle: 'active',
    last_metric_seen_at: new Date(end - age),
    now: new Date(end + 10000),
    source: {
      boot_started_at: new Date(end - 600000),
      activated_at: new Date(end - 599000),
      snapshot_end: new Date(end),
      received_at: new Date(end + 1000),
      coverage_start: new Date(end - 500000),
      coverage_end: new Date(end),
      gap: false,
      pending_deadline: null,
    },
    ...extra,
  });
  beforeAll(async () => {
    const path = '../../src/status/status-evaluator.js';
    const module = await import(path).catch(() => ({}));
    evaluate = module.evaluateStatus;
  });
  it('exports the pure evaluation contract', () => {
    expect(typeof evaluate).toBe('function');
  });
  it.each([
    [0, 'Online'],
    [90000, 'Online'],
    [90001, 'Stale'],
    [300000, 'Stale'],
    [300001, 'Offline'],
  ])('classifies exact age %s at completed snapshot as %s', (age, status) => {
    expect(evaluate(input(age as number))).toMatchObject({
      status,
      status_as_of: new Date(end).toISOString(),
    });
  });
  it('never seen/inactive/no active/source missing remains honest', () => {
    expect(evaluate(input(0, { last_metric_seen_at: null }))).toMatchObject({
      status: 'Unknown',
      confidence_reason: 'never_seen',
    });
    expect(evaluate(input(0, { lifecycle: 'disabled' }))).toMatchObject({
      status: 'Unknown',
      confidence_reason: 'lifecycle_inactive',
    });
    expect(evaluate(input(0, { lifecycle: null }))).toMatchObject({
      status: 'Unknown',
      confidence_reason: 'no_active_agent',
    });
    expect(evaluate(input(0, { source: null }))).toMatchObject({
      status: 'Unknown',
    });
  });
  it('requires fresh source, snapshot and continuous90/300 lookback, not wall-clock age', () => {
    const x = input(90001);
    expect(
      evaluate({
        ...x,
        source: { ...x.source, coverage_start: new Date(end - 89999) },
      }).status,
    ).toBe('Unknown');
    expect(
      evaluate({
        ...input(300001),
        source: { ...x.source, coverage_start: new Date(end - 299999) },
      }).status,
    ).toBe('Unknown');
    expect(evaluate({ ...x, now: new Date(end + 30001) })).toMatchObject({
      status: 'Unknown',
      source_health: 'stale',
    });
    expect(
      evaluate({
        ...x,
        source: { ...x.source, received_at: new Date(end - 30001) },
      }).status,
    ).toBe('Unknown');
  });
  it('allows negative inference after restart only when new continuous lookback exists', () => {
    const x = input(500000);
    const source = {
      ...x.source,
      boot_started_at: new Date(end - 400000),
      activated_at: new Date(end - 399000),
      coverage_start: new Date(end - 350000),
    };
    expect(evaluate({ ...x, source })).toMatchObject({
      status: 'Offline',
      confidence_reason: 'continuous_300s',
    });
  });
  it('positive after boot can Online across a gap but older boot evidence cannot; expiry is not normal staging', () => {
    const x = input(1000);
    expect(
      evaluate({
        ...x,
        source: { ...x.source, gap: true, coverage_start: null },
      }).status,
    ).toBe('Online');
    expect(
      evaluate({
        ...x,
        source: {
          ...x.source,
          boot_started_at: new Date(end),
          activated_at: new Date(end),
        },
      }).status,
    ).toBe('Unknown');
    expect(
      evaluate({
        ...input(300001),
        source: { ...x.source, pending_deadline: new Date(end + 20000) },
      }).status,
    ).toBe('Offline');
    expect(
      evaluate({
        ...input(300001),
        source: { ...x.source, pending_deadline: new Date(end + 5000) },
      }).status,
    ).toBe('Unknown');
    expect(
      evaluate({ ...x, last_metric_seen_at: new Date(end + 1) }).status,
    ).toBe('Unknown');
  });
});
