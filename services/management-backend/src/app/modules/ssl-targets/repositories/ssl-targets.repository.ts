import { Injectable } from '@nestjs/common';
import type { Prisma, SslTarget } from '../../../../generated/prisma/client.js';
import type { Tx } from '../../../prisma/prisma.service.js';

@Injectable()
export class SslTargetsRepository {
  list(tx: Tx, where?: Prisma.SslTargetWhereInput): Promise<SslTarget[]> {
    return tx.sslTarget.findMany({
      where,
      orderBy: [{ not_after: { sort: 'asc', nulls: 'first' } }, { created_at: 'desc' }],
      take: 200,
    });
  }

  findById(tx: Tx, id: string): Promise<SslTarget | null> {
    return tx.sslTarget.findUnique({ where: { id } });
  }

  create(tx: Tx, data: Prisma.SslTargetCreateInput): Promise<SslTarget> {
    return tx.sslTarget.create({ data });
  }

  update(tx: Tx, id: string, data: Prisma.SslTargetUpdateInput): Promise<SslTarget> {
    return tx.sslTarget.update({ where: { id }, data });
  }

  delete(tx: Tx, id: string): Promise<SslTarget> {
    return tx.sslTarget.delete({ where: { id } });
  }
}
