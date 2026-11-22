import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ApiError } from '../../../common/errors.js';
import { PrismaService, databaseNow } from '../../../prisma/prisma.service.js';
import { NonceRepository } from '../repositories/nonce.repository.js';

@Injectable()
export class NonceService implements OnModuleInit, OnModuleDestroy {
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: NonceRepository,
    private readonly maximum = 20_000,
  ) {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 20_000) {
      throw new ApiError('dependency_unavailable');
    }
  }

  onModuleInit(): void {
    this.cleanupTimer = setInterval(() => {
      void this.cleanup().catch(() => {});
    }, 60_000);
    this.cleanupTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  private async cleanup(): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.repo.lock(tx);
      await this.repo.removeExpired(tx, await databaseNow(tx), 20_000);
    });
  }

  async reserve(issuer: string, jti: string, expiresAt: Date): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.repo.lock(tx);
        const now = await databaseNow(tx);
        const retainUntil = new Date(expiresAt.getTime() + 5000);
        if (!Number.isFinite(retainUntil.getTime()) || retainUntil <= now) {
          throw new ApiError('unauthorized');
        }
        await this.repo.removeExpired(tx, now, 512);
        if (await this.repo.has(tx, issuer, jti)) {
          throw new ApiError('unauthorized');
        }
        if ((await this.repo.countLive(tx, now)) >= this.maximum) {
          throw new ApiError('dependency_unavailable');
        }
        await this.repo.insert(tx, issuer, jti, retainUntil);
      });
    } catch (error) {
      if (
        (error as { code?: unknown } | null)?.code === 'P2002' ||
        (error instanceof ApiError && error.code === 'conflict')
      ) {
        throw new ApiError('unauthorized');
      }
      if (error instanceof ApiError && error.code === 'unauthorized') throw error;
      throw new ApiError('dependency_unavailable');
    }
  }
}
