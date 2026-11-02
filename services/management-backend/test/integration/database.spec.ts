import { randomUUID } from 'node:crypto';
import { admin, runtimeAttempt, identity } from '../support/db.js';
import { readTestUrl } from '../support/pg-harness.js';
import { DatabaseService } from '../../src/database/database.service.js';
import { lockAgent } from '../../src/database/locks.js';
import { seedDatabase } from '../../scripts/seed-db.js';
import { bootstrapDatabase } from '../../scripts/bootstrap-db.js';
import { spawnSync } from 'node:child_process';
import { openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { countLeaks } from '../support/config.js';
import pg from 'pg';

const service = () =>
  new DatabaseService({
    databaseUrl: readTestUrl(identity().runtimeFile),
    MANAGEMENT_DB_POOL_MAX: 10,
    MANAGEMENT_DB_POOL_TIMEOUT_MS: 1000,
  });

// Removing SQL constraints or expanding runtime grants must break these real PG assertions.
describe('management catalog and least privilege', () => {
  it('connection URL startup parameters cannot disable the statement deadline', async () => {
    const url = new URL(readTestUrl(identity().runtimeFile));
    url.searchParams.set('statement_timeout', '0');
    url.searchParams.set('options', '-c statement_timeout=0');
    const db = new DatabaseService({
      databaseUrl: url.toString(),
      MANAGEMENT_DB_POOL_MAX: 10,
      MANAGEMENT_DB_POOL_TIMEOUT_MS: 1000,
    });
    try {
      const rows = await db.client.$queryRaw<
        { statement_timeout: string }[]
      >`SHOW statement_timeout`;
      expect(rows).toEqual([{ statement_timeout: '1s' }]);
    } finally {
      await db.onModuleDestroy();
    }
  });
  it('has all thirteen management tables and the partial active-agent unique index', async () => {
    const client = await admin();
    try {
      const tables = await client.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='management' AND tablename <> '_prisma_migrations' ORDER BY tablename",
      );
      expect(tables.rows.map((row) => row.tablename)).toEqual([
        'agent_provisioning_receipts',
        'agents',
        'api_credentials',
        'audit_logs',
        'gateway_epochs',
        'gateway_sources',
        'monitoring_profiles',
        'profile_versions',
        'request_nonces',
        'server_group_members',
        'server_groups',
        'server_profiles',
        'servers',
      ]);
      const indexes = await client.query(
        "SELECT indexdef FROM pg_indexes WHERE schemaname='management' AND indexname='agents_one_active_per_server'",
      );
      expect(indexes.rows[0]?.indexdef).toMatch(
        /UNIQUE.*server_id.*WHERE.*lifecycle.*active/,
      );
    } finally {
      await client.end();
    }
  });
  it('runtime cannot create, alter, drop or truncate business tables', async () => {
    for (const sql of [
      'CREATE TABLE management.forbidden(id int)',
      'ALTER TABLE management.servers ADD forbidden int',
      'DROP TABLE management.request_nonces',
      'TRUNCATE management.request_nonces',
    ]) {
      expect(await runtimeAttempt(sql)).toBe('42501');
    }
  });
  it('runtime cannot update or delete audit or mutate migration history', async () => {
    for (const sql of [
      "UPDATE management.audit_logs SET outcome='denied'",
      'DELETE FROM management.audit_logs',
      'DELETE FROM management._prisma_migrations',
      "UPDATE management._prisma_migrations SET logs='forbidden'",
      "INSERT INTO management._prisma_migrations(id,checksum,migration_name) VALUES ('forbidden','forbidden','forbidden')",
    ]) {
      expect(await runtimeAttempt(sql)).toBe('42501');
    }
  });
  it('runtime is not owner, superuser, role creator, DB creator, bypass-RLS or owner member', async () => {
    const client = await admin();
    try {
      const result = await client.query(
        "SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,pg_has_role(oid,'management_owner','MEMBER') AS owner_member FROM pg_roles WHERE rolname='management_runtime'",
      );
      expect(result.rows).toEqual([
        {
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolbypassrls: false,
          owner_member: false,
        },
      ]);
    } finally {
      await client.end();
    }
  });
  it('owner is management-only and new tables do not inherit runtime DML', async () => {
    const db = identity();
    const owner = new pg.Client({
      connectionString: readTestUrl(db.ownerFile),
      connectionTimeoutMillis: 1000,
      statement_timeout: 1000,
    });
    const table = `default_grants_${randomUUID().replaceAll('-', '')}`; // Generated identifier, never external SQL.
    try {
      await owner.connect();
      const role = await owner.query(
        "SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,has_schema_privilege(current_user,'public','CREATE') public_create,has_database_privilege(current_user,current_database(),'CREATE') database_create FROM pg_roles WHERE rolname=current_user",
      );
      expect(role.rows).toEqual([
        {
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolbypassrls: false,
          public_create: false,
          database_create: false,
        },
      ]);
      expect(
        (
          await owner.query(
            "SELECT DISTINCT pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='management' AND c.relkind='r'",
          )
        ).rows,
      ).toEqual([{ owner: 'management_owner' }]);
      expect(
        (
          await owner.query(
            "SELECT to_regclass('public._prisma_migrations') AS table_name",
          )
        ).rows,
      ).toEqual([{ table_name: null }]);
      await owner.query(`CREATE TABLE management.${table}(id integer)`);
      expect(await runtimeAttempt(`SELECT * FROM management.${table}`)).toBe(
        '42501',
      );
      expect(
        await runtimeAttempt(`INSERT INTO management.${table} VALUES(1)`),
      ).toBe('42501');
    } finally {
      await owner.query(`DROP TABLE IF EXISTS management.${table}`);
      await owner.end();
    }
  });
  it.each(['management_runtime', 'PUBLIC'] as const)(
    'bootstrap refuses existing global table defaults for %s without changing that policy',
    async (grantee) => {
      const db = identity();
      const client = await admin();
      const table = `global_defaults_${randomUUID().replaceAll('-', '')}`;
      const defaultsQuery =
        "SELECT defaclrole,defaclnamespace,defaclobjtype,defaclacl::text FROM pg_default_acl WHERE defaclrole=(SELECT oid FROM pg_roles WHERE rolname='management_owner') AND defaclnamespace=0 AND defaclobjtype='r' ORDER BY oid";
      const original = await client.query(defaultsQuery);
      try {
        // Only these two fixed grantees and a generated identifier enter SQL.
        await client.query(
          `ALTER DEFAULT PRIVILEGES FOR ROLE management_owner GRANT ALL ON TABLES TO ${grantee}`,
        );
        const injected = await client.query(defaultsQuery);
        expect(injected.rows).not.toEqual(original.rows);
        await client.query(
          `SET ROLE management_owner; CREATE TABLE management.${table}(id integer); RESET ROLE`,
        );
        // Prove the injected policy actually grants future-table access/TRUNCATE.
        expect(
          await runtimeAttempt(`SELECT * FROM management.${table}`),
        ).toBeNull();
        expect(await runtimeAttempt(`TRUNCATE management.${table}`)).toBeNull();
        const failure = await bootstrapDatabase({
          ...process.env,
          MANAGEMENT_BOOTSTRAP_DATABASE_URL_FILE: db.adminFile,
          MANAGEMENT_MIGRATION_DATABASE_URL_FILE: db.ownerFile,
          MANAGEMENT_DATABASE_URL_FILE: db.runtimeFile,
        }).then(
          () => null,
          (error: Error) => error.message,
        );
        // Refusal must not silently revoke global policy, even on failure.
        expect((await client.query(defaultsQuery)).rows).toEqual(injected.rows);
        expect(failure).toBe('Management database bootstrap failed.');
      } finally {
        try {
          await client.query('RESET ROLE');
          await client.query(`DROP TABLE IF EXISTS management.${table}`);
          await client.query(
            `ALTER DEFAULT PRIVILEGES FOR ROLE management_owner REVOKE ALL ON TABLES FROM ${grantee}`,
          );
          expect((await client.query(defaultsQuery)).rows).toEqual(
            original.rows,
          );
        } finally {
          await client.end();
        }
      }
    },
  );
  it('simultaneous independent registrations permit one active agent only', async () => {
    const first = await admin();
    const second = await admin();
    const id = randomUUID();
    try {
      await first.query(
        "INSERT INTO management.servers(id,name,os,environment) VALUES($1,'race','linux','test')",
        [id],
      );
      const insert = (client: typeof first) =>
        client.query(
          "INSERT INTO management.agents(id,server_id,os_at_registration) VALUES($1,$2,'linux')",
          [randomUUID(), id],
        );
      const results = await Promise.allSettled([insert(first), insert(second)]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results
          .filter((result) => result.status === 'rejected')
          .map((result) => (result.reason as { code: string }).code),
      ).toEqual(['23505']);
      expect(
        (
          await first.query(
            "SELECT id FROM management.agents WHERE server_id=$1 AND lifecycle='active'",
            [id],
          )
        ).rowCount,
      ).toBe(1);
    } finally {
      await first.end();
      await second.end();
    }
  });
  it('credential constraints enforce verifier width, allowed scopes, same-agent rotation and single successor', async () => {
    const client = await admin();
    const server = randomUUID(),
      otherServer = randomUUID(),
      agent = randomUUID(),
      otherAgent = randomUUID();
    const insert = (
      id: string,
      agentId: string,
      from: string | null,
      request = randomUUID(),
      hash = Buffer.alloc(32),
      scopes = ['metrics:write'],
    ) =>
      client.query(
        "INSERT INTO management.api_credentials(id,agent_id,public_prefix,secret_hash,scopes,expires_at,rotated_from_id,issuance_request_id,created_by) VALUES($1::uuid,$2,$1::text,$3,$4,clock_timestamp()+interval '1 day',$5,$6,'{}')",
        [id, agentId, hash, scopes, from, request],
      );
    try {
      await client.query(
        "INSERT INTO management.servers(id,name,os,environment) VALUES($1,'credential','linux','test'),($2,'other','linux','test')",
        [server, otherServer],
      );
      await client.query(
        "INSERT INTO management.agents(id,server_id,os_at_registration) VALUES($1,$2,'linux'),($3,$4,'linux')",
        [agent, server, otherAgent, otherServer],
      );
      const root = randomUUID();
      await insert(root, agent, null);
      await expect(
        insert(randomUUID(), otherAgent, root),
      ).rejects.toMatchObject({ code: '23503' });
      await expect(
        insert(randomUUID(), agent, null, randomUUID(), Buffer.alloc(31)),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        insert(randomUUID(), agent, null, randomUUID(), Buffer.alloc(32), [
          'admin',
        ]),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        insert(randomUUID(), agent, null, randomUUID(), Buffer.alloc(32), []),
      ).rejects.toMatchObject({ code: '23514' });
      const request = randomUUID();
      await insert(randomUUID(), agent, root, request);
      await expect(insert(randomUUID(), agent, root)).rejects.toMatchObject({
        code: '23505',
      });
      await expect(
        insert(randomUUID(), agent, null, request),
      ).rejects.toMatchObject({ code: '23505' });
      await client.query(
        "UPDATE management.agents SET lifecycle='retired',retired_at=clock_timestamp(),last_metric_seen_at='2026-01-02T00:00:00Z' WHERE id=$1",
        [otherAgent],
      );
      await expect(
        client.query(
          "UPDATE management.agents SET lifecycle='active',retired_at=NULL WHERE id=$1",
          [otherAgent],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query(
        "UPDATE management.agents SET last_metric_seen_at='2026-01-01T00:00:00Z' WHERE id=$1",
        [otherAgent],
      );
      expect(
        (
          await client.query(
            'SELECT last_metric_seen_at FROM management.agents WHERE id=$1',
            [otherAgent],
          )
        ).rows[0].last_metric_seen_at.toISOString(),
      ).toBe('2026-01-02T00:00:00.000Z');
    } finally {
      await client.end();
    }
  });
  it('native migration wrapper suppresses unexpected CLI stderr and URL values', () => {
    const db = identity();
    const preload = resolve(db.privateDir, 'cli-stderr.mjs');
    const marker = resolve(db.privateDir, 'cli-preload-receipt');
    const output = resolve(db.privateDir, 'wrapper-output.log');
    const sentinel = 'UNEXPECTED_PRIVATE_CLI_SENTINEL';
    writeFileSync(
      preload,
      `import{writeFileSync}from'node:fs';if(process.argv[1]?.replaceAll('\\\\','/').endsWith('/prisma/build/index.js')){writeFileSync(${JSON.stringify(marker)},'executed');process.stderr.write(${JSON.stringify(sentinel)});process.exit(3);}`,
      { mode: 0o600 },
    );
    // Direct pinned-CLI invocation by the real native-TS wrapper, with injected failure only.
    const fd = openSync(output, 'w', 0o600);
    let status: number | null;
    try {
      status = spawnSync(process.execPath, ['scripts/migrate-db.ts'], {
        cwd: resolve(import.meta.dirname, '../..'),
        env: {
          ...process.env,
          MANAGEMENT_MIGRATION_DATABASE_URL_FILE: db.ownerFile,
          NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        },
        stdio: ['ignore', fd, fd],
        timeout: 10_000,
      }).status;
    } finally {
      closeSync(fd);
    }
    expect(status!).toBe(1);
    expect(readFileSync(marker, 'utf8')).toBe('executed');
    const logs = readFileSync(output, 'utf8');
    expect(countLeaks(logs, [sentinel, readTestUrl(db.ownerFile)])).toBe(0);
    expect(logs.trim()).toBe('management_db_migrate_failed');
  });
  it('explicit native seed is idempotent and preserves immutable published v1', async () => {
    const env = {
      ...process.env,
      MANAGEMENT_MIGRATION_DATABASE_URL_FILE: identity().ownerFile,
      INGEST_GATEWAY_ID: '00000000-0000-4000-8000-000000000003',
    };
    await seedDatabase(env);
    const client = await admin();
    try {
      const query =
        "SELECT p.slug,p.os,v.id,v.config,v.checksum,v.published_at FROM management.monitoring_profiles p JOIN management.profile_versions v ON v.profile_id=p.id WHERE p.slug IN ('linux-base','windows-base') ORDER BY p.slug";
      const before = await client.query(query);
      await seedDatabase(env);
      const after = await client.query(query);
      expect(after.rows).toEqual(before.rows);
      expect(after.rowCount).toBe(2);
      for (const row of after.rows) {
        expect(row.config).toEqual({
          schema_version: 1,
          os: row.os,
          interval_seconds: 15,
          metric_groups: { cpu: true, memory: true, disk: true, network: true },
          options: {},
        });
        await expect(
          client.query(
            "UPDATE management.profile_versions SET config='{}' WHERE id=$1",
            [row.id],
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          client.query('DELETE FROM management.profile_versions WHERE id=$1', [
            row.id,
          ]),
        ).rejects.toMatchObject({ code: '23514' });
      }
      expect(
        (
          await client.query(
            'SELECT current_epoch FROM management.gateway_sources WHERE gateway_id=$1',
            [env.INGEST_GATEWAY_ID],
          )
        ).rows,
      ).toEqual([{ current_epoch: '0' }]);
    } finally {
      await client.end();
    }
  });
  it('bootstrap fails closed on existing elevated role instead of silently repairing it', async () => {
    const client = await admin();
    try {
      await client.query('ALTER ROLE management_runtime CREATEDB');
      await expect(
        bootstrapDatabase({
          ...process.env,
          MANAGEMENT_BOOTSTRAP_DATABASE_URL_FILE: identity().adminFile,
          MANAGEMENT_MIGRATION_DATABASE_URL_FILE: identity().ownerFile,
          MANAGEMENT_DATABASE_URL_FILE: identity().runtimeFile,
        }),
      ).rejects.toThrow('Management database bootstrap failed.');
      expect(
        (
          await client.query(
            "SELECT rolcreatedb FROM pg_roles WHERE rolname='management_runtime'",
          )
        ).rows[0].rolcreatedb,
      ).toBe(true);
      await client.query(
        'ALTER ROLE management_runtime NOCREATEDB; GRANT CREATE ON SCHEMA management TO management_runtime',
      );
      await expect(
        bootstrapDatabase({
          ...process.env,
          MANAGEMENT_BOOTSTRAP_DATABASE_URL_FILE: identity().adminFile,
          MANAGEMENT_MIGRATION_DATABASE_URL_FILE: identity().ownerFile,
          MANAGEMENT_DATABASE_URL_FILE: identity().runtimeFile,
        }),
      ).rejects.toThrow('Management database bootstrap failed.');
    } finally {
      await client.query(
        'ALTER ROLE management_runtime NOCREATEDB; REVOKE CREATE ON SCHEMA management FROM management_runtime',
      );
      await client.end();
    }
  });
  it('bounds SQL duration, reads database clock, serializes locks and maps active uniqueness to conflict', async () => {
    const db = service();
    const server = randomUUID();
    const agent = randomUUID();
    try {
      await db.transaction(async (tx) => {
        expect(await db.now(tx)).toBeInstanceOf(Date);
        await tx.server.create({
          data: {
            id: server,
            name: 'locked',
            os: 'linux',
            environment: 'test',
          },
        });
        await tx.agent.create({
          data: { id: agent, server_id: server, os_at_registration: 'linux' },
        });
        await lockAgent(tx, server, agent);
      });
      await expect(
        db.transaction((tx) =>
          tx.agent.create({
            data: {
              id: randomUUID(),
              server_id: server,
              os_at_registration: 'linux',
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'conflict' });
      const start = performance.now();
      await expect(
        db.transaction((tx) => tx.$executeRaw`SELECT pg_sleep(5)`),
      ).rejects.toMatchObject({ code: 'dependency_unavailable' });
      expect(performance.now() - start).toBeLessThan(3000);
      const holder = await admin();
      try {
        await holder.query('BEGIN');
        await holder.query(
          'SELECT id FROM management.servers WHERE id=$1 FOR UPDATE',
          [server],
        );
        await expect(
          db.transaction((tx) => lockAgent(tx, server, agent)),
        ).rejects.toMatchObject({ code: 'dependency_unavailable' });
      } finally {
        await holder.query('ROLLBACK');
        await holder.end();
      }
      expect(await db.ready()).toBe(true);
    } finally {
      await db.onModuleDestroy();
      await db.onModuleDestroy();
    }
  });
  it('FK history rejects orphan and hard deletion; agent server cannot change', async () => {
    const client = await admin();
    const server = randomUUID();
    const other = randomUUID();
    const agent = randomUUID();
    try {
      await expect(
        client.query(
          "INSERT INTO management.agents(id,server_id,os_at_registration) VALUES($1,$2,'linux')",
          [agent, server],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      await client.query(
        "INSERT INTO management.servers(id,name,os,environment) VALUES($1,'fk','linux','test'),($2,'other','linux','test')",
        [server, other],
      );
      await client.query(
        "INSERT INTO management.agents(id,server_id,os_at_registration) VALUES($1,$2,'linux')",
        [agent, server],
      );
      await expect(
        client.query('DELETE FROM management.servers WHERE id=$1', [server]),
      ).rejects.toMatchObject({ code: '23001' }); // PostgreSQL RESTRICT violation (not orphan FK 23503).
      await expect(
        client.query('UPDATE management.agents SET server_id=$1 WHERE id=$2', [
          other,
          agent,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.end();
    }
  });
});
