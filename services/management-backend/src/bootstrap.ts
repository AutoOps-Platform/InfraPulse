import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from './app.module.js';
import type { ManagementConfig } from './config/config.js';
import { installHttpBoundary } from './common/http-boundary.js';
import { installOpenApi } from './common/openapi.js';

// Construction never listens, connects to DB or migrates. Local public trust is validated.
export async function createManagementApp(
  config: ManagementConfig,
): Promise<INestApplication> {
  let app: INestApplication | undefined;
  try {
    app = await NestFactory.create(AppModule.register(config), {
      bodyParser: false,
      logger: false,
      abortOnError: false,
    });
    installHttpBoundary(app, config);
    installOpenApi(app);
    return app;
  } catch {
    try {
      await app?.close();
    } catch {
      /* Do not expose nested startup errors. */
    }
    throw new Error('Management startup failed.');
  }
}
