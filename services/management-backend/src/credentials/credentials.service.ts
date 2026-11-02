import { Inject, Injectable } from '@nestjs/common';
import type { CredentialScope, UserPrincipal } from '../auth/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/errors.js';
import { parsePage, type Page, type PageQuery } from '../common/pagination.js';
import { DatabaseService, type Tx } from '../database/database.service.js';
import { lockAgent } from '../database/locks.js';
import {
  inventoryId,
  inventoryPage,
  pageCursor,
} from '../servers/servers.dto.js';
import {
  CREDENTIAL_SCOPES,
  credentialDto,
  credentialSelect,
  effectiveUntil,
  IssuanceConflict,
  type CredentialDto,
  type IssueDto,
  type IssuedCredentialDto,
  type RotateDto,
  type Verification,
} from './credentials.dto.js';
import {
  matchesVerifier,
  newCredential,
  parseCredential,
  verificationTtl,
} from './credential-verifier.js';

const DAY = 86_400_000;
@Injectable()
export class CredentialsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async verify(apiKey: string, scope: CredentialScope): Promise<Verification> {
    const proof = await this.proof(apiKey);
    return proof.active && proof.scopes.includes(scope)
      ? proof
      : { active: false };
  }
  // Shared trusted proof lookup for the own-Agent adapter. No positive cache or raw-key principal.
  async proof(apiKey: string): Promise<Verification> {
    const parsed = parseCredential(apiKey);
    if (!parsed) return { active: false };
    return this.db.transaction(async (tx) => {
      // One statement snapshots lifecycle + validity together. SQL retains timestamptz microseconds
      // for floor/equality; JS Date rounding must never turn a sub-millisecond proof positive.
      const rows = await tx.$queryRaw<
        {
          id: string;
          agent_id: string;
          server_id: string;
          secret_hash: Uint8Array;
          scopes: string[];
          effective_until: Date;
          remaining_ms: number;
        }[]
      >`
        WITH verification_clock AS MATERIALIZED (SELECT clock_timestamp() AS now)
        SELECT c.id, c.agent_id, a.server_id, c.secret_hash, c.scopes,
          LEAST(c.expires_at, COALESCE(c.retire_at,c.expires_at)) AS effective_until,
          (EXTRACT(EPOCH FROM
            (LEAST(c.expires_at, COALESCE(c.retire_at,c.expires_at))-v.now))*1000)::double precision AS remaining_ms
        FROM management.api_credentials c
        JOIN management.agents a ON a.id=c.agent_id
        JOIN management.servers s ON s.id=a.server_id
        CROSS JOIN verification_clock v
        WHERE c.id=${parsed.id}::uuid AND c.revoked_at IS NULL
          AND a.lifecycle='active' AND s.archived_at IS NULL`;
      const row = rows[0];
      const matches = matchesVerifier(parsed.hash, row?.secret_hash ?? null);
      const ttl = row ? verificationTtl(row.remaining_ms) : 0;
      if (
        !row ||
        !matches ||
        ttl < 1 ||
        row.scopes.length === 0 ||
        row.scopes.length > 3 ||
        new Set(row.scopes).size !== row.scopes.length ||
        row.scopes.some(
          (value) => !CREDENTIAL_SCOPES.includes(value as CredentialScope),
        )
      )
        return { active: false };
      return {
        active: true,
        credential_id: row.id,
        server_id: row.server_id,
        agent_id: row.agent_id,
        scopes: row.scopes as CredentialScope[],
        expires_at: row.effective_until.toISOString(),
        cache_ttl_ms: ttl,
      };
    });
  }
  async get(id: string): Promise<CredentialDto> {
    inventoryId(id);
    return this.db.transaction(async (tx) => {
      const row = await tx.apiCredential.findUnique({
        where: { id },
        select: credentialSelect,
      });
      if (!row) throw new ApiError('not_found');
      return credentialDto(row, await this.db.now(tx));
    });
  }
  async list(query: PageQuery): Promise<Page<CredentialDto>> {
    const page = parsePage(query, ['agent', 'server']);
    if (page.filters.agent) inventoryId(page.filters.agent);
    if (page.filters.server) inventoryId(page.filters.server);
    return this.db.transaction(async (tx) => {
      const cursor = await pageCursor(page, (id) =>
        tx.apiCredential.findUnique({
          where: { id },
          select: { created_at: true },
        }),
      );
      const rows = await tx.apiCredential.findMany({
        where: {
          ...(page.filters.agent ? { agent_id: page.filters.agent } : {}),
          ...(page.filters.server
            ? { agent: { server_id: page.filters.server } }
            : {}),
        },
        ...cursor,
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        take: page.limit + 1,
        select: credentialSelect,
      });
      const now = await this.db.now(tx);
      return inventoryPage(rows, page, (row) => credentialDto(row, now));
    });
  }
  async issue(
    agentId: string,
    input: IssueDto,
    actor: UserPrincipal,
    requestId: string,
  ): Promise<IssuedCredentialDto> {
    inventoryId(agentId);
    return this.issuance(input.issuance_request_id, async (tx) => {
      await this.lockOwner(tx, agentId);
      await this.repeated(tx, input.issuance_request_id);
      await this.requireActive(tx, agentId);
      return this.create(tx, agentId, input, actor, requestId);
    });
  }
  async rotate(
    id: string,
    input: RotateDto,
    actor: UserPrincipal,
    requestId: string,
  ): Promise<IssuedCredentialDto> {
    inventoryId(id);
    return this.issuance(input.issuance_request_id, async (tx) => {
      const owner = await tx.apiCredential.findUnique({
        where: { id },
        select: { agent_id: true },
      });
      if (!owner) throw new ApiError('not_found');
      await this.lockOwner(tx, owner.agent_id);
      await this.repeated(tx, input.issuance_request_id);
      await this.requireActive(tx, owner.agent_id);
      const old = await tx.apiCredential.findUnique({
        where: { id },
        select: { ...credentialSelect, successor: { select: { id: true } } },
      });
      const now = await this.db.now(tx);
      if (
        !old ||
        old.revoked_at ||
        old.successor ||
        effectiveUntil(old) <= now.getTime()
      )
        throw new ApiError('conflict');
      const retireAt = new Date(
        Math.min(old.retire_at?.getTime() ?? Infinity, now.getTime() + 300_000),
      );
      await tx.apiCredential.update({
        where: { id },
        data: { retire_at: retireAt },
        select: { id: true },
      });
      return this.create(
        tx,
        owner.agent_id,
        input,
        actor,
        requestId,
        { id, retireAt },
        now,
      );
    });
  }
  async revoke(
    id: string,
    actor: UserPrincipal,
    requestId: string,
  ): Promise<void> {
    inventoryId(id);
    await this.db.transaction(async (tx) => {
      const owner = await tx.apiCredential.findUnique({
        where: { id },
        select: { agent_id: true },
      });
      if (!owner) throw new ApiError('not_found');
      await this.lockOwner(tx, owner.agent_id);
      // Re-read after the same lifecycle locks, including for idempotent calls. Revoke is
      // allowed on archived/retired owners; unlike issuance it can never add validity.
      const row = await tx.apiCredential.findUnique({
        where: { id },
        select: credentialSelect,
      });
      if (!row) throw new ApiError('not_found');
      if (row.revoked_at) return;
      const now = await this.db.now(tx);
      await tx.apiCredential.update({
        where: { id },
        data: { revoked_at: now },
        select: { id: true },
      });
      await this.audit.append(tx, {
        actor,
        operation: 'revoke',
        target: { type: 'credential', id },
        outcome: 'success',
        request_id: requestId,
        delta: {
          agent_id: row.agent_id,
          server_id: row.agent.server_id,
          revoked_at: now.toISOString(),
        },
      });
    });
  }
  private async lockOwner(tx: Tx, agentId: string): Promise<void> {
    const owner = await tx.agent.findUnique({
      where: { id: agentId },
      select: { server_id: true },
    });
    if (!owner) throw new ApiError('not_found');
    // Immutable server_id is only a lookup before locks, NEVER a lifecycle decision.
    await lockAgent(tx, owner.server_id, agentId);
  }
  private async requireActive(tx: Tx, agentId: string): Promise<void> {
    const owner = await tx.agent.findUnique({
      where: { id: agentId },
      select: { lifecycle: true, server: { select: { archived_at: true } } },
    });
    if (!owner || owner.lifecycle !== 'active' || owner.server.archived_at)
      throw new ApiError('conflict');
  }
  private async repeated(tx: Tx, issuanceRequestId: string): Promise<void> {
    const row = await tx.apiCredential.findUnique({
      where: { issuance_request_id: issuanceRequestId },
      select: credentialSelect,
    });
    if (row)
      throw new IssuanceConflict(credentialDto(row, await this.db.now(tx)));
  }
  private async issuance(
    issuanceRequestId: string,
    work: (tx: Tx) => Promise<IssuedCredentialDto>,
  ): Promise<IssuedCredentialDto> {
    try {
      return await this.db.transaction(work);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'conflict')
        throw error;
      // Different Agent locks can race on the global operation UUID. Unique violation
      // aborts its transaction: read the committed winner in a fresh transaction.
      await this.db.transaction((tx) => this.repeated(tx, issuanceRequestId));
      throw error;
    }
  }
  private async create(
    tx: Tx,
    agentId: string,
    input: IssueDto,
    actor: UserPrincipal,
    requestId: string,
    rotation?: { id: string; retireAt: Date },
    snapshot?: Date,
  ): Promise<IssuedCredentialDto> {
    const now = snapshot ?? (await this.db.now(tx));
    const expiresAt =
      input.expires_at === undefined
        ? new Date(now.getTime() + 30 * DAY)
        : new Date(input.expires_at);
    if (
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt.getTime() <= now.getTime() ||
      expiresAt.getTime() > now.getTime() + 365 * DAY
    )
      throw new ApiError('invalid_request');
    const scopes = input.scopes ?? [...CREDENTIAL_SCOPES];
    if (
      !Array.isArray(scopes) ||
      !scopes.length ||
      scopes.length > 3 ||
      new Set(scopes).size !== scopes.length ||
      scopes.some((value) => !CREDENTIAL_SCOPES.includes(value))
    )
      throw new ApiError('invalid_request');
    const generated = newCredential();
    const row = await tx.apiCredential.create({
      data: {
        id: generated.id,
        agent_id: agentId,
        public_prefix: generated.publicPrefix,
        secret_hash: new Uint8Array(generated.hash),
        scopes,
        expires_at: expiresAt,
        issuance_request_id: input.issuance_request_id,
        ...(rotation ? { rotated_from_id: rotation.id } : {}),
        created_at: now,
        created_by: {
          kind: actor.kind,
          issuer: actor.issuer,
          subject: actor.subject,
          context: actor.context,
          role: actor.role,
          ...(actor.display === undefined ? {} : { display: actor.display }),
        },
      },
      select: credentialSelect,
    });
    await this.audit.append(tx, {
      actor,
      operation: rotation ? 'rotate' : 'issue',
      target: { type: 'credential', id: row.id },
      outcome: 'success',
      request_id: requestId,
      delta: {
        agent_id: agentId,
        server_id: row.agent.server_id,
        scopes,
        expires_at: expiresAt.toISOString(),
        ...(rotation ? { retire_at: rotation.retireAt.toISOString() } : {}),
      },
    });
    return { ...credentialDto(row, now), api_key: generated.apiKey };
  }
}
