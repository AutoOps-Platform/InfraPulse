import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { readSecretFile } = (await import(
  new URL('../src/config/secret-files.ts', import.meta.url).href
)) as typeof import('../src/config/secret-files.js');

// Explicit operator seed. No published version is overwritten; no startup import.
export async function seedDatabase(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  let client: pg.Client | undefined;
  try {
    const url = new URL(
      readSecretFile(env.MANAGEMENT_MIGRATION_DATABASE_URL_FILE ?? ''),
    );
    const gateway = env.INGEST_GATEWAY_ID;
    if (
      url.username !== 'management_owner' ||
      url.searchParams.get('schema') !== 'management' ||
      !gateway ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        gateway,
      )
    )
      throw new Error();
    // Explicit build prerequisite: Node's native .ts runner cannot resolve the
    // source validator's compiled .js imports. Never build/migrate implicitly.
    const { validateProfileConfig, canonicalProfile, profileChecksum } =
      (await import(
        new URL('../dist/profiles/profile-config.js', import.meta.url).href
      )) as typeof import('../src/profiles/profile-config.js');
    client = new pg.Client({
      connectionString: url.toString(),
      connectionTimeoutMillis: 1000,
      statement_timeout: 1000,
    });
    client.on('error', () => {});
    await client.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(913748,3)');
    await client.query('SELECT pg_advisory_xact_lock(913748,6)'); // Same profile writer lock as runtime mutations.
    for (const os of ['linux', 'windows'] as const) {
      const config = validateProfileConfig(
        {
          schema_version: 1,
          os,
          interval_seconds: 15,
          metric_groups: { cpu: true, memory: true, disk: true, network: true },
          options: {},
        },
        os,
      );
      const canonical = canonicalProfile(config);
      const checksum = profileChecksum(config);
      const slug = `${os}-base`;
      const result = await client.query(
        'INSERT INTO management.monitoring_profiles(id,slug,name,description,os) VALUES($1,$2,$2,$3,$4) ON CONFLICT(slug) DO NOTHING RETURNING id',
        [randomUUID(), slug, 'Base monitoring profile', os],
      );
      const profile =
        result.rows[0] ??
        (
          await client.query(
            'SELECT id,os FROM management.monitoring_profiles WHERE slug=$1',
            [slug],
          )
        ).rows[0];
      if (!profile || (profile.os && profile.os !== os)) throw new Error();
      await client.query(
        "INSERT INTO management.profile_versions(id,profile_id,version,config,checksum,status,created_by,published_at) VALUES($1,$2,1,$3,$4,'published',$5,clock_timestamp()) ON CONFLICT(profile_id,version) DO NOTHING",
        [
          randomUUID(),
          profile.id,
          canonical,
          checksum,
          JSON.stringify({
            kind: 'service',
            issuer: 'operator',
            subject: 'seed',
          }),
        ],
      );
      const existing = await client.query(
        "SELECT config=$2::jsonb AND checksum=$3 AND status='published' AS valid FROM management.profile_versions WHERE profile_id=$1 AND version=1",
        [profile.id, canonical, checksum],
      );
      if (existing.rows[0]?.valid !== true) throw new Error(); // Never overwrite an incompatible existing version.
    }
    await client.query(
      'INSERT INTO management.gateway_sources(gateway_id) VALUES($1) ON CONFLICT(gateway_id) DO NOTHING',
      [gateway],
    );
    await client.query('COMMIT');
  } catch {
    try {
      await client?.query('ROLLBACK');
    } catch {}
    throw new Error('Management database seed failed.');
  } finally {
    await client?.end();
  }
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  try {
    await seedDatabase();
    process.stdout.write('management_db_seed_ok\n');
  } catch {
    process.stderr.write('management_db_seed_failed\n');
    process.exitCode = 1;
  }
}
