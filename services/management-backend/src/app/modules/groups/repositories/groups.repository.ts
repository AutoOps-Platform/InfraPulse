import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../../generated/prisma/client.js';
import { ApiError } from '../../../common/errors.js';
import { pageCursor, type PageSpec } from '../../../common/pagination.js';
import { lockServer, type Tx } from '../../../prisma/prisma.service.js';
import { groupSelect } from '../dto/groups.dto.js';

export type GroupRecord = Prisma.ServerGroupGetPayload<{ select: typeof groupSelect }>;

@Injectable()
export class GroupsRepository {
  async lock(tx: Tx, id: string): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM server_groups WHERE id=${id}::uuid FOR UPDATE`;
    if (rows.length !== 1) throw new ApiError('not_found');
  }

  lockServer(tx: Tx, id: string): Promise<void> {
    return lockServer(tx, id);
  }

  find(tx: Tx, id: string): Promise<GroupRecord | null> {
    return tx.serverGroup.findUnique({ where: { id }, select: groupSelect });
  }

  async list(tx: Tx, page: PageSpec): Promise<GroupRecord[]> {
    const cursor = await pageCursor(page, (id) =>
      tx.serverGroup.findUnique({ where: { id }, select: { created_at: true } }),
    );
    return tx.serverGroup.findMany({
      ...cursor,
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      take: page.limit + 1,
      select: groupSelect,
    });
  }

  create(tx: Tx, data: Prisma.ServerGroupUncheckedCreateInput): Promise<GroupRecord> {
    return tx.serverGroup.create({ data, select: groupSelect });
  }

  update(tx: Tx, id: string, data: Prisma.ServerGroupUncheckedUpdateInput): Promise<GroupRecord> {
    return tx.serverGroup.update({ where: { id }, data, select: groupSelect });
  }

  async delete(tx: Tx, id: string): Promise<void> {
    await tx.serverGroupMember.deleteMany({ where: { group_id: id } });
    await tx.serverGroup.delete({ where: { id }, select: { id: true } });
  }

  async serverArchived(tx: Tx, id: string): Promise<boolean> {
    const row = await tx.server.findUniqueOrThrow({
      where: { id },
      select: { archived_at: true },
    });
    return row.archived_at !== null;
  }

  async setMembership(tx: Tx, id: string, serverId: string, add: boolean): Promise<void> {
    if (add) {
      await tx.serverGroupMember.upsert({
        where: { server_id_group_id: { server_id: serverId, group_id: id } },
        create: { server_id: serverId, group_id: id },
        update: {},
        select: { server_id: true },
      });
    } else {
      await tx.serverGroupMember.deleteMany({
        where: { server_id: serverId, group_id: id },
      });
    }
  }
}
