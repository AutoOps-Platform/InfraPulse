import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { StatusService } from '../status/status.service.js';
import { DatabaseService, type Tx } from '../database/database.service.js';
import { lockServer, lockAgent } from '../database/locks.js';
import { AuditService } from '../audit/audit.service.js';
import type { UserPrincipal } from '../auth/principal.js';
import { ApiError } from '../common/errors.js';
import { parsePage, type PageQuery, type Page } from '../common/pagination.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  CreateServerDto,
  PatchServerDto,
  type ServerDto,
  SERVER_FILTERS,
  enumFilter,
  inventoryId,
  inventoryPage,
  pageCursor,
  serverDto,
  serverSelect,
} from './servers.dto.js';

// Caller owns Server lock. Recheck cross-table assignment inside that transaction.
export async function compatibleAssignment(
  tx: Tx,
  serverId: string,
  os: string,
): Promise<void> {
  const assignment = await tx.serverProfile.findUnique({
    where: { server_id: serverId },
    select: {
      profile_version: {
        select: {
          status: true,
          profile: { select: { os: true } },
        },
      },
    },
  });
  if (
    assignment &&
    (assignment.profile_version.status !== 'published' ||
      assignment.profile_version.profile.os !== os)
  )
    throw new ApiError('conflict');
}
@Injectable()
export class ServersService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(StatusService) private readonly status: StatusService,
  ) {}
  async create(
    input: CreateServerDto,
    actor: UserPrincipal,
    requestId: string,
  ): Promise<ServerDto> {
    return this.db.transaction(async (tx) => {
      const now = await this.db.now(tx);
      const row = await tx.server.create({
        data: {
          id: randomUUID(),
          name: input.name,
          os: input.os,
          environment: input.environment,
          metadata: input.metadata ?? {},
          created_at: now,
          updated_at: now,
        },
        select: serverSelect,
      });
      await this.audit.append(tx, {
        actor,
        operation: 'create',
        target: { type: 'server', id: row.id },
        outcome: 'success',
        request_id: requestId,
        delta: { name: row.name, os: row.os, environment: row.environment },
      });
      return serverDto(row, (await this.status.projectServers(tx, [row.id])).get(row.id)!);
    });
  }
  async list(query: PageQuery): Promise<Page<ServerDto>> {
    const page = parsePage(query, SERVER_FILTERS);
    const f = page.filters;
    enumFilter(f.os, ['linux', 'windows']);
    enumFilter(f.archive, ['true', 'false']);
    if (f.group) inventoryId(f.group);
    if (f.environment && f.environment.length > 64)
      throw new ApiError('invalid_request');
    const where: Prisma.ServerWhereInput = {
      ...(f.os ? { os: f.os } : {}),
      ...(f.environment ? { environment: f.environment } : {}),
      ...(f.group ? { memberships: { some: { group_id: f.group } } } : {}),
      ...(f.archive
        ? { archived_at: f.archive === 'true' ? { not: null } : null }
        : {}),
      // Prisma startsWith emits LIKE; escape metacharacters for literal prefix semantics.
      ...(f.name
        ? { name: { startsWith: f.name.replace(/[\\%_]/g, '\\$&') } }
        : {}),
    };
    return this.db.transaction(async (tx) => {
      const cursor = await pageCursor(page, (id) =>
        tx.server.findUnique({ where: { id }, select: { created_at: true } }),
      );
      const rows = await tx.server.findMany({
        where,
        ...cursor,
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        take: page.limit + 1,
        select: serverSelect,
      });
      const telemetry = await this.status.projectServers(tx, rows.map(row => row.id));
      return inventoryPage(rows, page, row => serverDto(row, telemetry.get(row.id)!));
    });
  }
  async get(id: string): Promise<ServerDto> {
    inventoryId(id);
    return this.db.transaction(async (tx) => {
      const row = await tx.server.findUnique({
        where: { id },
        select: serverSelect,
      });
      if (!row) throw new ApiError('not_found');
      return serverDto(row, (await this.status.projectServers(tx, [row.id])).get(row.id)!);
    });
  }
  async update(
    id: string,
    input: PatchServerDto,
    actor: UserPrincipal,
    requestId: string,
  ): Promise<ServerDto> {
    inventoryId(id);
    return this.db.transaction(async (tx) => {
      await lockServer(tx, id);
      const current = await tx.server.findUniqueOrThrow({
        where: { id },
        select: serverSelect,
      });
      if (current.archived_at) throw new ApiError('conflict');
      if (input.os && input.os !== current.os) {
        if (
          await tx.agent.count({
            where: { server_id: id, lifecycle: 'active' },
          })
        )
          throw new ApiError('conflict');
        await compatibleAssignment(tx, id, input.os);
      }
      const row = await tx.server.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.os !== undefined ? { os: input.os } : {}),
          ...(input.environment !== undefined
            ? { environment: input.environment }
            : {}),
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
          updated_at: await this.db.now(tx),
        },
        select: serverSelect,
      });
      await this.audit.append(tx, {
        actor,
        operation: 'update',
        target: { type: 'server', id },
        outcome: 'success',
        request_id: requestId,
        delta: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.os !== undefined ? { os: input.os } : {}),
          ...(input.environment !== undefined
            ? { environment: input.environment }
            : {}),
        },
      });
      return serverDto(row, (await this.status.projectServers(tx, [row.id])).get(row.id)!);
    });
  }
  async archive(
    id: string,
    actor: UserPrincipal,
    requestId: string,
  ): Promise<void> {
    inventoryId(id);
    await this.db.transaction(async (tx) => {
      await lockServer(tx, id);
      const now = await this.db.now(tx);
      // Retain every Agent and key row. Lock even disabled/retired histories so
      // future issuance uses the same Server→Agent→Credential order.
      const agents = await tx.agent.findMany({
        where: { server_id: id },
        orderBy: { id: 'asc' },
        select: { id: true, lifecycle: true },
      });
      for (const agent of agents) {
        await lockAgent(tx, id, agent.id);
        await tx.apiCredential.updateMany({
          where: { agent_id: agent.id, revoked_at: null },
          data: { revoked_at: now },
        });
        if (agent.lifecycle === 'active')
          await tx.agent.update({
            where: { id: agent.id },
            data: { lifecycle: 'disabled', updated_at: now },
            select: { id: true },
          });
      }
      const existing = await tx.server.findUniqueOrThrow({
        where: { id },
        select: { archived_at: true },
      });
      await tx.server.update({
        where: { id },
        data: {
          ...(existing.archived_at ? {} : { archived_at: now }),
          updated_at: now,
        },
        select: { id: true },
      });
      await this.audit.append(tx, {
        actor,
        operation: 'archive',
        target: { type: 'server', id },
        outcome: 'success',
        request_id: requestId,
        delta: { archived_at: (existing.archived_at ?? now).toISOString() },
      });
    });
  }
}
