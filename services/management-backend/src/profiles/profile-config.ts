import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import { ApiError } from '../common/errors.js';

export type ProfileOs = 'linux' | 'windows';
export type ProfileOptions = {
  disk?:
    | { exclude_filesystems?: string[]; mount_points?: string[] }
    | { include_volumes?: string[] };
  network?: { interfaces?: string[] };
};
export type ProfileConfigV1 = {
  schema_version: 1;
  os: ProfileOs;
  interval_seconds: number;
  metric_groups: {
    cpu: boolean;
    memory: boolean;
    disk: boolean;
    network: boolean;
  };
  options: ProfileOptions;
};
const fail = (): never => {
  throw new ApiError('invalid_request');
};
function object(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return fail();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !fields.includes(key)) return fail();
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    if (!property.enumerable || !('value' in property)) return fail();
  }
  return value as Record<string, unknown>;
}
function strings(value: unknown, absolute = false): string[] {
  if (!Array.isArray(value) || value.length > 64) return fail();
  const result: string[] = [];
  for (const item of value) {
    if (
      typeof item !== 'string' ||
      item.length < 1 ||
      item.length > 128 ||
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(
        item,
      ) ||
      /[\u0000-\u001f\u007f;|&<>`]|\$\{|\$\(|\{\{|\}\}|[a-z][a-z0-9+.-]*:\/\//iu.test(
        item,
      ) ||
      /^(?:https?|ftp|file|data|javascript):/iu.test(item) ||
      (absolute && !item.startsWith('/'))
    )
      return fail();
    result.push(item);
  }
  return result;
}
// Projection constructs a fresh JSON-only value: no caller-owned objects, getters,
// unknown plugin knobs, nonfinite/unsafe numeric values or invalid Unicode survive.
export function validateProfileConfig(
  value: unknown,
  os: ProfileOs,
): ProfileConfigV1 {
  if (os !== 'linux' && os !== 'windows') return fail();
  const input = object(value, [
    'schema_version',
    'os',
    'interval_seconds',
    'metric_groups',
    'options',
  ]);
  if (input.schema_version !== 1 || input.os !== os) return fail();
  const interval =
    input.interval_seconds === undefined ? 15 : input.interval_seconds;
  if (
    typeof interval !== 'number' ||
    !Number.isSafeInteger(interval) ||
    interval < 5 ||
    interval > 300
  )
    return fail();
  const groups = object(input.metric_groups, [
    'cpu',
    'memory',
    'disk',
    'network',
  ]);
  for (const field of ['cpu', 'memory', 'disk', 'network'])
    if (typeof groups[field] !== 'boolean') return fail();
  const options = object(input.options, ['disk', 'network']);
  const clean: ProfileOptions = {};
  if (Object.hasOwn(options, 'disk')) {
    const allowed =
      os === 'linux'
        ? ['exclude_filesystems', 'mount_points']
        : ['include_volumes'];
    const disk = object(options.disk, allowed);
    clean.disk = {};
    for (const key of allowed)
      if (Object.hasOwn(disk, key))
        (clean.disk as Record<string, string[]>)[key] = strings(
          disk[key],
          key === 'mount_points',
        );
  }
  if (Object.hasOwn(options, 'network')) {
    const network = object(options.network, ['interfaces']);
    clean.network = {};
    if (Object.hasOwn(network, 'interfaces'))
      clean.network.interfaces = strings(network.interfaces);
  }
  const config: ProfileConfigV1 = {
    schema_version: 1,
    os,
    interval_seconds: interval,
    metric_groups: {
      cpu: groups.cpu as boolean,
      memory: groups.memory as boolean,
      disk: groups.disk as boolean,
      network: groups.network as boolean,
    },
    options: clean,
  };
  if (Buffer.byteLength(JSON.stringify(config), 'utf8') > 64 * 1024)
    throw new ApiError('payload_too_large');
  return config;
}
export function canonicalProfile(config: ProfileConfigV1): string {
  const valid = validateProfileConfig(config, config?.os);
  try {
    const json = canonicalize(valid);
    if (typeof json !== 'string') return fail();
    return json;
  } catch {
    return fail();
  }
}
export function profileChecksum(config: ProfileConfigV1): string {
  return createHash('sha256')
    .update(canonicalProfile(config), 'utf8')
    .digest('hex');
}
