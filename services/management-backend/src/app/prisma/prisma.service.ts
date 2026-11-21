import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '../../generated/prisma/client.js';
import type { ManagementConfig } from '../../config/app.config.js';
import { ApiError, SafeLogger } from '../common/errors.js';

export type Tx = Prisma.TransactionClient;

export type ConnectionSettings = Pick<
  ManagementConfig,
  'databaseUrl' | 'MANAGEMENT_DB_POOL_MAX' | 'MANAGEMENT_DB_POOL_TIMEOUT_MS'
>;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  private shutdown?: Promise<void>;

  constructor(config: ConnectionSettings, logger = new SafeLogger()) {
    const failure = () =>
      logger.event('request_failed', { code: 'dependency_unavailable', status: 503 });
    super({
      adapter: new PrismaPg(
        {
          connectionString: config.databaseUrl,
          max: Math.min(10, config.MANAGEMENT_DB_POOL_MAX),
          connectionTimeoutMillis: Math.min(1000, config.MANAGEMENT_DB_POOL_TIMEOUT_MS),
          statement_timeout: 1000,
        },
        { onPoolError: failure, onConnectionError: failure },
      ),
      log: [],
      errorFormat: 'minimal',
      transactionOptions: { maxWait: 1000, timeout: 2000 },
    });
  }

  onModuleDestroy(): Promise<void> {
    return (this.shutdown ??= this.$disconnect());
  }
}

export async function databaseNow(tx: Tx): Promise<Date> {
  const [row] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  return row.now;
}

export async function lockServer(tx: Tx, id: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM servers WHERE id=${id}::uuid FOR UPDATE`;
  if (!rows.length) throw new ApiError('not_found');
}

export function throwDatabaseError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  const code = (error as { code?: unknown } | null)?.code;
  throw new ApiError(code === 'P2002' ? 'conflict' : 'dependency_unavailable');
}
