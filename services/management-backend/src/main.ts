import 'reflect-metadata';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module.js';
import { SafeLogger } from './app/common/errors.js';
import { installHttpBoundary, installOpenApi } from './app/common/http.js';
import { MetricVerifier } from './app/modules/onboarding/services/metric-verifier.service.js';
import { ServersService } from './app/modules/servers/services/servers.service.js';
import { loadConfig, validateAwsConfig, type ManagementConfig } from './config/app.config.js';
import { AwsModule } from './integrations/aws/aws.module.js';
import {
  createQualifiedRuntime,
  type QualifiedRuntime,
} from './integrations/aws/qualified-runtime.js';

export async function createManagementApp(
  config: ManagementConfig,
  qualified?: QualifiedRuntime,
): Promise<INestApplication> {
  let app: INestApplication | undefined;
  try {
    if (config.aws && (!qualified || JSON.stringify(config.aws) !== JSON.stringify(qualified.config))) {
      throw new Error('Protected AWS runtime required.');
    }
    if (!config.aws && qualified) {
      throw new Error('Protected AWS runtime mismatch.');
    }

    const onboarding = qualified
      ? {
          awsModule: AwsModule.fromQualifiedPort(qualified.aws),
          accountId: qualified.config.accountId,
          region: qualified.config.region,
          verifier: new MetricVerifier(qualified.aws, qualified.manifest),
          bootstrapAssets: qualified.assets,
          bootstrapUrlTtlSeconds: qualified.config.bootstrapUrlTtlSeconds,
          command: qualified.command,
          presetMatches: qualified.presetMatches,
        }
      : undefined;

    app = await NestFactory.create(AppModule.register(config, onboarding), {
      bodyParser: false,
      logger: false,
      abortOnError: false,
    });

    if (qualified) {
      const servers = app.get(ServersService);
      servers.setBootstrapAssets(qualified.assets);
      servers.setAwsPort(qualified.aws);
    }
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

export async function main(): Promise<void> {
  const logger = new SafeLogger();
  try {
    try {
      validateAwsConfig(process.env);
    } catch {
      process.stderr.write('management_aws_context_required_or_invalid\n');
      throw new Error('Required AWS deployment context is missing or invalid.');
    }

    const config = loadConfig(process.env);
    if (!config.aws) {
      process.stderr.write('management_aws_context_required\n');
      throw new Error('Required AWS deployment context is missing.');
    }

    const qualified = await createQualifiedRuntime(process.env);
    const app = await createManagementApp(config, qualified);
    try {
      await app.listen(config.PORT);
      let stopping = false;
      const stop = (): void => {
        if (stopping) return;
        stopping = true;
        void app.close().catch(() => {
          process.exitCode = 1;
        });
      };
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
      logger.event('startup_ready');
    } catch {
      try {
        await app.close();
      } catch {
        /* Only the finite startup event escapes. */
      }
      throw new Error('Management startup failed.');
    }
  } catch {
    logger.event('startup_failed', { code: 'internal_error' });
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
