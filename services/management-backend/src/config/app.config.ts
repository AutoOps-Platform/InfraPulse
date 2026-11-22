import type { AgentRelease } from '../integrations/aws/release-config.js';
import { isSafeText, parseStrictJson } from '../app/common/pagination.js';
import { readSecretFile } from './secret-files.js';

export type { AgentRelease, PlatformRelease } from '../integrations/aws/release-config.js';

export interface AgentAvailability {
  available: boolean;
  configurationVersion: string | null;
  reason: 'ready' | 'release_missing';
}

export function agentAvailability(
  release: AgentRelease,
  platform: 'linux' | 'windows',
): AgentAvailability {
  const target = release.platforms[platform];
  return target
    ? { available: true, configurationVersion: target.revision, reason: 'ready' }
    : { available: false, configurationVersion: null, reason: 'release_missing' };
}

export interface AwsConfig {
  readonly region: 'ap-southeast-1';
  readonly accountId: '491333778094';
  readonly deploymentId: 'lab-20261118';
  readonly owner: 'caophi562005';
  readonly roleName: string;
  readonly eligibility: string;
  readonly namespace: 'InfraPulse/Lab';
  readonly ampEndpoint: string | null;
  readonly configDocument: string;
  readonly configVersion: string | null;
  readonly cleanupDocument: string;
  readonly cleanupVersion: string | null;
  readonly bootstrapBucket: string | null;
  readonly bootstrapUrlTtlSeconds: number;
  readonly maxActiveNodes: number;
  readonly maxConcurrentOnboarding: number;
  readonly metricsIntervalSeconds: 60;
  readonly activationTtlSeconds: 3600;
  readonly configDeadlineSeconds: 1800;
  readonly verifyDeadlineSeconds: 900;
}

export interface TrustEntry {
  readonly public_key_pem: string;
  readonly issuer: string;
  readonly audience: string;
  readonly subject?: string;
  readonly scopes?: readonly string[];
}

export type TrustMap = Readonly<Record<string, TrustEntry>>;

export interface ManagementConfig {
  readonly aws?: AwsConfig;
  readonly PORT: number;
  readonly MANAGEMENT_HOST_PORT: number;
  readonly MANAGEMENT_DATABASE_URL_FILE: string;
  readonly MANAGEMENT_ADMIN_TRUST_FILE: string;
  readonly MANAGEMENT_GRAFANA_CONTEXT: string;
  readonly MANAGEMENT_LOG_LEVEL: 'INFO' | 'WARN' | 'ERROR';
  readonly MANAGEMENT_REQUEST_RATE_PER_SECOND: number;
  readonly MANAGEMENT_REQUEST_BURST: number;
  readonly MANAGEMENT_DB_POOL_MAX: number;
  readonly MANAGEMENT_DB_POOL_TIMEOUT_MS: number;
  readonly MANAGEMENT_NONCE_MAX_ENTRIES: number;
  readonly databaseUrl: string;
  readonly adminTrust: TrustMap;
}

const FIXED_AWS_ENV = {
  AWS_REGION: 'ap-southeast-1',
  INFRAPULSE_AWS_ACCOUNT_ID: '491333778094',
  INFRAPULSE_DEPLOYMENT_ID: 'lab-20261118',
  INFRAPULSE_OWNER: 'caophi562005',
  INFRAPULSE_HYBRID_ROLE_NAME: 'infrapulse-lab-20261118-hybrid',
  INFRAPULSE_ELIGIBILITY_VALUE: 'lab-20261118',
  INFRAPULSE_METRIC_NAMESPACE: 'InfraPulse/Lab',
} as const;

const FORBIDDEN_RUNTIME_SECRET_ENV = [
  'MANAGEMENT_SERVICE_TRUST_FILE',
  'MANAGEMENT_MIGRATION_DATABASE_URL_FILE',
  'MANAGEMENT_BOOTSTRAP_DATABASE_URL_FILE',
  'MANAGEMENT_PUSH_DATABASE_URL_FILE',
  'PRISMA_PUSH_URL',
  'INFRAPULSE_ALERT_DATABASE_URL_FILE',
  'INFRAPULSE_GRAFANA_ADMIN_FILE',
  'INFRAPULSE_ASSERTION_KEY_FILE',
];

