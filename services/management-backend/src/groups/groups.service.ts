import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService, type Tx } from '../database/database.service.js';
import { lockServer } from '../database/locks.js';
import { AuditService } from '../audit/audit.service.js';
import type { UserPrincipal } from '../auth/principal.js';
import { ApiError } from '../common/errors.js';
import { parsePage, type Page, type PageQuery } from '../common/pagination.js';
import {
  inventoryId,
  inventoryPage,
  pageCursor,
} from '../servers/servers.dto.js';
import {
  GROUP_FILTERS,
  CreateGroupDto,
  PatchGroupDto,
  groupSelect,
  groupDto,
  type GroupDto,
} from './groups.dto.js';
async function lockGroup(tx: Tx, id: string): Promise<void> {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM management.server_groups WHERE id=${id}::uuid FOR UPDATE`;
  if (rows.length !== 1) throw new ApiError('not_found');
}
@Injectable()
export class GroupsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}
  async create(
    input: CreateGroupDto,
    actor: UserPrincipal,
    requestId: string,
  ): Promise<GroupDto> {
    return this.db.transaction(async (tx) => {
      const now = await this.db.now(tx);
      const row = await tx.serverGroup.create({
        data: {
          id: randomUUID(),
          name: input.name,
          slug: input.slug,
          created_at: now,
          updated_at: now,
        },
        select: groupSelect,
      });
      await this.audit.append(tx, {
        actor,
        operation: 'create',
        target: { type: 'group', id: row.id },
        outcome: 'success',
        request_id: requestId,
        delta: { name: row.name },
      });
      return groupDto(row);
    });
  }
  async list(query: PageQuery): Promise<Page<GroupDto>> {
    const page = parsePage(query, GROUP_FILTERS);
    return this.db.transaction(async (tx) => {
      const cursor = await pageCursor(page, (id) =>
        tx.serverGroup.findUnique({
          where: { id },
          select: { created_at: true },
        }),
      );
      const rows = await tx.serverGroup.findMany({
        ...cursor,
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        take: page.limit + 1,
        select: groupSelect,
      });
      return inventoryPage(rows, page, groupDto);
    });
  }
  async get(id: string): Promise<GroupDto> {
    inventoryId(id);
    return this.db.transaction(async (tx) => {
      const row = await tx.serverGroup.findUnique({
        where: { id },
        select: groupSelect,
      });
      if (!row) throw new ApiError('not_found');
      return groupDto(row);
    });
  }
  async update(
    id: string,
    input: PatchGroupDto,
    actor: UserPrincipal,
    requestId: string,
  ): Promise<GroupDto> {
    inventoryId(id);
    return this.db.transaction(async (tx) => {
      await lockGroup(tx, id);
      const row = await tx.serverGroup.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
          updated_at: await this.db.now(tx),
        },
        select: groupSelect,
      });
      await this.audit.append(tx, {
        actor,
        operation: 'update',
        target: { type: 'group', id },
        outcome: 'success',
        request_id: requestId,
        delta: { ...(input.name !== undefined ? { name: input.name } : {}) },
      });
      return groupDto(row);
    });
  }
  async delete(
    id: string,
    actor: UserPrincipal,
    requestId: string,
  ): Promise<void> {
    inventoryId(id);
    await this.db.transaction(async (tx) => {
      await lockGroup(tx, id);
      await tx.serverGroupMember.deleteMany({ where: { group_id: id } });
      await tx.serverGroup.delete({ where: { id }, select: { id: true } });
      await this.audit.append(tx, {
        actor,
        operation: 'archive',
        target: { type: 'group', id },
        outcome: 'success',
        request_id: requestId,
        delta: { group_id: id },
      });
    });
  }
  async membership(
    id: string,
    serverId: string,
    add: boolean,
    actor: UserPrincipal,
    requestId: string,
  ): Promise<void> {
    inventoryId(id);
    inventoryId(serverId);
    await this.db.transaction(async (tx) => {
      await lockServer(tx, serverId);
      await lockGroup(tx, id);
      if (add) {
        const server = await tx.server.findUniqueOrThrow({
          where: { id: serverId },
          select: { archived_at: true },
        });
        if (server.archived_at) throw new ApiError('conflict');
        await tx.serverGroupMember.upsert({
          where: { server_id_group_id: { server_id: serverId, group_id: id } },
          create: { server_id: serverId, group_id: id },
          update: {},
          select: { server_id: true },
        });
      } else
        await tx.serverGroupMember.deleteMany({
          where: { server_id: serverId, group_id: id },
        });
      await this.audit.append(tx, {
        actor,
        operation: 'group_membership',
        target: { type: 'group', id },
        outcome: 'success',
        request_id: requestId,
        delta: {
          server_id: serverId,
          group_id: id,
          result: add ? 'added' : 'removed',
        },
      });
    });
  }
}
