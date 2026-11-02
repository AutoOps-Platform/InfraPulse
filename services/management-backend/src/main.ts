import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createManagementApp } from './bootstrap.js';
import { loadConfig } from './config/config.js';
import { SafeLogger } from './common/safe-logger.js';
import { startAgentTls } from './agent-tls.js';
import type { Server } from 'node:https';

export async function main(): Promise<void> {
  const logger = new SafeLogger();
  try {
    const config = loadConfig(process.env);
    const app = await createManagementApp(config);
    let agentTls: Server | undefined;
    try {
      await app.listen(config.PORT);
      agentTls = await startAgentTls(app, process.env);
      let stopping = false;
      const stop = (): void => {
        if (stopping) return;
        stopping = true;
        agentTls?.close();
        agentTls?.closeAllConnections();
        void app.close().catch(() => { process.exitCode = 1; });
      };
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
      logger.event('startup_ready');
    } catch {
      try {
        agentTls?.close();
        agentTls?.closeAllConnections();
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

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
