import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ApiError } from '../../../common/errors.js';
import {
  inventoryId,
  inventoryPage,
  parsePage,
  type Page,
  type PageQuery,
} from '../../../common/pagination.js';
import { PrismaService, databaseNow, throwDatabaseError } from '../../../prisma/prisma.service.js';
import { AuditService } from '../../audit/services/audit.service.js';
import type { UserPrincipal } from '../../auth/guards/auth.guard.js';
import {
  CreateGroupDto,
  GROUP_FILTERS,
  PatchGroupDto,
  groupDto,
  type GroupDto,
} from '../dto/groups.dto.js';
import { GroupsRepository } from '../repositories/groups.repository.js';

@Injectable()
export class GroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly repo: GroupsRepository,
  ) {}

  async create(input: CreateGroupDto, actor: UserPrincipal, requestId: string): Promise<GroupDto> {
    return this.prisma
      .$transaction(async (tx) => {
        const now = await databaseNow(tx);
        const row = await this.repo.create(tx, {
          id: randomUUID(),
          name: input.name,
          slug: input.slug,
          created_at: now,
          updated_at: now,
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
      })
      .catch(throwDatabaseError);
  }

  async list(query: PageQuery): Promise<Page<GroupDto>> {
    const page = parsePage(query, GROUP_FILTERS);
    return this.prisma
      .$transaction(async (tx) => {
        const rows = await this.repo.list(tx, page);
        return inventoryPage(rows, page, groupDto);
      })
      .catch(throwDatabaseError);
  }

  async get(id: string): Promise<GroupDto> {
    inventoryId(id);
    return this.prisma
      .$transaction(async (tx) => {
        const row = await this.repo.find(tx, id);
        if (!row) throw new ApiError('not_found');
        return groupDto(row);
      })
      .catch(throwDatabaseError);
  }

  async update(
    id: string,
    input: PatchGroupDto,
    actor: UserPrincipal,
    requestId: string,
  ): Promise<GroupDto> {
    inventoryId(id);
    return this.prisma
      .$transaction(async (tx) => {
        await this.repo.lock(tx, id);
        const row = await this.repo.update(tx, id, {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
          updated_at: await databaseNow(tx),
        });
        await this.audit.append(tx, {
          actor,
          operation: 'update',
          target: { type: 'group', id },
          outcome: 'success',
          request_id: requestId,
          delta: input.name !== undefined ? { name: input.name } : {},
        });
        return groupDto(row);
      })
      .catch(throwDatabaseError);
  }

  async delete(id: string, actor: UserPrincipal, requestId: string): Promise<void> {
    inventoryId(id);
    await this.prisma
      .$transaction(async (tx) => {
        await this.repo.lock(tx, id);
        await this.repo.delete(tx, id);
        await this.audit.append(tx, {
          actor,
          operation: 'archive',
          target: { type: 'group', id },
          outcome: 'success',
          request_id: requestId,
          delta: { group_id: id },
        });
      })
      .catch(throwDatabaseError);
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
    await this.prisma
      .$transaction(async (tx) => {
        await this.repo.lockServer(tx, serverId);
        await this.repo.lock(tx, id);
        if (add && (await this.repo.serverArchived(tx, serverId))) {
          throw new ApiError('conflict');
        }
        await this.repo.setMembership(tx, id, serverId, add);
        await this.audit.append(tx, {
          actor,
          operation: 'group_membership',
          target: { type: 'group', id },
          outcome: 'success',
          request_id: requestId,
          delta: { server_id: serverId, group_id: id, result: add ? 'added' : 'removed' },
        });
      })
      .catch(throwDatabaseError);
  }
}
