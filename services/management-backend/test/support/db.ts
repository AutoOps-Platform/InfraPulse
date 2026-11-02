import pg from 'pg';
import { guardDatabase, readTestUrl, type TestDatabase } from './pg-harness.js';

export function identity(): TestDatabase {
  const db = JSON.parse(
    process.env.TEST_DB_IDENTITY ?? 'null',
  ) as TestDatabase | null;
  if (!db) throw new Error('Isolated database harness required.');
  return db;
}
export async function admin(): Promise<pg.Client> {
  const db = identity();
  await guardDatabase(db);
  const client = new pg.Client({
    connectionString: readTestUrl(db.adminFile),
    connectionTimeoutMillis: 1000,
    statement_timeout: 1000,
  });
  await client.connect();
  return client;
}
export async function runtimeAttempt(sql: string): Promise<string | null> {
  const client = await admin();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE management_runtime');
    await client.query(sql);
    return null;
  } catch (error) {
    return (error as { code: string }).code;
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
}