export function validateAwsConfig(env: NodeJS.ProcessEnv): AwsConfig {
  const invalid = (): never => {
    throw new Error('Invalid AWS configuration.');
  };

  for (const [key, expected] of Object.entries(FIXED_AWS_ENV)) {
    if (env[key] !== expected) invalid();
  }
  for (const key of Object.keys(env)) {
    if (
      (/^AWS_ENDPOINT_URL(?:_|$)/.test(key) ||
        [
          'AWS_ACCESS_KEY_ID',
          'AWS_SECRET_ACCESS_KEY',
          'AWS_SESSION_TOKEN',
          'AWS_REGION_ENDPOINT',
        ].includes(key)) &&
      env[key] !== undefined
    ) {
      invalid();
    }
  }

  const readDocName = (key: string, expected: string): string => {
    if (env[key] !== undefined && env[key] !== expected) invalid();
    return expected;
  };
  const readVersion = (key: string): string | null => {
    const value = env[key];
    if (value === undefined) return null;
    if (!/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2147483647) invalid();
    return value;
  };
  const readCap = (key: string, max: number, min = 1): number => {
    const value = env[key] ?? String(max);
    if (!/^[1-9]\d*$/.test(value) || Number(value) < min || Number(value) > max) invalid();
    return Number(value);
  };
  const readBootstrapBucket = (): string | null => {
    const value = env.INFRAPULSE_BOOTSTRAP_BUCKET;
    if (value === undefined) return null;
    if (value !== 'infrapulse-lab-20261118-bootstrap-491333778094') invalid();
    return value;
  };
  const readAmpEndpoint = (): string | null => {
    const value = env.INFRAPULSE_AMP_ENDPOINT;
    if (value === undefined) return null;
    if (!/^https:\/\/aps-workspaces\.ap-southeast-1\.amazonaws\.com\/workspaces\/ws-[a-z0-9-]{8,64}\/$/.test(value)) {
      invalid();
    }
    return value;
  };

  return Object.freeze({
    region: 'ap-southeast-1',
    accountId: '491333778094',
    deploymentId: 'lab-20261118',
    owner: 'caophi562005',
    roleName: FIXED_AWS_ENV.INFRAPULSE_HYBRID_ROLE_NAME,
    eligibility: FIXED_AWS_ENV.INFRAPULSE_ELIGIBILITY_VALUE,
    namespace: 'InfraPulse/Lab',
    ampEndpoint: readAmpEndpoint(),
    configDocument: readDocName(
      'INFRAPULSE_CONFIG_DOCUMENT_NAME',
      'InfraPulse-lab-20261118-Configure',
    ),
    configVersion: readVersion('INFRAPULSE_CONFIG_DOCUMENT_VERSION'),
    cleanupDocument: readDocName(
      'INFRAPULSE_DECOMMISSION_DOCUMENT_NAME',
      'InfraPulse-lab-20261118-Decommission',
    ),
    cleanupVersion: readVersion('INFRAPULSE_DECOMMISSION_DOCUMENT_VERSION'),
    bootstrapBucket: readBootstrapBucket(),
    bootstrapUrlTtlSeconds: readCap('INFRAPULSE_BOOTSTRAP_URL_TTL_SECONDS', 1800, 60),
    maxActiveNodes: readCap('INFRAPULSE_MAX_ACTIVE_NODES', 5),
    maxConcurrentOnboarding: readCap('INFRAPULSE_MAX_CONCURRENT_ONBOARDING', 2),
    metricsIntervalSeconds: 60,
    activationTtlSeconds: 3600,
    configDeadlineSeconds: 1800,
    verifyDeadlineSeconds: 900,
  });
}

function readEnvString(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!isSafeText(value, 4096)) throw new Error();
  return value;
}

function readEnvNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
  integer = true,
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+(?:\.\d+)?$/.test(raw)) throw new Error();
  const parsed = Number(raw);
  if (
    !Number.isFinite(parsed) ||
    (integer && !Number.isInteger(parsed)) ||
    parsed < min ||
    parsed > max
  ) {
    throw new Error();
  }
  return parsed;
}

