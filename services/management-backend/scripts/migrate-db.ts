import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { readSecretFile } = (await import(
  new URL('../src/config/secret-files.ts', import.meta.url).href
)) as typeof import('../src/config/secret-files.js');

export function migrateDatabase(env: NodeJS.ProcessEnv = process.env): void {
  try {
    const url = new URL(
      readSecretFile(env.MANAGEMENT_MIGRATION_DATABASE_URL_FILE ?? ''),
    );
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.username !== 'management_owner' ||
      !url.password ||
      url.searchParams.get('schema') !== 'management' ||
      url.hash
    )
      throw new Error();
    const require = createRequire(import.meta.url);
    const cli = require.resolve('prisma/build/index.js');
    const child = spawnSync(
      process.execPath,
      [cli, 'migrate', 'deploy', '--config', 'prisma.config.ts'],
      {
        cwd: resolve(import.meta.dirname, '..'),
        env: { ...env, PRISMA_MIGRATION_URL: url.toString() },
        stdio: 'ignore',
        timeout: 180_000,
      },
    );
    if (child.status !== 0 || child.error) throw new Error();
  } catch {
    throw new Error('Management database migration failed.');
  }
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  try {
    migrateDatabase();
    process.stdout.write('management_db_migrate_ok\n');
  } catch {
    process.stderr.write('management_db_migrate_failed\n');
    process.exitCode = 1;
  }
}
