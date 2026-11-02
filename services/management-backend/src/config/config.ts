import { isIP } from 'node:net';
import { parseStrictJson } from '../common/http-boundary.js';
import { readSecretFile } from './secret-files.js';

export interface TrustEntry {
  readonly public_key_pem: string;
  readonly issuer: string;
  readonly audience: string;
  readonly subject?: string;
  readonly scopes?: readonly string[];
}
export type TrustMap = Readonly<Record<string, TrustEntry>>;
export interface ManagementConfig {
  readonly PORT: number;
  readonly MANAGEMENT_HOST_PORT: number;
  readonly MANAGEMENT_DATABASE_URL_FILE: string;
  readonly MANAGEMENT_ADMIN_TRUST_FILE: string;
  readonly MANAGEMENT_SERVICE_TRUST_FILE: string;
  readonly MANAGEMENT_GRAFANA_CONTEXT: string;
  readonly MANAGEMENT_AGENT_INGEST_BASE_URL: string;
  readonly MANAGEMENT_LOG_LEVEL: 'INFO' | 'WARN' | 'ERROR';
  readonly MANAGEMENT_REQUEST_RATE_PER_SECOND: number;
  readonly MANAGEMENT_REQUEST_BURST: number;
  readonly MANAGEMENT_DB_POOL_MAX: number;
  readonly MANAGEMENT_DB_POOL_TIMEOUT_MS: number;
  readonly MANAGEMENT_NONCE_MAX_ENTRIES: number;
  readonly databaseUrl: string;
  readonly adminTrust: TrustMap;
  readonly serviceTrust: TrustMap;
}

function text(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}
function trustFile(path: string): TrustMap {
  const parsed = parseStrictJson(Buffer.from(readSecretFile(path)));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error();
  const entries = Object.entries(parsed);
  if (entries.length < 1 || entries.length > 8) throw new Error();
  const result: Record<string, TrustEntry> = Object.create(null) as Record<
    string,
    TrustEntry
  >;
  for (const [kid, candidate] of entries) {
    if (
      !/^[A-Za-z0-9._-]{1,64}$/.test(kid) ||
      !candidate ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate)
    )
      throw new Error();
    const entry = candidate as Record<string, unknown>;
    if (
      Object.keys(entry).some(
        (key) =>
          ![
            'public_key_pem',
            'issuer',
            'audience',
            'subject',
            'scopes',
          ].includes(key),
      )
    )
      throw new Error();
    if (
      typeof entry.public_key_pem !== 'string' ||
      !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PUBLIC KEY-----\r?\n?$/.test(
        entry.public_key_pem,
      )
    )
      throw new Error();
    if (
      !text(entry.issuer) ||
      !text(entry.audience) ||
      (entry.subject !== undefined && !text(entry.subject))
    )
      throw new Error();
    if (
      entry.scopes !== undefined &&
      (!Array.isArray(entry.scopes) ||
        entry.scopes.some((scope) => !text(scope)))
    )
      throw new Error();
    // Signature/key/claim semantics belong to T3; T1 fixes shape and no-private material.
    result[kid] = Object.freeze({
      public_key_pem: entry.public_key_pem,
      issuer: entry.issuer,
      audience: entry.audience,
      ...(entry.subject !== undefined
        ? { subject: entry.subject as string }
        : {}),
      ...(entry.scopes !== undefined
        ? { scopes: Object.freeze([...(entry.scopes as string[])]) }
        : {}),
    });
  }
  return Object.freeze(result);
}

