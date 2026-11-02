import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService, type Tx } from '../database/database.service.js';
import { lockServer } from '../database/locks.js';
import { AuditService } from '../audit/audit.service.js';
import type { UserPrincipal } from '../auth/principal.js';
import { ApiError } from '../common/errors.js';
import { parsePage, type Page, type PageQuery } from '../common/pagination.js';
import {
  enumFilter,
  inventoryId,
  inventoryPage,
  pageCursor,
} from '../servers/servers.dto.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  validateProfileConfig,
  profileChecksum,
  type ProfileOs,
} from './profile-config.js';
import {
  type CreateProfileDto,
  type PatchProfileDto,
  type ProfileVersionInput,
  type ProfileDto,
  type ProfileDetailDto,
  type ProfileVersionDto,
  type AssignmentDto,
  profileDto,
  profileSelect,
  versionDto,
  versionSelect,
} from './profiles.dto.js';

// All profile writers (including the explicit seed) use this transaction lock.
// It stabilizes the set of pinned Servers before taking the *same* Server locks
// used by OS changes/archive/Agent lifecycle. Order: writer → sorted Servers →
// profile → version. No inventory writer takes the writer/profile locks in reverse.
async function writer(tx: Tx): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(913748,6)::text`;
}
async function lockProfile(tx: Tx, id: string): Promise<void> {
  await tx.$queryRaw`SELECT s.id FROM management.servers s
    JOIN management.server_profiles a ON a.server_id=s.id
    JOIN management.profile_versions v ON v.id=a.profile_version_id
    WHERE v.profile_id=${id}::uuid ORDER BY s.id FOR UPDATE OF s`;
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM management.monitoring_profiles WHERE id=${id}::uuid FOR UPDATE`;
  if (!rows.length) throw new ApiError('not_found');
}
function statusFilter(query: PageQuery, actor: UserPrincipal) {
  const page = parsePage(query, ['os', 'retired', 'status']);
  enumFilter(page.filters.os, ['linux', 'windows']);
  enumFilter(page.filters.retired, ['true', 'false']);
  enumFilter(page.filters.status, ['draft', 'published']);
  if (actor.role !== 'Admin' && page.filters.status === 'draft')
    throw new ApiError('forbidden');
  return page;
}
export function emptyProfileQuery(query: PageQuery): void {
  if (Object.keys(query).length) throw new ApiError('invalid_request');
}
@Injectable()
export class ProfilesService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}
  async create(
    input: CreateProfileDto,
    actor: UserPrincipal,
    requestId: string,
  ): Promise<ProfileDto> {
    return this.db.transaction(async (tx) => {
      await writer(tx);
      const now = await this.db.now(tx);
      const row = await tx.monitoringProfile.create({
        data: {
          id: randomUUID(),
          slug: input.slug,
          name: input.name,
          description: input.description,
          os: input.os,
          created_at: now,
          updated_at: now,
        },
        select: profileSelect,
      });
      await this.audit.append(tx, {
        actor,
        operation: 'create',
        target: { type: 'profile', id: row.id },
        outcome: 'success',
        request_id: requestId,
        delta: { name: row.name, os: row.os },
      });
      return profileDto(row);
    });
  }
  async update(
    id: string,
    input: PatchProfileDto,
    actor: UserPrincipal,
    requestId: string,
  ): Promise<ProfileDto> {
    inventoryId(id);
    return this.db.transaction(async (tx) => {
      await writer(tx);
      await lockProfile(tx, id);
      const current = await tx.monitoringProfile.findUniqueOrThrow({
        where: { id },
        select: profileSelect,
      });
      if (current.retired_at) throw new ApiError('conflict');
      const row = await tx.monitoringProfile.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          updated_at: await this.db.now(tx),
        },
        select: profileSelect,
      });
      await this.audit.append(tx, {
        actor,
        operation: 'update',
        target: { type: 'profile', id },
        outcome: 'success',
        request_id: requestId,
        delta: input.name !== undefined ? { name: input.name } : {},
      });
      return profileDto(row);
    });
  }
  async list(
    query: PageQuery,
    actor: UserPrincipal,
  ): Promise<Page<ProfileDto>> {
    const page = statusFilter(query, actor);
    const f = page.filters;
    const status = actor.role === 'Admin' ? f.status : 'published';
    return this.db.transaction(async (tx) => {
      const where: Prisma.MonitoringProfileWhereInput = {
        ...(f.os ? { os: f.os } : {}),
        ...(f.retired
          ? { retired_at: f.retired === 'true' ? { not: null } : null }
          : {}),
        ...(status ? { versions: { some: { status } } } : {}),
      };
      const cursor = await pageCursor(page, (id) =>
        tx.monitoringProfile.findFirst({
          where: { AND: [where, { id }] },
          select: { created_at: true },
        }),
      );
      const rows = await tx.monitoringProfile.findMany({
        where,
        ...cursor,
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        take: page.limit + 1,
        select: profileSelect,
      });
      return inventoryPage(rows, page, profileDto);
    });
  }
  async get(id: string, actor: UserPrincipal): Promise<ProfileDetailDto> {
    inventoryId(id);
    return this.db.transaction(async (tx) => {
      const row = await tx.monitoringProfile.findFirst({
        where: {
          id,
          ...(actor.role !== 'Admin'
            ? { versions: { some: { status: 'published' } } }
            : {}),
        },
        select: {
          ...profileSelect,
          versions: {
            where: actor.role === 'Admin' ? {} : { status: 'published' },
            orderBy: { version: 'asc' },
            take: 100,
            select: versionSelect,
          },
        },
      });
      if (!row) throw new ApiError('not_found');
      return { ...profileDto(row), versions: row.versions.map(versionDto) };
    });
  }
  async listVersions(
    profileId: string,
    query: PageQuery,
    actor: UserPrincipal,
  ): Promise<Page<ProfileVersionDto>> {
    inventoryId(profileId);
    const page = parsePage(query, ['status']);
    enumFilter(page.filters.status, ['draft', 'published']);
    if (actor.role !== 'Admin' && page.filters.status === 'draft')
      throw new ApiError('forbidden');
    const status = actor.role === 'Admin' ? page.filters.status : 'published';
    return this.db.transaction(async (tx) => {
      const profile = await tx.monitoringProfile.findFirst({
        where: {
          id: profileId,
          ...(actor.role !== 'Admin'
            ? { versions: { some: { status: 'published' } } }
            : {}),
        },
        select: { id: true },
      });
      if (!profile) throw new ApiError('not_found');
      const where = { profile_id: profileId, ...(status ? { status } : {}) };
      const cursor = await pageCursor(page, (id) =>
        tx.profileVersion.findFirst({
          where: { ...where, id },
          select: { created_at: true },
        }),
      );
      const rows = await tx.profileVersion.findMany({
        where,
        ...cursor,
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        take: page.limit + 1,
        select: versionSelect,
      });
      return inventoryPage(rows, page, versionDto);
    });
  }
  async getVersion(
    id: string,
    actor: UserPrincipal,
  ): Promise<ProfileVersionDto> {
    inventoryId(id);
    return this.db.transaction(async (tx) => {
      const row = await tx.profileVersion.findFirst({
        where: {
          id,
          ...(actor.role !== 'Admin' ? { status: 'published' } : {}),
        },
        select: versionSelect,
      });
      if (!row) throw new ApiError('not_found');
      return versionDto(row);
    });
  }
  async createVersion(
    profileId: string,
    input: ProfileVersionInput,
    actor: UserPrincipal,
    requestId: string,
  ): Promise<ProfileVersionDto> {
    inventoryId(profileId);
    return this.db.transaction(async (tx) => {
      await writer(tx);
      await lockProfile(tx, profileId);
      const profile = await tx.monitoringProfile.findUniqueOrThrow({
        where: { id: profileId },
        select: { os: true, retired_at: true },
      });
      if (profile.retired_at) throw new ApiError('conflict');
      const config = validateProfileConfig(
        input.config,
        profile.os as ProfileOs,
      );
      const max = await tx.profileVersion.aggregate({
        where: { profile_id: profileId },
        _max: { version: true },
      });
      const version = (max._max.version ?? 0) + 1;
      if (version > 2147483647) throw new ApiError('conflict');
      const row = await tx.profileVersion.create({
        data: {
          id: randomUUID(),
          profile_id: profileId,
          version,
          config: config as unknown as Prisma.InputJsonObject,
          checksum: profileChecksum(config),
          created_by: {
            kind: actor.kind,
            issuer: actor.issuer,
            subject: actor.subject,
          },
          created_at: await this.db.now(tx),
        },
        select: versionSelect,
      });
      await this.audit.append(tx, {
        actor,
        operation: 'draft',
        target: { type: 'profile_version', id: row.id },
        outcome: 'success',
        request_id: requestId,
        delta: {
          version: row.version,
          checksum: row.checksum,
          status: row.status,
        },
      });
      return versionDto(row);
    });
  }
  private async versionForWrite(tx: Tx, id: string) {
    const identity = await tx.profileVersion.findUnique({
      where: { id },
      select: { profile_id: true },
    });
    if (!identity) throw new ApiError('not_found');
    await lockProfile(tx, identity.profile_id);
    await tx.$queryRaw`SELECT id FROM management.profile_versions WHERE id=${id}::uuid FOR UPDATE`;
    const row = await tx.profileVersion.findUniqueOrThrow({
      where: { id },
      select: {
        ...versionSelect,
        profile: { select: { os: true, retired_at: true } },
      },
    });
    if (row.profile.retired_at || row.status !== 'draft')
      throw new ApiError('conflict');
    return row;
  }
  async editVersion(
    id: string,
    input: ProfileVersionInput,
    actor: UserPrincipal,
    requestId: string,
  ): Promise<ProfileVersionDto> {
    inventoryId(id);
    return this.db.transaction(async (tx) => {
      await writer(tx);
      const current = await this.versionForWrite(tx, id);
      const config = validateProfileConfig(
        input.config,
        current.profile.os as ProfileOs,
      );
      const row = await tx.profileVersion.update({
        where: { id },
        data: {
          config: config as unknown as Prisma.InputJsonObject,
          checksum: profileChecksum(config),
        },
        select: versionSelect,
      });
      await this.audit.append(tx, {
        actor,
        operation: 'draft',
        target: { type: 'profile_version', id },
        outcome: 'success',
        request_id: requestId,
        delta: {
          version: row.version,
          checksum: row.checksum,
          status: row.status,
        },
      });
      return versionDto(row);
    });
  }
  async publishVersion(
    versionId: string,
    actor: UserPrincipal,
    requestId: string,
  ): Promise<ProfileVersionDto> {
    inventoryId(versionId);
    return this.db.transaction(async (tx) => {
      await writer(tx);
      const current = await this.versionForWrite(tx, versionId);
      const config = validateProfileConfig(
        current.config,
        current.profile.os as ProfileOs,
      );
      const row = await tx.profileVersion.update({
        where: { id: versionId },
        data: {
          config: config as unknown as Prisma.InputJsonObject,
          checksum: profileChecksum(config),
          status: 'published',
          published_at: await this.db.now(tx),
        },
        select: versionSelect,
      });
      await this.audit.append(tx, {
        actor,
        operation: 'publish',
        target: { type: 'profile_version', id: versionId },
        outcome: 'success',
        request_id: requestId,
        delta: {
          version: row.version,
          checksum: row.checksum,
          status: row.status,
        },
      });
      return versionDto(row);
    });
  }
  async retire(
    id: string,
    actor: UserPrincipal,
    requestId: string,
  ): Promise<ProfileDto> {
    inventoryId(id);
    return this.db.transaction(async (tx) => {
      await writer(tx);
      await lockProfile(tx, id);
      const current = await tx.monitoringProfile.findUniqueOrThrow({
        where: { id },
        select: profileSelect,
      });
      const now = await this.db.now(tx);
      const row = await tx.monitoringProfile.update({
        where: { id },
        data: { retired_at: current.retired_at ?? now, updated_at: now },
        select: profileSelect,
      });
      await this.audit.append(tx, {
        actor,
        operation: 'retire',
        target: { type: 'profile', id },
        outcome: 'success',
        request_id: requestId,
        delta: {},
      });
      return profileDto(row);
    });
  }
  async assign(
    serverId: string,
    versionId: string,
    actor: UserPrincipal,
    requestId: string,
  ): Promise<AssignmentDto> {
    inventoryId(serverId);
    inventoryId(versionId);
    return this.db.transaction(async (tx) => {
      await writer(tx);
      await lockServer(tx, serverId);
      const server = await tx.server.findUniqueOrThrow({
        where: { id: serverId },
        select: { os: true, archived_at: true },
      });
      const identity = await tx.profileVersion.findUnique({
        where: { id: versionId },
        select: { profile_id: true },
      });
      if (!identity) throw new ApiError('not_found');
      // writer stabilizes assignment membership, but avoid locking other Servers
      // here: retirement/publication already acquire them in sorted order.
      await tx.$queryRaw`SELECT id FROM management.monitoring_profiles WHERE id=${identity.profile_id}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM management.profile_versions WHERE id=${versionId}::uuid FOR UPDATE`;
      const version = await tx.profileVersion.findUniqueOrThrow({
        where: { id: versionId },
        select: {
          status: true,
          profile: { select: { os: true, retired_at: true } },
        },
      });
      if (
        server.archived_at ||
        version.status !== 'published' ||
        version.profile.retired_at ||
        server.os !== version.profile.os
      )
        throw new ApiError('conflict');
      const data = {
        profile_version_id: versionId,
        assigned_by: {
          kind: actor.kind,
          issuer: actor.issuer,
          subject: actor.subject,
        },
        assigned_at: await this.db.now(tx),
      };
      const row = await tx.serverProfile.upsert({
        where: { server_id: serverId },
        create: { server_id: serverId, ...data },
        update: data,
        select: {
          server_id: true,
          profile_version_id: true,
          assigned_at: true,
        },
      });
      await this.audit.append(tx, {
        actor,
        operation: 'assignment',
        target: { type: 'server', id: serverId },
        outcome: 'success',
        request_id: requestId,
        delta: { profile_version_id: versionId },
      });
      return { ...row, assigned_at: row.assigned_at.toISOString() };
    });
  }
  async getAssignment(serverId: string): Promise<AssignmentDto> {
    inventoryId(serverId);
    return this.db.transaction(async (tx) => {
      const row = await tx.serverProfile.findUnique({
        where: { server_id: serverId },
        select: {
          server_id: true,
          profile_version_id: true,
          assigned_at: true,
        },
      });
      if (!row) throw new ApiError('not_found');
      return { ...row, assigned_at: row.assigned_at.toISOString() };
    });
  }
}
