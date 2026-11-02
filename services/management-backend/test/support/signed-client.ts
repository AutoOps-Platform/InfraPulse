import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { signedFixture } from './keys.js';
export function signedClient(
  app: INestApplication,
  fixture: ReturnType<typeof signedFixture>,
) {
  return {
    as(role: 'Viewer' | 'Editor' | 'Admin') {
      return {
        async get(target: string): Promise<request.Response> {
          return request(app.getHttpServer())
            .get(target)
            .set(
              'Authorization',
              `Bearer ${await fixture.sign({ role, target })}`,
            );
        },
        async post(
          target: string,
          payload: unknown,
        ): Promise<request.Response> {
          const body = JSON.stringify(payload);
          return request(app.getHttpServer())
            .post(target)
            .set('Content-Type', 'application/json')
            .set(
              'Authorization',
              `Bearer ${await fixture.sign({ role, method: 'POST', target, body })}`,
            )
            .send(body);
        },
      };
    },
  };
}
