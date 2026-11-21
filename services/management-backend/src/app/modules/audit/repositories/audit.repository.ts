import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../../generated/prisma/client.js';
import { pageCursor, type PageSpec } from '../../../common/pagination.js';
import type { Tx } from '../../../prisma/prisma.service.js';
import { auditSelect } from '../dto/audit.dto.js';

export type AuditRecord = Prisma.AuditLogGetPayload<{ select: typeof auditSelect }>;

@Injectable()
export class AuditRepository {
  async list(
    tx: Tx,
    page: PageSpec,
    where: Prisma.AuditLogWhereInput,
  ): Promise<AuditRecord[]> {
    const cursor = await pageCursor(page, (id) =>
      tx.auditLog.findUnique({ where: { id }, select: { created_at: true } }),
    );
    return tx.auditLog.findMany({
      where,
      ...cursor,
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      take: page.limit + 1,
      select: auditSelect,
    });
  }

  async append(tx: Tx, data: Prisma.AuditLogUncheckedCreateInput): Promise<void> {
    await tx.auditLog.create({ data, select: { id: true } });
  }
}
