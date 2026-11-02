import request from 'supertest';
import { createManagementApp } from './bootstrap.js';
import { signedFixture } from '../test/support/keys.js';

describe('AppController protected identity replaces the scaffold root', () => {
  it('requires an assertion instead of serving an anonymous Hello World', async () => {
    const fixture = signedFixture();
    const app = await createManagementApp(fixture.config);
    try {
      await app.init();
      expect(
        (await request(app.getHttpServer()).get('/api/v1/me')).status,
      ).toBe(401);
      expect((await request(app.getHttpServer()).get('/')).status).toBe(404);
    } finally {
      await app.close();
      fixture.cleanup();
    }
  });
});
