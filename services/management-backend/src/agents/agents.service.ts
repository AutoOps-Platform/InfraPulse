import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { StatusService } from '../status/status.service.js';
import { DatabaseService } from '../database/database.service.js';
import { lockAgent, lockServer } from '../database/locks.js';
import { AuditService } from '../audit/audit.service.js';
import type { UserPrincipal } from '../auth/principal.js';
import { ApiError } from '../common/errors.js';
import { parsePage, type Page, type PageQuery } from '../common/pagination.js';
import { compatibleAssignment } from '../servers/servers.service.js';
import {
  enumFilter,
  inventoryId,
  inventoryPage,
  pageCursor,
} from '../servers/servers.dto.js';
import {
  AGENT_FILTERS,
  RegisterAgentDto,
  agentSelect,
  agentDto,
  type AgentDto,
} from './agents.dto.js';
@Injectable()
export class AgentsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(StatusService) private readonly status: StatusService,
  ) {}
  async register(
    serverId: string,
    input: RegisterAgentDto,
    actor: UserPrincipal,
    requestId: string,
  ): Promise<AgentDto> {
    inventoryId(serverId);
    return this.db.transaction(async (tx) => {
      await lockServer(tx, serverId);
      const server = await tx.server.findUniqueOrThrow({
        where: { id: serverId },
        select: { archived_at: true, os: true },
      });
      if (
        server.archived_at ||
        (await tx.agent.count({
          where: { server_id: serverId, lifecycle: 'active' },
        }))
      )
        throw new ApiError('conflict');
      await compatibleAssignment(tx, serverId, server.os);
      const now = await this.db.now(tx);
      const row = await tx.agent.create({
        data: {
          id: randomUUID(),
          server_id: serverId,
          os_at_registration: server.os,
          agent_type: input.agent_type ?? 'telegraf',
          lifecycle: 'active',
          registered_at: now,
          created_at: now,
          updated_at: now,
        },
        select: agentSelect,
      });
      await this.audit.append(tx, {
        actor,
        operation: 'register',
        target: { type: 'agent', id: row.id },
        outcome: 'success',
        request_id: requestId,
        delta: { server_id: serverId, lifecycle: 'active' },
      });
      return agentDto(row, (await this.status.projectAgents(tx, [row])).get(row.id)!);
    });
  }
  async transition(
    id: string,
    action: 'disable' | 'enable' | 'retire',
    actor: UserPrincipal,
    requestId: string,
  ): Promise<AgentDto> {
    inventoryId(id);
    return this.db.transaction(async (tx) => {
      // Immutable server_id can be read before acquiring its parent lock.
      const identity = await tx.agent.findUnique({
        where: { id },
        select: { server_id: true },
      });
      if (!identity) throw new ApiError('not_found');
      await lockAgent(tx, identity.server_id, id);
      const row = await tx.agent.findUniqueOrThrow({
        where: { id },
        select: agentSelect,
      });
      const server = await tx.server.findUniqueOrThrow({
        where: { id: row.server_id },
        select: { os: true, archived_at: true },
      });
      if (row.lifecycle === 'retired' && action !== 'retire')
        throw new ApiError('conflict');
      const now = await this.db.now(tx);
      if (action === 'enable') {
        if (
          server.archived_at ||
          server.os !== row.os_at_registration ||
          (await tx.agent.count({
            where: {
              server_id: row.server_id,
              lifecycle: 'active',
              id: { not: id },
            },
          }))
        )
          throw new ApiError('conflict');
        await compatibleAssignment(tx, row.server_id, server.os);
      } else {
        // Revoke all nonrevoked rows, including overlapping/expired keys, never
        // deleting history or clearing an earlier revocation timestamp.
        await tx.apiCredential.updateMany({
          where: { agent_id: id, revoked_at: null },
          data: { revoked_at: now },
        });
      }
      const lifecycle =
        action === 'enable'
          ? 'active'
          : action === 'disable'
            ? 'disabled'
            : 'retired';
      const updated = await tx.agent.update({
        where: { id },
        data: {
          lifecycle,
          updated_at: now,
          ...(action === 'retire' && !row.retired_at
            ? { retired_at: now }
            : {}),
        },
        select: agentSelect,
      });
      await this.audit.append(tx, {
        actor,
        operation: 'lifecycle',
        target: { type: 'agent', id },
        outcome: 'success',
        request_id: requestId,
        delta: { server_id: row.server_id, lifecycle },
      });
      return agentDto(updated, (await this.status.projectAgents(tx, [updated])).get(updated.id)!);
    });
  }
  async get(id: string): Promise<AgentDto> {
    inventoryId(id);
    return this.db.transaction(async (tx) => {
      const row = await tx.agent.findUnique({
        where: { id },
        select: agentSelect,
      });
      if (!row) throw new ApiError('not_found');
      return agentDto(row, (await this.status.projectAgents(tx, [row])).get(row.id)!);
    });
  }
  async list(query: PageQuery): Promise<Page<AgentDto>> {
    const page = parsePage(query, AGENT_FILTERS);
    const f = page.filters;
    if (f.server) inventoryId(f.server);
    enumFilter(f.lifecycle, ['active', 'disabled', 'retired']);
    return this.db.transaction(async (tx) => {
      const cursor = await pageCursor(page, (id) =>
        tx.agent.findUnique({ where: { id }, select: { created_at: true } }),
      );
      const rows = await tx.agent.findMany({
        where: {
          ...(f.server ? { server_id: f.server } : {}),
          ...(f.lifecycle ? { lifecycle: f.lifecycle } : {}),
        },
        ...cursor,
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        take: page.limit + 1,
        select: agentSelect,
      });
      const telemetry = await this.status.projectAgents(tx, rows);
      return inventoryPage(rows, page, row => agentDto(row, telemetry.get(row.id)!));
    });
  }
}
