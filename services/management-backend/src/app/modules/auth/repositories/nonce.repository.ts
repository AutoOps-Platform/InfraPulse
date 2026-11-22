import { Injectable } from '@nestjs/common';
import type { Tx } from '../../../prisma/prisma.service.js';

@Injectable()
export class NonceRepository {
  async lock(tx: Tx): Promise<void> {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(7173003)::text`;
  }

  async removeExpired(tx: Tx, now: Date, batch: number): Promise<void> {
    await tx.$executeRaw`DELETE FROM request_nonces WHERE (issuer,jti) IN (SELECT issuer,jti FROM request_nonces WHERE expires_at <= ${now} ORDER BY expires_at LIMIT ${batch})`;
  }

  async has(tx: Tx, issuer: string, jti: string): Promise<boolean> {
    const found = await tx.requestNonce.findUnique({
      where: { issuer_jti: { issuer, jti } },
    });
    return Boolean(found);
  }

  countLive(tx: Tx, now: Date): Promise<number> {
    return tx.requestNonce.count({ where: { expires_at: { gt: now } } });
  }

  async insert(tx: Tx, issuer: string, jti: string, retainUntil: Date): Promise<void> {
    await tx.requestNonce.create({
      data: { issuer, jti, expires_at: retainUntil },
    });
  }
}