function parseTrustFile(path: string): TrustMap {
  const parsed = parseStrictJson(Buffer.from(readSecretFile(path)));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();

  const entries = Object.entries(parsed);
  if (entries.length < 1 || entries.length > 8) throw new Error();

  const result: Record<string, TrustEntry> = Object.create(null) as Record<string, TrustEntry>;
  for (const [kid, candidate] of entries) {
    if (
      !/^[A-Za-z0-9._-]{1,64}$/.test(kid) ||
      !candidate ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate)
    ) {
      throw new Error();
    }
    const entry = candidate as Record<string, unknown>;
    if (
      Object.keys(entry).some(
        (k) => !['public_key_pem', 'issuer', 'audience', 'subject', 'scopes'].includes(k),
      ) ||
      typeof entry.public_key_pem !== 'string' ||
      !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PUBLIC KEY-----\r?\n?$/.test(
        entry.public_key_pem,
      ) ||
      !isSafeText(entry.issuer, 4096) ||
      !isSafeText(entry.audience, 4096) ||
      (entry.subject !== undefined && !isSafeText(entry.subject, 4096)) ||
      (entry.scopes !== undefined &&
        (!Array.isArray(entry.scopes) || entry.scopes.some((s) => !isSafeText(s, 4096))))
    ) {
      throw new Error();
    }
    result[kid] = Object.freeze({
      public_key_pem: entry.public_key_pem,
      issuer: entry.issuer,
      audience: entry.audience,
      ...(entry.subject !== undefined ? { subject: entry.subject } : {}),
      ...(entry.scopes !== undefined ? { scopes: Object.freeze([...entry.scopes]) } : {}),
    });
  }
  return Object.freeze(result);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ManagementConfig {
  const hasAwsEnv = Object.keys(env).some(
    (key) =>
      (Object.hasOwn(FIXED_AWS_ENV, key) ||
        /^INFRAPULSE_(CONFIG_DOCUMENT|DECOMMISSION_DOCUMENT|LINUX_PRESET|WINDOWS_PRESET|MAX_ACTIVE_NODES|MAX_CONCURRENT_ONBOARDING)/.test(
          key,
        )) &&
      env[key] !== undefined,
  );
  const aws = hasAwsEnv ? validateAwsConfig(env) : undefined;

  try {
    const databasePath = readEnvString(env, 'MANAGEMENT_DATABASE_URL_FILE');
    const adminPath = readEnvString(env, 'MANAGEMENT_ADMIN_TRUST_FILE');

    if (
      aws &&
      (databasePath !== '/run/secrets/management-db-url' ||
        adminPath !== '/run/secrets/assertion-trust' ||
        FORBIDDEN_RUNTIME_SECRET_ENV.some((key) => env[key] !== undefined))
    ) {
      throw new Error();
    }

    const logLevel = env.MANAGEMENT_LOG_LEVEL ?? 'INFO';
    if (!['INFO', 'WARN', 'ERROR'].includes(logLevel)) throw new Error();

    const rate = readEnvNumber(env, 'MANAGEMENT_REQUEST_RATE_PER_SECOND', 20, 0, 1000, false);
    if (rate === 0) throw new Error();

    const databaseUrl = readSecretFile(databasePath);
    if (!databaseUrl) throw new Error();

    return Object.freeze({
      ...(aws ? { aws } : {}),
      MANAGEMENT_DATABASE_URL_FILE: databasePath,
      databaseUrl,
      MANAGEMENT_DB_POOL_MAX: readEnvNumber(env, 'MANAGEMENT_DB_POOL_MAX', 10, 1, 64),
      MANAGEMENT_DB_POOL_TIMEOUT_MS: readEnvNumber(
        env,
        'MANAGEMENT_DB_POOL_TIMEOUT_MS',
        1000,
        1,
        1000,
      ),
      PORT: readEnvNumber(env, 'PORT', 3000, 1, 65535),
      MANAGEMENT_HOST_PORT: readEnvNumber(env, 'MANAGEMENT_HOST_PORT', 3001, 1, 65535),
      MANAGEMENT_LOG_LEVEL: logLevel as ManagementConfig['MANAGEMENT_LOG_LEVEL'],
      MANAGEMENT_REQUEST_RATE_PER_SECOND: rate,
      MANAGEMENT_REQUEST_BURST: readEnvNumber(env, 'MANAGEMENT_REQUEST_BURST', 40, 1, 10000),
      MANAGEMENT_NONCE_MAX_ENTRIES: readEnvNumber(
        env,
        'MANAGEMENT_NONCE_MAX_ENTRIES',
        20000,
        1,
        20000,
      ),
      MANAGEMENT_ADMIN_TRUST_FILE: adminPath,
      MANAGEMENT_GRAFANA_CONTEXT: readEnvString(env, 'MANAGEMENT_GRAFANA_CONTEXT'),
      adminTrust: parseTrustFile(adminPath),
    });
  } catch {
    throw new Error('Invalid management configuration.');
  }
}
