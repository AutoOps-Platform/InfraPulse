import request from 'supertest';
import { createManagementApp } from '../../src/bootstrap.js';
import { signedFixture } from '../support/keys.js';
import { identity, admin } from '../support/db.js';
import { DatabaseService } from '../../src/database/database.service.js';
import { NonceService } from '../../src/auth/nonce.service.js';
import { randomUUID } from 'node:crypto';
import { readTestUrl } from '../support/pg-harness.js';

describe('real PostgreSQL nonce uniqueness, expiry and global cap serialization', () => {
  let fixture: ReturnType<typeof signedFixture>;
  let database: DatabaseService;
  let nonces: NonceService;
  beforeEach(async () => {
    fixture = signedFixture();
    database = new DatabaseService({
      ...fixture.config,
      databaseUrl: readTestUrl(identity().runtimeFile),
    });
    nonces = new NonceService(database);
    const client = await admin();
    try {
      await client.query('DELETE FROM management.request_nonces');
    } finally {
      await client.end();
    }
  });
  afterEach(async () => {
    await database.onModuleDestroy();
    fixture.cleanup();
  });
  it('keeps exactly 20000 live entries and rejects one of two concurrent final-slot reservations', async () => {
    const client = await admin();
    try {
      await client.query(
        "INSERT INTO management.request_nonces(issuer,jti,expires_at) SELECT 'cap', md5(i::text)::uuid::text, clock_timestamp()+interval '60 seconds' FROM generate_series(1,19999) i",
      );
    } finally {
      await client.end();
    }
    const outcomes = await Promise.allSettled([
      nonces.reserve('cap', randomUUID(), new Date(Date.now() + 60_000)),
      nonces.reserve('cap', randomUUID(), new Date(Date.now() + 60_000)),
    ]);
    const check = await admin();
    try {
      const result = await check.query(
        'SELECT count(*)::int AS live FROM management.request_nonces WHERE expires_at > clock_timestamp()',
      );
      expect({
        live: result.rows[0].live,
        rejected: outcomes.filter((outcome) => outcome.status === 'rejected')
          .length,
      }).toEqual({ live: 20000, rejected: 1 });
      const rejected = outcomes.find(
        (outcome) => outcome.status === 'rejected',
      );
      expect(rejected?.status === 'rejected' && rejected.reason.code).toBe(
        'dependency_unavailable',
      );
    } finally {
      await check.end();
    }
  });
  it('gives exactly one success for concurrent identical issuer/jti reservations', async () => {
    const jti = randomUUID();
    const outcomes = await Promise.allSettled([
      nonces.reserve('race', jti, new Date(Date.now() + 60_000)),
      nonces.reserve('race', jti, new Date(Date.now() + 60_000)),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason.code).toBe(
      'unauthorized',
    );
  });
  it('persists exp plus five seconds and removes expired rows, without evicting live entries', async () => {
    const client = await admin();
    try {
      await client.query(
        "INSERT INTO management.request_nonces VALUES ('expired','old',clock_timestamp()-interval '1 second')",
      );
    } finally {
      await client.end();
    }
    const exp = new Date(Date.now() + 60_000);
    const jti = randomUUID();
    await nonces.reserve('retention', jti, exp);
    const check = await admin();
    try {
      expect(
        (
          await check.query(
            "SELECT count(*)::int AS n FROM management.request_nonces WHERE issuer='expired'",
          )
        ).rows[0].n,
      ).toBe(0);
      const stored = await check.query(
        'SELECT expires_at FROM management.request_nonces WHERE issuer=$1 AND jti=$2',
        ['retention', jti],
      );
      expect(stored.rows[0].expires_at.getTime()).toBe(exp.getTime() + 5000);
    } finally {
      await check.end();
    }
  });
  it('fails closed on real missing nonce table, with a finite dependency error', async () => {
    const client = await admin();
    try {
      await client.query(
        'ALTER TABLE management.request_nonces RENAME TO request_nonces_task3_unavailable',
      );
      try {
        await expect(
          nonces.reserve(
            'db-failure',
            randomUUID(),
            new Date(Date.now() + 60_000),
          ),
        ).rejects.toMatchObject({
          code: 'dependency_unavailable',
          status: 503,
        });
      } finally {
        await client.query(
          'ALTER TABLE management.request_nonces_task3_unavailable RENAME TO request_nonces',
        );
      }
    } finally {
      await client.end();
    }
  });
});

describe('nonce survives application restart with same PostgreSQL database', () => {
  it('rejects the exact assertion after closing and recreating the app', async () => {
    const fixture = signedFixture();
    const config = {
      ...fixture.config,
      databaseUrl: readTestUrl(identity().runtimeFile),
    };
    const token = await fixture.sign();
    let app = await createManagementApp(config);
    try {
      await app.init();
      expect(
        (
          await request(app.getHttpServer())
            .get('/api/v1/me')
            .set('Authorization', `Bearer ${token}`)
        ).status,
      ).toBe(200);
      await app.close();
      app = await createManagementApp(config);
      await app.init();
      expect(
        (
          await request(app.getHttpServer())
            .get('/api/v1/me')
            .set('Authorization', `Bearer ${token}`)
        ).status,
      ).toBe(401);
    } finally {
      await app.close();
      fixture.cleanup();
    }
  });
});
