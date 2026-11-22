import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { loadAgentRelease } from '../../../../integrations/aws/release-config.js';
import { ApiError } from '../../../common/errors.js';
import { HASH_PATTERN, isUuid, parseStrictJson } from '../../../common/pagination.js';
import type { BootstrapAttachment, Platform } from '../dto/onboarding.dto.js';

const BUNDLE_LIMIT = 262_144;
const BUNDLE_URL = new URL('../../../../../generated/bootstrap-assets.json', import.meta.url);

export interface BootstrapRenderInput {
  serverId: string;
  enrollmentId: string;
  generation: number;
  platform: Platform;
  activationId: string;
  activationCode: string;
  region: 'ap-southeast-1';
  presetHash: string;
}

export interface BootstrapAssets {
  platform: Platform;
  presetVersionId: string;
  presetHash: string;
  configurationVersion: string;
  template: Buffer;
}

export type QualifiedBootstrapAssets = BootstrapAssets;

export interface BootstrapAvailability {
  available: boolean;
  configurationVersion: string | null;
  reason: 'ready' | 'release_missing';
}

export interface BootstrapAssetsPort {
  readonly availability: (platform: Platform) => BootstrapAvailability;
  readonly load: (platform: Platform) => Promise<BootstrapAssets>;
}

export interface BootstrapAssetPins {
  platforms: Partial<
    Record<
      Platform,
      {
        presetVersionId: string;
        configurationVersion: string;
        presetHash: string;
      }
    >
  >;
}

const rejectNotReady = (): never => {
  throw new ApiError('provisioning_not_ready');
};

function decodeUtf8(bytes: Buffer): string {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > BUNDLE_LIMIT) {
      throw new Error();
    }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.includes('\u0000') || !Buffer.from(text, 'utf8').equals(bytes)) {
      throw new Error();
    }
    return text;
  } catch {
    return rejectNotReady();
  }
}

export function assertBootstrapAttachment(
  serverId: string,
  platform: Platform,
  attachment: BootstrapAttachment,
): void {
  if (
    !isUuid(serverId) ||
    !['linux', 'windows'].includes(platform) ||
    attachment?.filename !== `infrapulse-${serverId}.${platform === 'linux' ? 'sh' : 'ps1'}` ||
    attachment.contentType !== (platform === 'linux' ? 'text/x-shellscript' : 'text/plain')
  ) {
    rejectNotReady();
  }
  decodeUtf8(attachment.bytes);
}

