import { Inject, Injectable } from '@nestjs/common';
import type { AgentPrincipal, CredentialScope } from '../auth/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/errors.js';
import { DatabaseService, type Tx } from '../database/database.service.js';
import { lockAgent } from '../database/locks.js';
import {
  profileChecksum,
  validateProfileConfig,
  type ProfileOs,
} from '../profiles/profile-config.js';
import type { ConfigReportDto, ProvisioningDto } from './provisioning.dto.js';

export const PROVISIONING_INGEST_BASE = Symbol('PROVISIONING_INGEST_BASE');
@Injectable()
export class ProvisioningService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PROVISIONING_INGEST_BASE) private readonly ingestBase: string,
  ) {}
  private async owner(
    tx: Tx,
    principal: AgentPrincipal,
    scope: CredentialScope,
  ) {
    if (!principal.scopes.includes(scope)) throw new ApiError('forbidden');
    // Same Server→Agent→ordered credentials locks as disable/archive/revoke.
    // Server also serializes assignment writers. Never acquire the profile writer
    // mutex here (its order is writer→Server). Published content is immutable.
    await lockAgent(tx, principal.server_id, principal.agent_id);
    // Authentication preceded this transaction: recheck *after* any lock wait.
    // No secret/hash is fetched, no cache, and DB time retains sub-ms cutoffs.
    const rows = await tx.$queryRaw<
      { os: string; os_at_registration: string; scopes: string[] }[]
    >`
      SELECT s.os,a.os_at_registration,c.scopes FROM management.servers s
      JOIN management.agents a ON a.server_id=s.id
      JOIN management.api_credentials c ON c.agent_id=a.id
      WHERE s.id=${principal.server_id}::uuid AND a.id=${principal.agent_id}::uuid
        AND c.id=${principal.credential_id}::uuid AND s.archived_at IS NULL
        AND a.lifecycle='active' AND c.revoked_at IS NULL
        AND LEAST(c.expires_at,COALESCE(c.retire_at,c.expires_at))>clock_timestamp()`;
    const owner = rows[0];
    if (!owner) throw new ApiError('unauthorized');
    if (!owner.scopes.includes(scope)) throw new ApiError('forbidden');
    return owner;
  }
  async get(principal: AgentPrincipal): Promise<ProvisioningDto> {
    return this.db.transaction(async (tx) => {
      const owner = await this.owner(tx, principal, 'provisioning:read');
      const assignment = await tx.serverProfile.findUnique({
        where: { server_id: principal.server_id },
        select: {
          profile_version: {
            select: {
              id: true,
              profile_id: true,
              version: true,
              checksum: true,
              config: true,
              status: true,
              profile: { select: { os: true } },
            },
          },
        },
      });
      const version = assignment?.profile_version;
      if (
        !version ||
        version.status !== 'published' ||
        version.profile.os !== owner.os ||
        owner.os !== owner.os_at_registration
      )
        throw new ApiError('provisioning_not_ready');
      // Retirement blocks NEW assignments, not this already committed exact pin.
      const os = owner.os as ProfileOs;
      const config = validateProfileConfig(version.config, os);
      if (profileChecksum(config) !== version.checksum)
        throw new ApiError('provisioning_not_ready');
      const now = await this.db.now(tx);
      await tx.agentProvisioningReceipt.upsert({
        where: {
          agent_id_profile_version_id: {
            agent_id: principal.agent_id,
            profile_version_id: version.id,
          },
        },
        create: {
          agent_id: principal.agent_id,
          profile_version_id: version.id,
          checksum: version.checksum,
          first_provisioned_at: now,
          last_provisioned_at: now,
        },
        update: { checksum: version.checksum, last_provisioned_at: now },
        select: { agent_id: true },
      });
      // Returning from transaction awaits commit: a failed receipt is never a200.
      return {
        server_id: principal.server_id,
        agent_id: principal.agent_id,
        os,
        profile: {
          id: version.profile_id,
          version_id: version.id,
          version: version.version,
          checksum: version.checksum,
          config,
        },
        ingestion: {
          base_url: this.ingestBase,
          path: '/api/v1/ingest/remote-write',
          content_type: 'application/x-protobuf',
          content_encoding: 'snappy',
          remote_write_version: '0.1.0',
          authorization_scheme: 'Bearer',
          identity_headers: {
            'X-Server-ID': principal.server_id,
            'X-Agent-ID': principal.agent_id,
          },
        },
      };
    });
  }
  async report(
    principal: AgentPrincipal,
    input: ConfigReportDto,
    requestId: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const owner = await this.owner(tx, principal, 'config:report');
      const receipt = await tx.agentProvisioningReceipt.findUnique({
        where: {
          agent_id_profile_version_id: {
            agent_id: principal.agent_id,
            profile_version_id: input.profile_version_id,
          },
        },
        select: {
          checksum: true,
          profile_version: {
            select: {
              status: true,
              checksum: true,
              profile: { select: { os: true } },
            },
          },
        },
      });
      if (
        !receipt ||
        receipt.checksum !== input.checksum ||
        receipt.profile_version.checksum !== input.checksum ||
        receipt.profile_version.status !== 'published' ||
        receipt.profile_version.profile.os !== owner.os ||
        owner.os !== owner.os_at_registration
      )
        throw new ApiError('profile_not_provisioned');
      const now = await this.db.now(tx);
      await tx.agent.update({
        where: { id: principal.agent_id },
        data: {
          last_config_report_result: input.result,
          last_config_report_at: now,
          updated_at: now,
          ...(input.result === 'applied'
            ? {
                last_applied_profile_version_id: input.profile_version_id,
                last_applied_at: now,
              }
            : {}),
          ...(input.agent_version !== undefined
            ? {
                version: input.agent_version,
                version_source: 'agent_reported',
                version_reported_at: now,
              }
            : {}),
        },
        select: { id: true },
      });
      await this.audit.append(tx, {
        actor: {
          kind: 'agent',
          issuer: 'agent-api-key',
          subject: principal.agent_id,
        },
        operation: 'config_report',
        target: { type: 'agent', id: principal.agent_id },
        outcome: 'success',
        request_id: requestId,
        delta: {
          profile_version_id: input.profile_version_id,
          checksum: input.checksum,
          result: input.result,
          ...(input.agent_version !== undefined
            ? { version: input.agent_version }
            : {}),
        },
      });
      // No assignment mutation or last_metric_seen_at: this is Agent-reported,
      // not confirmation of a running binary, applied config or Online status.
    });
  }
}