function isLabHost(hostname: string): boolean {
  const host = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  if (host === 'localhost' || host === '::1') return true;
  if (isIP(host) === 4) {
    const [first, second] = host.split('.').map(Number);
    return (
      first === 127 ||
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }
  if (isIP(host) === 6)
    return (Number.parseInt(host.split(':')[0], 16) & 0xfe00) === 0xfc00;
  return false;
}

export function loadConfig(env: NodeJS.ProcessEnv): ManagementConfig {
  try {
    function required(name: string): string {
      const value = env[name];
      if (!text(value)) throw new Error();
      return value;
    }
    function number(
      name: string,
      fallback: number,
      minimum: number,
      maximum: number,
      integer = true,
    ): number {
      const raw = env[name];
      if (raw !== undefined && !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw))
        throw new Error();
      const value = raw === undefined ? fallback : Number(raw);
      if (
        !Number.isFinite(value) ||
        (integer && !Number.isInteger(value)) ||
        value < minimum ||
        value > maximum
      )
        throw new Error();
      return value;
    }
    const databasePath = required('MANAGEMENT_DATABASE_URL_FILE');
    const adminPath = required('MANAGEMENT_ADMIN_TRUST_FILE');
    const servicePath = required('MANAGEMENT_SERVICE_TRUST_FILE');
    const databaseUrl = readSecretFile(databasePath);
    const database = new URL(databaseUrl);
    if (
      !['postgres:', 'postgresql:'].includes(database.protocol) ||
      !database.hostname ||
      !database.username ||
      !database.pathname.slice(1) ||
      /[\u0000-\u0020\u007f]/u.test(databaseUrl) ||
      database.hash
    )
      throw new Error();
    const ingestBase =
      env.MANAGEMENT_AGENT_INGEST_BASE_URL ?? 'http://127.0.0.1:8000';
    const authority = /^https?:\/\/([^/?#]+)\/?$/i.exec(ingestBase)?.[1];
    if (!authority || /[@\\\s]/u.test(authority) || !text(ingestBase))
      throw new Error();
    const ingest = new URL(ingestBase);
    if (
      !['http:', 'https:'].includes(ingest.protocol) ||
      !ingest.hostname ||
      ingest.username ||
      ingest.password ||
      ingest.search ||
      ingest.hash ||
      ingest.pathname !== '/'
    )
      throw new Error();
    if (ingest.protocol === 'http:' && !isLabHost(ingest.hostname))
      throw new Error();
    const level = env.MANAGEMENT_LOG_LEVEL ?? 'INFO';
    if (!['INFO', 'WARN', 'ERROR'].includes(level)) throw new Error();
    const rate = number(
      'MANAGEMENT_REQUEST_RATE_PER_SECOND',
      20,
      0,
      1000,
      false,
    );
    if (rate === 0) throw new Error();
    return Object.freeze({
      PORT: number('PORT', 3000, 1, 65535),
      MANAGEMENT_HOST_PORT: number('MANAGEMENT_HOST_PORT', 3001, 1, 65535),
      MANAGEMENT_DATABASE_URL_FILE: databasePath,
      MANAGEMENT_ADMIN_TRUST_FILE: adminPath,
      MANAGEMENT_SERVICE_TRUST_FILE: servicePath,
      MANAGEMENT_GRAFANA_CONTEXT: required('MANAGEMENT_GRAFANA_CONTEXT'),
      MANAGEMENT_AGENT_INGEST_BASE_URL: ingest.origin,
      MANAGEMENT_LOG_LEVEL: level as ManagementConfig['MANAGEMENT_LOG_LEVEL'],
      MANAGEMENT_REQUEST_RATE_PER_SECOND: rate,
      MANAGEMENT_REQUEST_BURST: number(
        'MANAGEMENT_REQUEST_BURST',
        40,
        1,
        10000,
      ),
      MANAGEMENT_DB_POOL_MAX: number('MANAGEMENT_DB_POOL_MAX', 10, 1, 64),
      MANAGEMENT_DB_POOL_TIMEOUT_MS: number(
        'MANAGEMENT_DB_POOL_TIMEOUT_MS',
        1000,
        1,
        1000,
      ),
      MANAGEMENT_NONCE_MAX_ENTRIES: number(
        'MANAGEMENT_NONCE_MAX_ENTRIES',
        20000,
        1,
        20000,
      ),
      databaseUrl,
      adminTrust: trustFile(adminPath),
      serviceTrust: trustFile(servicePath),
    });
  } catch {
    throw new Error('Invalid management configuration.');
  }
}
