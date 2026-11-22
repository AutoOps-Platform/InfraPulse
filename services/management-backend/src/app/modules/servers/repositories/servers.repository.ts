import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../../generated/prisma/client.js';
import { pageCursor, type PageSpec } from '../../../common/pagination.js';
import { lockServer, type Tx } from '../../../prisma/prisma.service.js';
import { serverSelect } from '../dto/servers.dto.js';

export type ServerRecord = Prisma.ServerGetPayload<{ select: typeof serverSelect }>;

@Injectable()
export class ServersRepository {
  lock(tx: Tx, id: string): Promise<void> {
    return lockServer(tx, id);
  }

  find(tx: Tx, id: string): Promise<ServerRecord | null> {
    return tx.server.findUnique({ where: { id }, select: serverSelect });
  }

  findRequired(tx: Tx, id: string): Promise<ServerRecord> {
    return tx.server.findUniqueOrThrow({ where: { id }, select: serverSelect });
  }

  create(tx: Tx, data: Prisma.ServerUncheckedCreateInput): Promise<ServerRecord> {
    return tx.server.create({ data, select: serverSelect });
  }

  update(tx: Tx, id: string, data: Prisma.ServerUncheckedUpdateInput): Promise<ServerRecord> {
    return tx.server.update({ where: { id }, data, select: serverSelect });
  }

  async list(
    tx: Tx,
    page: PageSpec,
    where: Prisma.ServerWhereInput,
  ): Promise<ServerRecord[]> {
    const cursor = await pageCursor(page, (id) =>
      tx.server.findUnique({ where: { id }, select: { created_at: true } }),
    );
    return tx.server.findMany({
      where,
      ...cursor,
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      take: page.limit + 1,
      select: serverSelect,
    });
  }

  countUnretiredBindings(tx: Tx, id: string): Promise<number> {
    return tx.managedNodeBinding.count({
      where: { server_id: id, state: { not: 'Retired' } },
    });
  }

  latestOwnershipAttempt(tx: Tx, id: string) {
    return tx.onboardingAttempt.findFirst({
      where: { server_id: id },
      orderBy: { generation: 'desc' },
      select: {
        stage: true,
        lease_owner: true,
        lease_expires_at: true,
        next_run_at: true,
      },
    });
  }

  archiveState(tx: Tx, id: string): Promise<{ archived_at: Date | null }> {
    return tx.server.findUniqueOrThrow({
      where: { id },
      select: { archived_at: true },
    });
  }

  async writeArchive(tx: Tx, id: string, data: Prisma.ServerUncheckedUpdateInput): Promise<void> {
    await tx.server.update({ where: { id }, data, select: { id: true } });
  }

  cleanupTargets(tx: Tx, id: string) {
    return tx.server.findUnique({
      where: { id },
      select: {
        id: true,
        managed_node_bindings: {
          where: { state: { not: 'Retired' } },
          select: {
            managed_node_id: true,
            activation_id: true,
            enrollment_id: true,
            platform: true,
          },
        },
        onboarding_attempts: {
          where: { activation_id: { not: null } },
          select: {
            activation_id: true,
            _count: { select: { bindings: true } },
          },
        },
      },
    });
  }

  async deleteCascade(
    tx: Tx,
    id: string,
  ): Promise<{ name: string; os: string; environment: string }> {
    const existing = await tx.server.findUniqueOrThrow({
      where: { id },
      select: { name: true, os: true, environment: true },
    });
    await tx.bindingAlertReceipt.deleteMany({ where: { binding: { server_id: id } } });
    await tx.managedNodeBinding.deleteMany({ where: { server_id: id } });
    await tx.decommissionProtocol.deleteMany({ where: { attempt: { server_id: id } } });
    await tx.onboardingRequestReceipt.deleteMany({ where: { attempt: { server_id: id } } });
    await tx.onboardingAttempt.deleteMany({ where: { server_id: id } });
    await tx.agentProvisioningReceipt.deleteMany({ where: { agent: { server_id: id } } });
    await tx.apiCredential.updateMany({
      where: { agent: { server_id: id }, rotated_from_id: { not: null } },
      data: { rotated_from_id: null },
    });
    await tx.apiCredential.deleteMany({ where: { agent: { server_id: id } } });
    await tx.agent.deleteMany({ where: { server_id: id } });
    await tx.serverGroupMember.deleteMany({ where: { server_id: id } });
    await tx.serverProfile.deleteMany({ where: { server_id: id } });
    await tx.server.delete({ where: { id } });
    return existing;
  }
}
