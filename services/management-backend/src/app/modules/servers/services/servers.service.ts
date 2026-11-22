  import { randomUUID } from 'node:crypto';
  import { Injectable } from '@nestjs/common';
  import type { Prisma } from '../../../../generated/prisma/client.js';
  import type { AwsPort } from '../../../../integrations/aws/aws.port.js';
  import { ApiError } from '../../../common/errors.js';
  import {
    enumFilter,
    inventoryId,
    inventoryPage,
    parsePage,
    type Page,
    type PageQuery,
  } from '../../../common/pagination.js';
  import {
    PrismaService,
    databaseNow,
    throwDatabaseError,
    type Tx,
  } from '../../../prisma/prisma.service.js';
  import { AuditService } from '../../audit/services/audit.service.js';
  import type { UserPrincipal } from '../../auth/guards/auth.guard.js';
  import type { BootstrapAssetsPort } from '../../onboarding/services/bootstrap.service.js';
  import {
    CreateServerDto,
    PatchServerDto,
    SERVER_FILTERS,
    serverDto,
    type ServerDto,
    type serverSelect,
  } from '../dto/servers.dto.js';
  import { ServersRepository } from '../repositories/servers.repository.js';

  async function assertAwsOwnershipResolved(
    repo: ServersRepository,
    tx: Tx,
    serverId: string,
  ): Promise<void> {
    if (await repo.countUnretiredBindings(tx, serverId)) {
      throw new ApiError('conflict');
    }
    const current = await repo.latestOwnershipAttempt(tx, serverId);
    if (
      current &&
      (current.stage !== 'Retired' ||
        current.lease_owner !== null ||
        current.lease_expires_at !== null ||
        current.next_run_at !== null)
    ) {
      throw new ApiError('conflict');
    }
  }

  @Injectable()
  export class ServersService {
    private assets?: BootstrapAssetsPort;
    private aws?: Pick<AwsPort, 'deregisterNode' | 'deleteUnusedActivation'>;

    constructor(
      private readonly prisma: PrismaService,
      private readonly audit: AuditService,
      private readonly repo: ServersRepository,
    ) {}

    setBootstrapAssets(assets: BootstrapAssetsPort): void {
      this.assets = assets;
    }

    setAwsPort(aws: Pick<AwsPort, 'deregisterNode' | 'deleteUnusedActivation'>): void {
      this.aws = aws;
    }

    private project(
      row: Prisma.ServerGetPayload<{ select: typeof serverSelect }>,
      now: Date,
    ): ServerDto {
      return serverDto(row, now, this.assets?.availability(row.os as 'linux' | 'windows'));
    }

    async create(
      input: CreateServerDto,
      actor: UserPrincipal,
      requestId: string,
    ): Promise<ServerDto> {
      return this.prisma
        .$transaction(async (tx) => {
          const now = await databaseNow(tx);
          const row = await this.repo.create(tx, {
            id: randomUUID(),
            name: input.name,
            os: input.os,
            environment: input.environment,
            metadata: input.metadata ?? {},
            created_at: now,
            updated_at: now,
          });
          await this.audit.append(tx, {
            actor,
            operation: 'create',
            target: { type: 'server', id: row.id },
            outcome: 'success',
            request_id: requestId,
            delta: { name: row.name, os: row.os, environment: row.environment },
          });
          return this.project(row, await databaseNow(tx));
        })
        .catch(throwDatabaseError);
    }

    async list(query: PageQuery): Promise<Page<ServerDto>> {
      const page = parsePage(query, SERVER_FILTERS);
      const f = page.filters;
      enumFilter(f.os, ['linux', 'windows']);
      enumFilter(f.archive, ['true', 'false']);
      if (f.group) inventoryId(f.group);
      if (f.environment && f.environment.length > 64) {
        throw new ApiError('invalid_request');
      }

      const where: Prisma.ServerWhereInput = {
        ...(f.os ? { os: f.os } : {}),
        ...(f.environment ? { environment: f.environment } : {}),
        ...(f.group ? { memberships: { some: { group_id: f.group } } } : {}),
        ...(f.archive ? { archived_at: f.archive === 'true' ? { not: null } : null } : {}),
        ...(f.name ? { name: { startsWith: f.name.replace(/[\\%_]/g, '\\$&') } } : {}),
      };

      return this.prisma
        .$transaction(async (tx) => {
          const rows = await this.repo.list(tx, page, where);
          const now = await databaseNow(tx);
          return inventoryPage(rows, page, (row) => this.project(row, now));
        })
        .catch(throwDatabaseError);
    }

    async get(id: string): Promise<ServerDto> {
      inventoryId(id);
      return this.prisma
        .$transaction(async (tx) => {
          const row = await this.repo.find(tx, id);
          if (!row) throw new ApiError('not_found');
          return this.project(row, await databaseNow(tx));
        })
        .catch(throwDatabaseError);
    }

    async update(
      id: string,
      input: PatchServerDto,
      actor: UserPrincipal,
      requestId: string,
    ): Promise<ServerDto> {
      inventoryId(id);
      return this.prisma
        .$transaction(async (tx) => {
          await this.repo.lock(tx, id);
          const current = await this.repo.findRequired(tx, id);
          if (current.archived_at) throw new ApiError('conflict');
          if (input.os && input.os !== current.os) {
            await assertAwsOwnershipResolved(this.repo, tx, id);
          }
          const row = await this.repo.update(tx, id, {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.os !== undefined ? { os: input.os } : {}),
            ...(input.environment !== undefined ? { environment: input.environment } : {}),
            ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
            updated_at: await databaseNow(tx),
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
              ...(input.environment !== undefined ? { environment: input.environment } : {}),
            },
          });
          return this.project(row, await databaseNow(tx));
        })
        .catch(throwDatabaseError);
    }

    async archive(id: string, actor: UserPrincipal, requestId: string): Promise<void> {
      inventoryId(id);
      await this.prisma
        .$transaction(async (tx) => {
          await this.repo.lock(tx, id);
          await assertAwsOwnershipResolved(this.repo, tx, id);
          const now = await databaseNow(tx);
          const existing = await this.repo.archiveState(tx, id);
          await this.repo.writeArchive(tx, id, {
            ...(existing.archived_at ? {} : { archived_at: now }),
            updated_at: now,
          });
          await this.audit.append(tx, {
            actor,
            operation: 'archive',
            target: { type: 'server', id },
            outcome: 'success',
            request_id: requestId,
            delta: { archived_at: (existing.archived_at ?? now).toISOString() },
          });
        })
        .catch(throwDatabaseError);
    }

    async remove(id: string, actor: UserPrincipal, requestId: string): Promise<void> {
      inventoryId(id);
      const target = await this.prisma
        .$transaction((tx) => this.repo.cleanupTargets(tx, id))
        .catch(throwDatabaseError);
      if (!target) throw new ApiError('not_found');

      if (this.aws) {
        const aws = this.aws;
        const tasks: Promise<unknown>[] = [];
        const seenNodes = new Set<string>();
        for (const binding of target.managed_node_bindings) {
          if (
            !binding.activation_id ||
            (binding.platform !== 'linux' && binding.platform !== 'windows') ||
            seenNodes.has(binding.managed_node_id)
          ) {
            continue;
          }
          seenNodes.add(binding.managed_node_id);
          tasks.push(
            aws.deregisterNode(
              {
                nodeId: binding.managed_node_id,
                activationId: binding.activation_id,
                serverId: id,
                enrollmentId: binding.enrollment_id,
                platform: binding.platform,
              },
              AbortSignal.timeout(4000),
            ),
          );
        }
        const seenActivations = new Set<string>();
        for (const attempt of target.onboarding_attempts) {
          if (
            !attempt.activation_id ||
            attempt._count.bindings > 0 ||
            seenActivations.has(attempt.activation_id)
          ) {
            continue;
          }
          seenActivations.add(attempt.activation_id);
          tasks.push(aws.deleteUnusedActivation(attempt.activation_id, AbortSignal.timeout(4000)));
        }
        if (tasks.length) {
          await Promise.allSettled(tasks);
        }
      }

      await this.prisma
        .$transaction(async (tx) => {
          await this.repo.lock(tx, id);
          const removed = await this.repo.deleteCascade(tx, id);
          await this.audit.append(tx, {
            actor,
            operation: 'delete',
            target: { type: 'server', id },
            outcome: 'success',
            request_id: requestId,
            delta: {
              name: removed.name,
              os: removed.os,
              environment: removed.environment,
            },
          });
        })
        .catch(throwDatabaseError);
    }
  }
