import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createManagementApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config/config.js';
import { configFixture } from './support/config.js';
import { admin, identity } from './support/db.js';

describe('in-process HTTP and isolated database readiness', () => {
  let app: INestApplication;
  let fixture: ReturnType<typeof configFixture>;
  beforeAll(async () => {
    fixture = configFixture();
    app = await createManagementApp(
      loadConfig({
        ...fixture.env,
        MANAGEMENT_DATABASE_URL_FILE: identity().runtimeFile,
      }),
    );
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
    fixture?.cleanup();
  });
  it('liveness and actual schema/role readiness are healthy', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200);
    await request(app.getHttpServer()).get('/health/ready').expect(200);
  });
  it('identity is protected and the anonymous scaffold root is not exposed', async () => {
    await request(app.getHttpServer()).get('/api/v1/me').expect(401);
    await request(app.getHttpServer()).get('/').expect(404);
  });
  it('wrong role and absent schema fail closed without implicit migration', async () => {
    const other = await createManagementApp(
      loadConfig({
        ...fixture.env,
        MANAGEMENT_DATABASE_URL_FILE: identity().ownerFile,
      }),
    );
    try {
      await other.init();
      await request(other.getHttpServer()).get('/health/ready').expect(503);
    } finally {
      await other.close();
    }
    const client = await admin();
    try {
      await client.query(
        'ALTER TABLE management.request_nonces RENAME TO request_nonces_unavailable',
      );
      // A table count alone cannot attest the expected schema.
      await request(app.getHttpServer()).get('/health/ready').expect(503);
      await request(app.getHttpServer()).get('/health/live').expect(200);
    } finally {
      await client.query(
        'ALTER TABLE management.request_nonces_unavailable RENAME TO request_nonces',
      );
      await client.end();
    }
    await request(app.getHttpServer()).get('/health/ready').expect(200);
  });
});
