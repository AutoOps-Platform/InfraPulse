import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ApiError } from '../common/errors.js';
import { DatabaseService, type Tx } from '../database/database.service.js';

// Single fixed transaction advisory lock serializes the global live cap across app restarts/processes.
export class NonceService implements OnModuleInit, OnModuleDestroy {
  private cleanupTimer?: ReturnType<typeof setInterval>;
  constructor(
    private readonly database: DatabaseService,
    private readonly maximum = 20_000,
  ) {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 20_000)
      throw new ApiError('dependency_unavailable');
  }
  onModuleInit() {
    this.cleanupTimer = setInterval(() => {
      void this.cleanup().catch(() => {
        /* Next reservation still fails closed on DB failure. */
      });
    }, 60_000);
    this.cleanupTimer.unref();
  }
  onModuleDestroy() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }
  private async lock(tx: Tx) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(7173003)::text`;
  }
  private async removeExpired(tx: Tx, now: Date, batch: number) {
    await tx.$executeRaw`DELETE FROM management.request_nonces WHERE (issuer,jti) IN (SELECT issuer,jti FROM management.request_nonces WHERE expires_at <= ${now} ORDER BY expires_at LIMIT ${batch})`;
  }
  private async cleanup() {
    await this.database.transaction(async (tx) => {
      await this.lock(tx);
      await this.removeExpired(tx, await this.database.now(tx), 20_000);
    });
  }
  async reserve(issuer: string, jti: string, expiresAt: Date): Promise<void> {
    try {
      await this.database.transaction(async (tx) => {
        await this.lock(tx);
        const now = await this.database.now(tx);
        const retainUntil = new Date(expiresAt.getTime() + 5000);
        if (!Number.isFinite(retainUntil.getTime()) || retainUntil <= now)
          throw new ApiError('unauthorized');
        await this.removeExpired(tx, now, 512);
        if (
          await tx.requestNonce.findUnique({
            where: { issuer_jti: { issuer, jti } },
          })
        )
          throw new ApiError('unauthorized');
        if (
          (await tx.requestNonce.count({
            where: { expires_at: { gt: now } },
          })) >= this.maximum
        )
          throw new ApiError('dependency_unavailable');
        await tx.requestNonce.create({
          data: { issuer, jti, expires_at: retainUntil },
        });
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'conflict')
        throw new ApiError('unauthorized');
      if (error instanceof ApiError && error.code === 'unauthorized')
        throw error;
      throw new ApiError('dependency_unavailable');
    }
  }
}
