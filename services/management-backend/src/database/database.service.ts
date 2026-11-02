import type { OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient, Prisma } from '../generated/prisma/client.js';
import type { ManagementConfig } from '../config/config.js';
import { ApiError } from '../common/errors.js';
import { SafeLogger } from '../common/safe-logger.js';

export type Tx = Prisma.TransactionClient;
export class DatabaseService implements OnModuleDestroy {
  readonly client: PrismaClient;
  private closed = false;
  constructor(
    config: Pick<
      ManagementConfig,
      'databaseUrl' | 'MANAGEMENT_DB_POOL_MAX' | 'MANAGEMENT_DB_POOL_TIMEOUT_MS'
    >,
    logger = new SafeLogger(),
  ) {
    const failure = () =>
      logger.event('request_failed', {
        code: 'dependency_unavailable',
        status: 503,
      });
    // pg reparses connectionString over config, so pin its startup GUC too.
    // This retains TLS/connection options without permitting an unbounded query.
    const databaseUrl = new URL(config.databaseUrl);
    databaseUrl.searchParams.set('statement_timeout', '1000');
    const pool = new Pool({
      connectionString: databaseUrl.toString(),
      max: Math.min(10, config.MANAGEMENT_DB_POOL_MAX),
      connectionTimeoutMillis: Math.min(
        1000,
        config.MANAGEMENT_DB_POOL_TIMEOUT_MS,
      ),
      statement_timeout: 1000,
    });
    pool.on('error', failure);
    const adapter = new PrismaPg(pool, {
      schema: 'management',
      disposeExternalPool: true,
      onPoolError: failure,
      onConnectionError: failure,
    });
    this.client = new PrismaClient({
      adapter,
      log: [],
      errorFormat: 'minimal',
      transactionOptions: { maxWait: 1000, timeout: 2000 },
    });
  }
  async transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.client.$transaction(work, {
        maxWait: 1000,
        timeout: 2000,
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const code = (error as { code?: string })?.code;
      if (code === 'P2002') throw new ApiError('conflict');
      throw new ApiError('dependency_unavailable');
    }
  }
  async now(tx: Tx): Promise<Date> {
    const rows = await tx.$queryRaw<
      { now: Date }[]
    >`SELECT clock_timestamp() AS now`;
    return rows[0].now;
  }
  async ready(): Promise<boolean> {
    try {
      const rows = await this.client.$queryRaw<{ ready: boolean }[]>`
        SELECT current_user='management_runtime'
          AND NOT pg_is_in_recovery()
          AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication)
          AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member=r.oid)
          AND NOT has_database_privilege(current_user,current_database(),'CREATE')
          AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='management' AND c.relowner=r.oid)
          AND NOT pg_has_role(current_user,'management_owner','MEMBER')
          AND NOT has_schema_privilege(current_user,'management','CREATE')
          AND NOT has_schema_privilege(current_user,'public','CREATE')
          AND (SELECT array_agg(tablename::text ORDER BY tablename)=ARRAY['agent_provisioning_receipts','agents','api_credentials','audit_logs','gateway_epochs','gateway_sources','monitoring_profiles','profile_versions','request_nonces','server_group_members','server_groups','server_profiles','servers']::text[] FROM pg_tables WHERE schemaname='management' AND tablename<>'_prisma_migrations')
          AND EXISTS (SELECT 1 FROM management._prisma_migrations WHERE migration_name='202611010001_management' AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM management._prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL)
          AND NOT has_table_privilege(current_user,'management.audit_logs','UPDATE,DELETE,TRUNCATE')
          AND NOT has_table_privilege(current_user,'management._prisma_migrations','INSERT,UPDATE,DELETE,TRUNCATE')
          AS ready FROM pg_roles r WHERE rolname=current_user`;
      return rows[0]?.ready === true;
    } catch {
      return false;
    }
  }
  async onModuleDestroy(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client.$disconnect(); // Adapter is the only pool disposal owner.
  }
}
