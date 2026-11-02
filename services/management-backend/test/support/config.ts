import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

export function configFixture() {
  const root = resolve(
    '../../.superpowers/sdd/2026-10-31-management-backend/private-fixtures',
  );
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'task-1-'));
  const databaseSentinel =
    'postgresql://runtime:URL_SENTINEL@127.0.0.1/infrapulse?schema=management';
  const privateSentinel =
    '-----BEGIN PRIVATE KEY-----\nPRIVATE_SENTINEL\n-----END PRIVATE KEY-----';
  const publicKey = generateKeyPairSync('ed25519')
    .publicKey.export({ type: 'spki', format: 'pem' })
    .toString();
  const trust = {
    lab: {
      public_key_pem: publicKey,
      issuer: 'lab',
      audience: 'management',
      subject: 'fixture',
      scopes: ['credentials:verify'],
    },
  };
  const serviceTrust = {
    gateway: {
      public_key_pem: generateKeyPairSync('ed25519')
        .publicKey.export({ type: 'spki', format: 'pem' })
        .toString(),
      issuer: 'fixture-gateway',
      audience: 'fixture-internal',
      subject: 'fixture-gateway-id',
      scopes: ['credentials:verify'],
    },
  };
  const file = (name: string, text: string) => {
    const path = join(directory, name);
    writeFileSync(path, text, { encoding: 'utf8', mode: 0o600 });
    return path;
  };
  const env: NodeJS.ProcessEnv = {
    MANAGEMENT_DATABASE_URL_FILE: file('runtime-url', databaseSentinel),
    MANAGEMENT_ADMIN_TRUST_FILE: file(
      'admin-public.json',
      JSON.stringify(trust),
    ),
    MANAGEMENT_SERVICE_TRUST_FILE: file(
      'service-public.json',
      JSON.stringify(serviceTrust),
    ),
    MANAGEMENT_GRAFANA_CONTEXT: 'fixture-grafana',
  };
  return {
    env,
    directory,
    file,
    trust,
    databaseSentinel,
    privateSentinel,
    cleanup: () => rmSync(directory, { recursive: true }),
  };
}

// Counts only: assertion output must never render supplied sensitive values.
export function countLeaks(text: string, values: readonly string[]): number {
  return values.reduce(
    (count, value) => count + (value ? text.split(value).length - 1 : 0),
    0,
  );
}