export function renderBootstrap(
  input: BootstrapRenderInput,
  assets: QualifiedBootstrapAssets,
): BootstrapAttachment {
  if (
    !input ||
    !assets ||
    !isUuid(input.serverId) ||
    !isUuid(input.enrollmentId) ||
    !isUuid(input.activationId) ||
    !isUuid(assets.presetVersionId) ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 1 ||
    input.generation > 2147483647 ||
    input.region !== 'ap-southeast-1' ||
    !['linux', 'windows'].includes(input.platform) ||
    assets.platform !== input.platform ||
    !HASH_PATTERN.test(input.presetHash) ||
    assets.presetHash !== input.presetHash ||
    !HASH_PATTERN.test(assets.configurationVersion) ||
    typeof input.activationCode !== 'string' ||
    !/^[A-Za-z0-9+/=_-]{1,250}$/.test(input.activationCode)
  ) {
    rejectNotReady();
  }

  const values: Record<string, string> = {
    SERVER_ID: input.serverId,
    ENROLLMENT_ID: input.enrollmentId,
    GENERATION: String(input.generation),
    ACTIVATION_ID: input.activationId,
    ACTIVATION_CODE: input.activationCode,
    REGION: input.region,
    PRESET_HASH: input.presetHash,
  };
  const winNames: Record<string, string> = {
    SERVER_ID: 'ServerId',
    ENROLLMENT_ID: 'EnrollmentId',
    GENERATION: 'Generation',
    ACTIVATION_ID: 'ActivationId',
    ACTIVATION_CODE: 'ActivationCode',
    REGION: 'Region',
    PRESET_HASH: 'PresetHash',
  };

  const template = decodeUtf8(assets.template);
  if (/\{\{\{/.test(template)) rejectNotReady();

  const lines = template.split('\n');
  const seen = new Set<string>();
  const rendered = template.replace(/\{\{([^{}]*)\}\}/g, (_match, key: string) => {
    if (!Object.hasOwn(values, key) || seen.has(key)) return rejectNotReady();
    const expectedLine =
      input.platform === 'linux'
        ? `  ${key.toLowerCase()}='{{${key}}}'`
        : `    $script:${winNames[key]} = '{{${key}}}'`;
    if (!lines.includes(expectedLine)) return rejectNotReady();
    seen.add(key);
    return values[key];
  });

  if (
    seen.size !== Object.keys(values).length ||
    /\{\{/.test(rendered) ||
    lines.some(
      (line) => line.includes('{{ACTIVATION_CODE}}') && /(?:https?:|file:|data:|ftp:|\/\/)/i.test(line),
    )
  ) {
    rejectNotReady();
  }

  const bytes = Buffer.from(rendered, 'utf8');
  const attachment: BootstrapAttachment =
    input.platform === 'linux'
      ? { bytes, contentType: 'text/x-shellscript', filename: `infrapulse-${input.serverId}.sh` }
      : { bytes, contentType: 'text/plain', filename: `infrapulse-${input.serverId}.ps1` };
  assertBootstrapAttachment(input.serverId, input.platform, attachment);
  return attachment;
}

async function readProtectedBundle(): Promise<unknown> {
  const path = fileURLToPath(BUNDLE_URL);
  for (let current = path; ; current = dirname(current)) {
    const info = await lstat(current);
    if (
      info.isSymbolicLink() ||
      info.uid !== 0 ||
      (info.mode & 0o022) !== 0 ||
      (current === path ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())
    ) {
      return rejectNotReady();
    }
    if (current === parse(current).root) break;
  }

  const handle = await open(BUNDLE_URL, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > BUNDLE_LIMIT) return rejectNotReady();
    const bytes = await handle.readFile();
    if (bytes.length > BUNDLE_LIMIT) return rejectNotReady();
    decodeUtf8(bytes);
    return parseStrictJson(bytes);
  } finally {
    await handle.close();
  }
}

export async function createCanonicalBootstrapAssets(
  pins: BootstrapAssetPins = { platforms: {} },
): Promise<BootstrapAssetsPort> {
  try {
    const seenIds = new Set<string>();
    for (const [platform, pin] of Object.entries(pins.platforms)) {
      if (
        (platform !== 'linux' && platform !== 'windows') ||
        !pin ||
        !isUuid(pin.presetVersionId) ||
        !HASH_PATTERN.test(pin.configurationVersion) ||
        !HASH_PATTERN.test(pin.presetHash) ||
        seenIds.has(pin.presetVersionId)
      ) {
        return rejectNotReady();
      }
      seenIds.add(pin.presetVersionId);
    }

    const release = await loadAgentRelease();
    for (const platform of ['linux', 'windows'] as const) {
      const pin = pins.platforms[platform];
      const rel = release.platforms[platform];
      if (pin && rel && (pin.configurationVersion !== rel.revision || pin.presetHash !== rel.parameter.sha256)) {
        return rejectNotReady();
      }
    }

    const ready = new Map<Platform, BootstrapAssets>();
    let raw: unknown;
    try {
      raw = await readProtectedBundle();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    if (raw !== undefined) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return rejectNotReady();
      const bundle = raw as { schemaVersion?: unknown; entries?: unknown };
      if (bundle.schemaVersion !== 1 || !Array.isArray(bundle.entries) || bundle.entries.length > 2) {
        return rejectNotReady();
      }
      const seenPlatforms = new Set<Platform>();
      for (const item of bundle.entries) {
        if (!item || typeof item !== 'object') return rejectNotReady();
        const entry = item as Record<string, unknown>;
        if (entry.platform !== 'linux' && entry.platform !== 'windows') return rejectNotReady();
        const platform = entry.platform;
        if (
          seenPlatforms.has(platform) ||
          typeof entry.configurationVersion !== 'string' ||
          !HASH_PATTERN.test(entry.configurationVersion) ||
          typeof entry.presetHash !== 'string' ||
          !HASH_PATTERN.test(entry.presetHash) ||
          typeof entry.templateSha256 !== 'string' ||
          !HASH_PATTERN.test(entry.templateSha256) ||
          typeof entry.template !== 'string' ||
          /\r|\0|\uFEFF/.test(entry.template)
        ) {
          return rejectNotReady();
        }
        seenPlatforms.add(platform);
        const template = Buffer.from(entry.template, 'utf8');
        const digest = createHash('sha256').update(template).digest('hex');
        if (!template.length || template.length > BUNDLE_LIMIT || digest !== entry.templateSha256) {
          return rejectNotReady();
        }
        const rel = release.platforms[platform];
        if (!rel) continue;
        if (entry.configurationVersion !== rel.revision || entry.presetHash !== rel.parameter.sha256) {
          return rejectNotReady();
        }
        const pin = pins.platforms[platform];
        if (pin) {
          ready.set(platform, {
            platform,
            presetVersionId: pin.presetVersionId,
            presetHash: pin.presetHash,
            configurationVersion: rel.revision,
            template,
          });
        }
      }
    }

    return Object.freeze({
      availability(platform: Platform): BootstrapAvailability {
        const found = ready.get(platform);
        return found
          ? { available: true, configurationVersion: found.configurationVersion, reason: 'ready' }
          : { available: false, configurationVersion: null, reason: 'release_missing' };
      },
      async load(platform: Platform): Promise<BootstrapAssets> {
        const found = ready.get(platform);
        if (!found) return rejectNotReady();
        return { ...found, template: Buffer.from(found.template) };
      },
    });
  } catch {
    return rejectNotReady();
  }
}
