import { ApiError } from './errors.js';
import { parseStrictJson } from './http-boundary.js';

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
  readonly orderBy: readonly [
    { readonly created_at: 'asc' },
    { readonly id: 'asc' },
  ];
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
    if (!query || typeof query !== 'object' || Array.isArray(query))
      throw new Error();
    const filters: Record<string, string> = {};
    for (const [name, value] of Object.entries(query)) {
      if (name === 'limit' || name === 'cursor') continue;
      if (
        !allowedFilters.includes(name) ||
        !/^[a-z][a-z_]*$/.test(name) ||
        typeof value !== 'string' ||
        value.length < 1 ||
        value.length > 128 ||
        /[\u0000-\u001f\u007f]/u.test(value)
      )
        throw new Error();
      filters[name] = value;
    }
    const rawLimit = query.limit;
    if (
      rawLimit !== undefined &&
      (typeof rawLimit !== 'string' || !/^[1-9]\d{0,2}$/.test(rawLimit))
    )
      throw new Error();
    const limit = rawLimit === undefined ? 20 : Number(rawLimit);
    if (limit > 100) throw new Error();
    let after: PageCursor | null = null;
    if (query.cursor !== undefined) {
      if (
        typeof query.cursor !== 'string' ||
        query.cursor.length > 512 ||
        !/^[A-Za-z0-9_-]+$/.test(query.cursor)
      )
        throw new Error();
      const raw = Buffer.from(query.cursor, 'base64url');
      if (raw.toString('base64url') !== query.cursor) throw new Error();
      const decoded = parseStrictJson(raw);
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded))
        throw new Error();
      const fields = decoded as Record<string, unknown>;
      if (
        Object.keys(fields).length !== 2 ||
        typeof fields.created_at !== 'string' ||
        typeof fields.id !== 'string'
      )
        throw new Error();
      if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
          fields.created_at,
        ) ||
        new Date(fields.created_at).toISOString() !== fields.created_at
      )
        throw new Error();
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          fields.id,
        )
      )
        throw new Error();
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
