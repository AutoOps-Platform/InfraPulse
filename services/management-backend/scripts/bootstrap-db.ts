import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { readSecretFile } = (await import(
  new URL('../src/config/secret-files.ts', import.meta.url).href
)) as typeof import('../src/config/secret-files.js');

// Explicit operator operation. Never imported by application startup.
export async function bootstrapDatabase(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  let client: pg.Client | undefined;
  try {
    const bootstrap = new URL(
      readSecretFile(env.MANAGEMENT_BOOTSTRAP_DATABASE_URL_FILE ?? ''),
    );
    const owner = new URL(
      readSecretFile(env.MANAGEMENT_MIGRATION_DATABASE_URL_FILE ?? ''),
    );
    const runtime = new URL(
      readSecretFile(env.MANAGEMENT_DATABASE_URL_FILE ?? ''),
    );
    if (
      ![bootstrap, owner, runtime].every(
        (url) =>
          ['postgres:', 'postgresql:'].includes(url.protocol) &&
          url.password &&
          !url.hash,
      ) ||
      owner.username !== 'management_owner' ||
      runtime.username !== 'management_runtime' ||
      owner.searchParams.get('schema') !== 'management' ||
      runtime.searchParams.get('schema') !== 'management' ||
      owner.password === runtime.password ||
      owner.password === bootstrap.password ||
      runtime.password === bootstrap.password ||
      ![owner, runtime].every(
        (url) =>
          url.hostname === bootstrap.hostname &&
          url.port === bootstrap.port &&
          url.pathname === bootstrap.pathname,
      )
    )
      throw new Error();
    client = new pg.Client({
      connectionString: bootstrap.toString(),
      connectionTimeoutMillis: 1000,
      statement_timeout: 5000,
    });
    client.on('error', () => {
      /* Never log driver error objects. */
    });
    await client.connect();
    // Disable SQL/parameter/error-statement logging BEFORE sending password parameters.
    await client.query(
      "SET log_statement='none'; SET log_parameter_max_length=0; SET log_parameter_max_length_on_error=0; SET log_min_error_statement='panic'; SET log_min_messages='panic'",
    );
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(913748,2)');
    const existing = await client.query(
      "SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolreplication,rolcanlogin FROM pg_roles WHERE rolname IN ('management_owner','management_runtime')",
    );
    if (
      existing.rows.some(
        (row) =>
          row.rolsuper ||
          row.rolcreatedb ||
          row.rolcreaterole ||
          row.rolbypassrls ||
          row.rolreplication ||
          !row.rolcanlogin,
      )
    )
      throw new Error();
    const memberships = await client.query(
      "SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname IN ('management_owner','management_runtime')",
    );
    if (memberships.rowCount) throw new Error();
    // Schema defaults are additive: a schema REVOKE cannot undo global grants.
    // Refuse unsafe adoption state; never rewrite policy for unrelated schemas.
    const globalTableDefaults = await client.query(`
      SELECT 1 FROM pg_default_acl d
      JOIN pg_roles owner_role ON owner_role.oid=d.defaclrole
      CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
      WHERE owner_role.rolname='management_owner'
        AND d.defaclnamespace=0 AND d.defaclobjtype='r'
        AND (acl.grantee=0 OR acl.grantee=(SELECT oid FROM pg_roles WHERE rolname='management_runtime'))
      LIMIT 1`);
    if (globalTableDefaults.rowCount) throw new Error();
    const schema = await client.query(
      "SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname='management'",
    );
    if (schema.rows.length && schema.rows[0].owner !== 'management_owner')
      throw new Error();
    if (
      schema.rows.length &&
      existing.rows.some((row) => row.rolname === 'management_runtime')
    ) {
      const elevated = await client.query(
        "SELECT has_schema_privilege('management_runtime','management','CREATE') AS value",
      );
      if (elevated.rows[0].value) throw new Error();
    }
    for (const role of existing.rows) {
      const elevated = await client.query(
        "SELECT has_database_privilege($1,current_database(),'CREATE') AS value",
        [role.rolname],
      );
      if (elevated.rows[0].value) throw new Error();
    }
    await client.query(
      "SELECT set_config('management.owner_password',$1,true), set_config('management.runtime_password',$2,true)",
      [
        decodeURIComponent(owner.password),
        decodeURIComponent(runtime.password),
      ],
    );
    await client.query(`DO $bootstrap$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='management_owner') THEN
        EXECUTE format('CREATE ROLE management_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', current_setting('management.owner_password'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='management_runtime') THEN
        EXECUTE format('CREATE ROLE management_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', current_setting('management.runtime_password'));
      END IF;
    END $bootstrap$`);
    await client.query(
      'CREATE SCHEMA IF NOT EXISTS management AUTHORIZATION management_owner',
    );
    await client.query(
      'REVOKE ALL ON SCHEMA management FROM PUBLIC; GRANT USAGE ON SCHEMA management TO management_runtime',
    );
    // No blanket/default DML. Future tables need reviewed explicit grants.
    await client.query(
      'ALTER DEFAULT PRIVILEGES FOR ROLE management_owner IN SCHEMA management REVOKE ALL ON TABLES FROM PUBLIC, management_runtime',
    );
    await client.query(
      'ALTER DEFAULT PRIVILEGES FOR ROLE management_owner IN SCHEMA management REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
    );
    const publicCreate = await client.query(
      "SELECT has_schema_privilege('management_runtime','public','CREATE') AS runtime, has_schema_privilege('management_owner','public','CREATE') AS owner",
    );
    if (publicCreate.rows[0].runtime || publicCreate.rows[0].owner)
      throw new Error(); // Refuse permissive existing public; never alter it.
    await client.query('COMMIT');
    for (const url of [owner, runtime]) {
      const probe = new pg.Client({
        connectionString: url.toString(),
        connectionTimeoutMillis: 1000,
        statement_timeout: 1000,
      });
      probe.on('error', () => {});
      try {
        await probe.connect();
        await probe.query('SELECT 1');
      } finally {
        await probe.end();
      }
    }
  } catch {
    try {
      await client?.query('ROLLBACK');
    } catch {
      /* sanitized */
    }
    throw new Error('Management database bootstrap failed.');
  } finally {
    await client?.end();
  }
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  try {
    await bootstrapDatabase();
    process.stdout.write('management_db_bootstrap_ok\n');
  } catch {
    process.stderr.write('management_db_bootstrap_failed\n');
    process.exitCode = 1;
  }
}
