import { randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import pg from 'pg';

const workspace = resolve(
  import.meta.dirname,
  '../../../../.superpowers/sdd/2026-10-31-management-backend',
);
const compose = resolve(import.meta.dirname, '../compose.yaml');
const runPattern = /^[0-9a-f]{16}$/;
export interface TestDatabase {
  runId: string;
  database: string;
  project: string;
  privateDir: string;
  adminFile: string;
  ownerFile: string;
  runtimeFile: string;
  external: boolean;
}

// Captured output is restricted to allowlisted inspect fields, never Config.Env.
function docker(
  args: string[],
  env: NodeJS.ProcessEnv,
  output?: string,
  timeout = 180_000,
): void {
  const fd = output ? openSync(output, 'w', 0o600) : undefined;
  try {
    const result = spawnSync('docker', args, {
      env,
      stdio: ['ignore', fd ?? 'ignore', 'ignore'],
      timeout,
    });
    if (result.status !== 0 || result.error)
      throw new Error('Isolated PostgreSQL Docker prerequisite failed.');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function environment(db: TestDatabase): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TEST_DB_RUN_ID: db.runId,
    TEST_DB_PRIVATE_DIR: db.privateDir,
  };
}
function inspect(db: TestDatabase): number {
  if (
    !runPattern.test(db.runId) ||
    db.project !== `infrapulse-t2-${db.runId}` ||
    db.database !== `infrapulse_test_${db.runId}` ||
    db.external
  )
    throw new Error('Unsafe test database identity.');
  const file = resolve(db.privateDir, 'inspect.json');
  docker(
    [
      'inspect',
      '--format',
      '{{json .Config.Labels}}|{{json .NetworkSettings.Ports}}',
      `${db.project}-pg-1`,
    ],
    environment(db),
    file,
  );
  const [labels, ports] = readFileSync(file, 'utf8')
    .trim()
    .split('|')
    .map((part) => JSON.parse(part));
  const bindings = ports['5432/tcp'];
  if (
    labels['com.docker.compose.project'] !== db.project ||
    labels['com.docker.compose.service'] !== 'pg' ||
    labels['infrapulse.test.run_id'] !== db.runId ||
    labels['infrapulse.test.database'] !== db.database ||
    bindings?.length !== 1 ||
    bindings[0].HostIp !== '127.0.0.1'
  )
    throw new Error('Unsafe test container identity.');
  const port = Number(bindings[0].HostPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid isolated port.');
  return port;
}
export function readTestUrl(path: string): string {
  return readFileSync(path, 'utf8').trim();
}
export async function guardDatabase(db: TestDatabase): Promise<void> {
  if (
    !runPattern.test(db.runId) ||
    db.database !== `infrapulse_test_${db.runId}`
  )
    throw new Error('Unsafe test database identity.');
  if (!db.external) inspect(db);
  const url = new URL(readTestUrl(db.adminFile));
  if (
    decodeURIComponent(url.pathname.slice(1)) !== db.database ||
    !['127.0.0.1', 'localhost', 'pg'].includes(url.hostname)
  )
    throw new Error('Unsafe test URL identity.');
  const client = new pg.Client({
    connectionString: url.toString(),
    connectionTimeoutMillis: 1000,
    statement_timeout: 1000,
  });
  try {
    await client.connect();
    const result = await client.query(
      "SELECT current_database() AS name, shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()",
    );
    if (
      result.rows[0]?.name !== db.database ||
      result.rows[0]?.marker !== `infrapulse-test:${db.runId}`
    )
      throw new Error('Unsafe test database marker.');
  } catch {
    throw new Error('Isolated database guard failed.');
  } finally {
    await client.end();
  }
}
export async function startDatabase(): Promise<TestDatabase> {
  if (process.env.INFRAPULSE_TEST_DB_EXTERNAL === '1') {
    const runId = process.env.TEST_DB_RUN_ID ?? '';
    if (!runPattern.test(runId))
      throw new Error('External test database run id required.');
    const db: TestDatabase = {
      runId,
      database: `infrapulse_test_${runId}`,
      project: `infrapulse-t2-${runId}`,
      external: true,
      privateDir: resolve(workspace, `task-2-private-external-${runId}`),
      adminFile: process.env.TEST_DB_ADMIN_URL_FILE ?? '',
      ownerFile: process.env.MANAGEMENT_MIGRATION_DATABASE_URL_FILE ?? '',
      runtimeFile: process.env.MANAGEMENT_DATABASE_URL_FILE ?? '',
    };
    await guardDatabase(db);
    mkdirSync(db.privateDir, { recursive: true, mode: 0o700 });
    return db;
  }
  const runId = randomBytes(8).toString('hex');
  const privateDir = resolve(workspace, `task-2-private-${runId}`);
  mkdirSync(privateDir, { mode: 0o700 });
  const db: TestDatabase = {
    runId,
    privateDir,
    database: `infrapulse_test_${runId}`,
    project: `infrapulse-t2-${runId}`,
    external: false,
    adminFile: resolve(privateDir, 'admin-url'),
    ownerFile: resolve(privateDir, 'owner-url'),
    runtimeFile: resolve(privateDir, 'runtime-url'),
  };
  const password = randomBytes(32).toString('base64url');
  writeFileSync(resolve(privateDir, 'bootstrap-password'), password, {
    mode: 0o600,
  });
  try {
    docker(
      [
        'compose',
        '-f',
        compose,
        '-p',
        db.project,
        'up',
        '-d',
        '--wait',
        '--wait-timeout',
        '180',
      ],
      environment(db),
    );
    const port = inspect(db);
    const base = `postgresql://postgres:${password}@127.0.0.1:${port}/${db.database}`;
    writeFileSync(db.adminFile, base, { mode: 0o600 });
    for (const [role, file] of [
      ['management_owner', db.ownerFile],
      ['management_runtime', db.runtimeFile],
    ]) {
      writeFileSync(
        file,
        `postgresql://${role}:${randomBytes(32).toString('base64url')}@127.0.0.1:${port}/${db.database}?schema=management`,
        { mode: 0o600 },
      );
    }
    const client = new pg.Client({
      connectionString: base,
      connectionTimeoutMillis: 1000,
      statement_timeout: 1000,
    });
    try {
      await client.connect();
      // Database identifier and marker are generated hex, not externally supplied SQL.
      await client.query(
        `COMMENT ON DATABASE "${db.database}" IS 'infrapulse-test:${runId}'`,
      );
    } finally {
      await client.end();
    }
    await guardDatabase(db);
    writeFileSync(
      resolve(privateDir, 'identity.json'),
      JSON.stringify({
        runId,
        database: db.database,
        project: db.project,
        port,
      }),
      { mode: 0o600 },
    );
    return db;
  } catch {
    stopDatabase(db);
    throw new Error('Isolated PostgreSQL startup failed.');
  }
}
export function stopDatabase(db: TestDatabase): void {
  if (db.external) return; // Parent owns lifecycle; no Docker operation in external mode.
  inspect(db); // Refuse teardown unless exact project, run label, database and loopback match.
  docker(
    ['compose', '-f', compose, '-p', db.project, 'down', '--timeout', '10'],
    environment(db),
    undefined,
    60_000,
  );
}
export default async function setup() {
  const db = await startDatabase();
  process.env.TEST_DB_IDENTITY = JSON.stringify(db);
  let stage = 'imports';
  try {
    await guardDatabase(db);
    const { bootstrapDatabase } = await import('../../scripts/bootstrap-db.js');
    const { migrateDatabase } = await import('../../scripts/migrate-db.js');
    const env = {
      ...process.env,
      MANAGEMENT_BOOTSTRAP_DATABASE_URL_FILE: db.adminFile,
      MANAGEMENT_MIGRATION_DATABASE_URL_FILE: db.ownerFile,
      MANAGEMENT_DATABASE_URL_FILE: db.runtimeFile,
    };
    const publicQuery =
      "SELECT c.relname,c.relkind,c.relowner,c.relacl::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname";
    const initial = new pg.Client({
      connectionString: readTestUrl(db.adminFile),
      connectionTimeoutMillis: 1000,
      statement_timeout: 1000,
    });
    let publicBefore: unknown;
    try {
      await initial.connect();
      publicBefore = (await initial.query(publicQuery)).rows;
    } finally {
      await initial.end();
    }
    stage = 'bootstrap';
    await bootstrapDatabase(env);
    await bootstrapDatabase(env); // Existing roles are validated, never implicitly rotated.
    stage = 'migration';
    migrateDatabase(env);
    stage = 'migration_receipt';
    const client = new pg.Client({
      connectionString: readTestUrl(db.adminFile),
      connectionTimeoutMillis: 1000,
      statement_timeout: 1000,
    });
    try {
      await client.connect();
      const before = await client.query(
        'SELECT id,checksum,finished_at FROM management._prisma_migrations ORDER BY id',
      );
      const marker = randomBytes(8).toString('hex');
      const markerId = randomUUID();
      await client.query(
        'INSERT INTO management.server_groups(id,name,slug) VALUES($1,$2,$2)',
        [markerId, marker],
      );
      migrateDatabase(env);
      const after = await client.query(
        'SELECT id,checksum,finished_at FROM management._prisma_migrations ORDER BY id',
      );
      const kept = await client.query(
        'SELECT name FROM management.server_groups WHERE id=$1',
        [markerId],
      );
      if (
        JSON.stringify(before.rows) !== JSON.stringify(after.rows) ||
        kept.rows[0]?.name !== marker
      )
        throw new Error('Second migration changed data.');
      const publicAfter = (await client.query(publicQuery)).rows;
      if (JSON.stringify(publicBefore) !== JSON.stringify(publicAfter))
        throw new Error('Public catalog changed.');
      const receipt = {
        run_id: db.runId,
        database: db.database,
        bootstrap_runs: 2,
        deploys: 2,
        history_rows: after.rowCount,
        preserved: true,
        public_unchanged: true,
      };
      writeFileSync(
        resolve(db.privateDir, 'migration-receipt.json'),
        JSON.stringify(receipt),
        { mode: 0o600 },
      );
      process.stdout.write(`isolated_db_receipt=${JSON.stringify(receipt)}\n`);
    } finally {
      await client.end();
    }
  } catch {
    await guardDatabase(db);
    stopDatabase(db);
    throw new Error(`Isolated database prerequisite failed at ${stage}.`);
  }
  return async () => {
    await guardDatabase(db);
    stopDatabase(db);
  };
}
