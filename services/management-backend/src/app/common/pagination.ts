import { TextDecoder } from 'node:util';
import { visit } from 'jsonc-parser';
import { registerDecorator, type ValidationOptions } from 'class-validator';
import { ApiError } from './errors.js';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const HASH_PATTERN = /^[a-f0-9]{64}$/;

const FORBIDDEN_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function isSafeText(value: unknown, max = 128): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= max &&
    !hasControlChars(value)
  );
}

export function IsSafeText(min: number, max: number, options?: ValidationOptions) {
  return (target: object, propertyName: string) => {
    registerDecorator({
      name: 'isSafeText',
      target: target.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown): boolean {
          return (
            typeof value === 'string' &&
            value.length >= min &&
            value.length <= max &&
            !hasControlChars(value)
          );
        },
      },
    });
  };
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function inventoryId(value: string): string {
  if (!isUuid(value)) throw new ApiError('invalid_request');
  return value;
}

export function enumFilter(
  value: string | undefined,
  allowed: readonly string[],
): string | undefined {
  if (value !== undefined && !allowed.includes(value)) {
    throw new ApiError('invalid_request');
  }
  return value;
}

export function parseStrictJson(raw: Buffer): unknown {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
    const objects: Set<string>[] = [];
    let invalid = false;

    visit(
      text,
      {
        onObjectBegin: () => {
          objects.push(new Set());
        },
        onObjectProperty: (name) => {
          const names = objects.at(-1);
          if (!names || names.has(name) || FORBIDDEN_JSON_KEYS.has(name)) {
            invalid = true;
          }
          names?.add(name);
        },
        onObjectEnd: () => {
          objects.pop();
        },
        onError: () => {
          invalid = true;
        },
      },
      { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false },
    );

    if (invalid) throw new Error();
    return JSON.parse(text, (_key, value: unknown) => {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error();
      return value;
    }) as unknown;
  } catch {
    throw new ApiError('invalid_request');
  }
}

export interface PageQuery {
  readonly [key: string]: unknown;
  readonly limit?: unknown;
  readonly cursor?: unknown;
}

export interface PageCursor {
  readonly created_at: string;
  readonly id: string;
}

export interface PageSpec {
  readonly limit: number;
  readonly after: PageCursor | null;
  readonly orderBy: readonly [{ readonly created_at: 'asc' }, { readonly id: 'asc' }];
  readonly filters: Readonly<Record<string, string>>;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
}

export function parsePage(
  query: PageQuery,
  allowedFilters: readonly string[] = [],
): PageSpec {
  try {
    if (!query || typeof query !== 'object' || Array.isArray(query)) throw new Error();

    const filters: Record<string, string> = {};
    for (const [name, value] of Object.entries(query)) {
      if (name === 'limit' || name === 'cursor') continue;
      if (
        !allowedFilters.includes(name) ||
        !/^[a-z][a-z_]*$/.test(name) ||
        !isSafeText(value, 128)
      ) {
        throw new Error();
      }
      filters[name] = value;
    }

    const rawLimit = query.limit;
    if (rawLimit !== undefined && (typeof rawLimit !== 'string' || !/^[1-9]\d{0,2}$/.test(rawLimit))) {
      throw new Error();
    }
    const limit = rawLimit === undefined ? 20 : Number(rawLimit);
    if (limit > 100) throw new Error();

    let after: PageCursor | null = null;
    if (query.cursor !== undefined) {
      if (
        typeof query.cursor !== 'string' ||
        query.cursor.length > 512 ||
        !/^[A-Za-z0-9_-]+$/.test(query.cursor)
      ) {
        throw new Error();
      }
      const raw = Buffer.from(query.cursor, 'base64url');
      if (raw.toString('base64url') !== query.cursor) throw new Error();

      const decoded = parseStrictJson(raw);
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error();

      const fields = decoded as Record<string, unknown>;
      if (
        Object.keys(fields).length !== 2 ||
        typeof fields.created_at !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(fields.created_at) ||
        new Date(fields.created_at).toISOString() !== fields.created_at ||
        !isUuid(fields.id)
      ) {
        throw new Error();
      }
      after = Object.freeze({ created_at: fields.created_at, id: fields.id });
    }

    return Object.freeze({
      limit,
      after,
      orderBy: Object.freeze([
        Object.freeze({ created_at: 'asc' as const }),
        Object.freeze({ id: 'asc' as const }),
      ] as const),
      filters: Object.freeze(filters),
    });
  } catch {
    throw new ApiError('invalid_request');
  }
}

export async function pageCursor(
  page: PageSpec,
  find: (id: string) => Promise<{ created_at: Date } | null>,
): Promise<{ cursor?: { id: string }; skip?: number }> {
  if (!page.after) return {};
  const anchor = await find(page.after.id);
  if (!anchor || anchor.created_at.toISOString() !== page.after.created_at) {
    throw new ApiError('invalid_request');
  }
  return { cursor: { id: page.after.id }, skip: 1 };
}

export function inventoryPage<T extends { id: string; created_at: Date }, R>(
  rows: T[],
  page: PageSpec,
  map: (row: T) => R,
): Page<R> {
  const selected = rows.slice(0, page.limit);
  const last = selected.at(-1);
  return {
    items: selected.map(map),
    next_cursor:
      rows.length > page.limit && last
        ? Buffer.from(
            JSON.stringify({
              created_at: last.created_at.toISOString(),
              id: last.id,
            }),
          ).toString('base64url')
        : null,
  };
}
