import { createServer, type Server } from 'node:https';
import type { RequestListener } from 'node:http';
import { isIP } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { readSecretFile } from './config/secret-files.js';

// Optional Agent-facing TLS listener. Internal signed Gateway RPC and existing
// loopback health checks keep using the unchanged HTTP listener. No TLS proxy.
export async function startAgentTls(
  app: INestApplication,
  env: NodeJS.ProcessEnv,
): Promise<Server | undefined> {
  const names = [
    'MANAGEMENT_AGENT_TLS_CERT_FILE',
    'MANAGEMENT_AGENT_TLS_KEY_FILE',
    'MANAGEMENT_AGENT_TLS_PORT',
    'MANAGEMENT_AGENT_TLS_BIND',
  ] as const;
  if (names.every((name) => env[name] === undefined)) return undefined;
  let server: Server | undefined;
  try {
    const cert = readSecretFile(env.MANAGEMENT_AGENT_TLS_CERT_FILE ?? '');
    const key = readSecretFile(env.MANAGEMENT_AGENT_TLS_KEY_FILE ?? '');
    const rawPort = env.MANAGEMENT_AGENT_TLS_PORT ?? '3443';
    const bind = env.MANAGEMENT_AGENT_TLS_BIND ?? '127.0.0.1';
    if (
      !/^[1-9]\d{0,4}$/.test(rawPort) ||
      Number(rawPort) > 65535 ||
      !isIP(bind)
    ) throw new Error();
    const handler = app.getHttpAdapter().getInstance() as RequestListener;
    server = createServer({ cert, key, minVersion: 'TLSv1.2' }, (req, res) => {
      // Do not expose admin, OpenAPI or internal RPC through the public listener.
      if (
        (req.method === 'GET' && req.url === '/api/v1/agent/provisioning') ||
        (req.method === 'POST' && req.url === '/api/v1/agent/config-reports')
      ) {
        handler(req, res);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end('{"code":"not_found"}');
      }
    });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    server.keepAliveTimeout = 5000;
    server.maxHeadersCount = 64;
    const listener = server;
    await new Promise<void>((resolve, reject) => {
      const failed = (): void => reject(new Error('Agent TLS startup failed.'));
      listener.once('error', failed);
      listener.listen(Number(rawPort), bind, () => {
        listener.removeListener('error', failed);
        resolve();
      });
    });
    // Never propagate certificate paths, request headers or native error text.
    listener.on('error', () => {});
    return listener;
  } catch {
    server?.close();
    throw new Error('Agent TLS startup failed.');
  }
}
