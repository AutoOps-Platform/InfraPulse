import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const releaseFailure = 'Agent release unavailable or malformed.';
interface Preset { id: string; platform: 'linux' | 'windows'; version: number; hash: string; config: unknown }
export interface SeedResult {
  format: 'infrapulse-published-presets-v1';
  presets: { platform: 'linux' | 'windows'; presetId: string; presetVersion: number; presetHash: string; profileVersionId: string }[];
}
// Same fixed image-owned loader/decoder as the application. No DB UUID is an
// image input: publication selects the real immutable row ID only after INSERT.
async function releasePresets(): Promise<{ presets: Preset[]; canonicalSha256: (v: unknown) => string }> {
  try {
    const { loadAgentRelease } = await import(new URL('../dist/integrations/aws/release-config.js', import.meta.url).href) as typeof import('../src/integrations/aws/release-config.js');
    const decoder = await import(new URL('../release/agent-release.mjs', import.meta.url).href) as typeof import('../../../deploy/scripts/agent-release.mjs');
    const release = await loadAgentRelease();
    const presets: Preset[] = [];
    for (const platform of ['linux', 'windows'] as const) {
      const p = release.platforms[platform];
      if (p) presets.push({ id: platform, platform, version: p.parameter.version, hash: p.parameter.sha256, config: decoder.cloudWatchPreset(platform, p) });
    }
    return { presets, canonicalSha256: decoder.releaseSha256 };
  } catch { throw Error(releaseFailure); }
}
export async function seedDatabase(env: NodeJS.ProcessEnv = process.env): Promise<SeedResult> {
  const { presets, canonicalSha256 } = await releasePresets();
  const result: SeedResult = { format: 'infrapulse-published-presets-v1', presets: [] };
  if (!presets.length) return result; // Empty release is ordinary central-only inventory.
  let client: pg.Client | undefined;
  try {
    const { readSecretFile } = await import(new URL('../dist/config/secret-files.js', import.meta.url).href) as typeof import('../src/config/secret-files.js');
    const rawUrl =
      env.DATABASE_URL ??
      (env.MANAGEMENT_DATABASE_URL_FILE
        ? readSecretFile(env.MANAGEMENT_DATABASE_URL_FILE)
        : env.MANAGEMENT_MIGRATION_DATABASE_URL_FILE
          ? readSecretFile(env.MANAGEMENT_MIGRATION_DATABASE_URL_FILE)
          : '');
    const url = new URL(rawUrl);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.password || url.hash) {
      throw Error();
    }
    client = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 1000, statement_timeout: 1000 });
    client.on('error', () => {});
    await client.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(913748,3)');
    for (const preset of presets) {
      const existing = await client.query('SELECT id,os FROM monitoring_profiles WHERE slug=$1 FOR UPDATE', [`cloudwatch-${preset.id}`]);
      let profileId: string;
      if (!existing.rowCount) {
        profileId = randomUUID();
        await client.query('INSERT INTO monitoring_profiles(id,slug,name,description,os) VALUES($1,$2,$3,$4,$5)',
          [profileId, `cloudwatch-${preset.id}`, `CloudWatch ${preset.platform}`, 'Immutable native CloudWatch release preset; no Telegraf mutation.', preset.platform]);
      } else {
        profileId = existing.rows[0].id as string;
        if (existing.rowCount !== 1 || existing.rows[0].os !== preset.platform) throw Error();
      }
      const { hash, config } = preset;
      const version = await client.query('SELECT id,config,checksum,status FROM profile_versions WHERE profile_id=$1 AND version=$2', [profileId, preset.version]);
      let profileVersionId: string;
      if (version.rowCount) {
        if (version.rowCount !== 1 || version.rows[0].checksum !== hash || version.rows[0].status !== 'published' || canonicalSha256(version.rows[0].config) !== hash) throw Error();
        profileVersionId = version.rows[0].id as string;
      } else {
        const inserted = await client.query("INSERT INTO profile_versions(id,profile_id,version,config,checksum,status,created_by,published_at) VALUES($1,$2,$3,$4,$5,'published',$6,clock_timestamp()) RETURNING id",
          [randomUUID(), profileId, preset.version, config, hash, { kind: 'operator', action: 'native-cloudwatch-release-seed' }]);
        if (inserted.rowCount !== 1) throw Error();
        profileVersionId = inserted.rows[0].id as string;
      }
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(profileVersionId)) throw Error();
      result.presets.push({ platform: preset.platform, presetId: preset.id, presetVersion: preset.version, presetHash: hash, profileVersionId });
    }
    if (new Set(result.presets.map(p => p.profileVersionId)).size !== result.presets.length) throw Error();
    await client.query('COMMIT');
    // Only committed, bounded, nonsecret identity mapping escapes the transaction.
    return result;
  } catch {
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    throw Error('Management database seed failed.');
  } finally { if (client) await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(await seedDatabase()) + '\n'); }
  catch (error) {
    process.stderr.write(`${error instanceof Error && error.message === releaseFailure ? releaseFailure : 'management_db_seed_failed'}\n`);
    process.exitCode = 1;
  }
}
