import { parsePage } from '../../src/common/pagination.js';
import { ApiError } from '../../src/common/errors.js';

const cursor = Buffer.from(
  '{"created_at":"2026-10-31T00:00:00.000Z","id":"123e4567-e89b-42d3-a456-426614174000"}',
).toString('base64url');
describe('bounded stable pagination', () => {
  it('defaults to twenty and fixes stable ascending ordering', () => {
    expect(parsePage({})).toEqual({
      limit: 20,
      after: null,
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      filters: {},
    });
  });
  it('validates the opaque timestamp and UUID cursor', () => {
    expect(parsePage({ limit: '100', cursor }).after).toEqual({
      created_at: '2026-10-31T00:00:00.000Z',
      id: '123e4567-e89b-42d3-a456-426614174000',
    });
  });
  it.each([
    { limit: '101' },
    { limit: '0' },
    { limit: '1.2' },
    { limit: ['2'] },
    { cursor: 'not-a-cursor' },
    { cursor: `${cursor}=` },
    { orderBy: 'password' },
    { unknown: 'x' },
    { environment: ['production'] },
    { 'name[$gt]': '' },
  ])('rejects unbounded or undeclared query shapes %#', (query) => {
    expect(() => parsePage(query)).toThrow(ApiError);
  });
  it('accepts only explicit per-resource filters', () => {
    expect(parsePage({ environment: 'lab' }, ['environment']).filters).toEqual({
      environment: 'lab',
    });
    expect(() => parsePage({ environment: 'lab' })).toThrow(ApiError);
  });
  it.each([
    '{"created_at":"not-a-date","id":"123e4567-e89b-42d3-a456-426614174000"}',
    '{"created_at":"2026-02-30T00:00:00.000Z","id":"123e4567-e89b-42d3-a456-426614174000"}',
    '{"created_at":"2026-10-31T00:00:00.000Z","id":"BAD"}',
    '{"created_at":"2026-10-31T00:00:00.000Z","id":"123e4567-e89b-42d3-a456-426614174000","password":"x"}',
  ])('rejects invalid decoded cursor %#', (raw) => {
    expect(() =>
      parsePage({ cursor: Buffer.from(raw).toString('base64url') }),
    ).toThrow(ApiError);
  });
});
