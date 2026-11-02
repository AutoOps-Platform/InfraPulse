import { randomUUID } from 'node:crypto';
import { admin, identity } from '../support/db.js';
import { readTestUrl } from '../support/pg-harness.js';
import { DatabaseService } from '../../src/database/database.service.js';
import { AuditService } from '../../src/audit/audit.service.js';

function service() {
  return new DatabaseService({
    databaseUrl: readTestUrl(identity().runtimeFile),
    MANAGEMENT_DB_POOL_MAX: 10,
    MANAGEMENT_DB_POOL_TIMEOUT_MS: 1000,
  });
}

describe('atomic audit database contract', () => {
  it('commits a business mutation and projected audit together without raw extra fields', async () => {
    const db = service();
    const id = randomUUID();
    const request = randomUUID();
    try {
      await db.transaction(async (tx) => {
        await tx.server.create({
          data: { id, name: 'audited', os: 'linux', environment: 'test' },
        });
        await new AuditService().append(tx, {
          actor: { kind: 'user', issuer: 'test', subject: 'actor' },
          operation: 'create',
          target: { type: 'server', id },
          outcome: 'success',
          request_id: request,
          delta: {
            name: 'audited',
            secret: 'must-not-persist',
            raw_body: 'must-not-persist',
          },
        });
      });
      const row = await db.client.auditLog.findFirstOrThrow({
        where: { request_id: request },
      });
      expect(row.delta).toEqual({ name: 'audited' });
      expect(
        await db.client.server.findUnique({
          where: { id },
          select: { id: true },
        }),
      ).toEqual({ id });
    } finally {
      await db.onModuleDestroy();
    }
  });
  it('real AuditService failure rolls back real DatabaseService mutation', async () => {
    const db = service();
    const id = randomUUID();
    const client = await admin();
    try {
      // Revoke INSERT as operator to inject a real database audit outage, not a mock.
      await client.query(
        'REVOKE INSERT ON management.audit_logs FROM management_runtime',
      );
      await expect(
        db.transaction(async (tx) => {
          await tx.server.create({
            data: {
              id,
              name: 'rollback-service',
              os: 'linux',
              environment: 'test',
            },
          });
          await new AuditService().append(tx, {
            actor: { kind: 'user', issuer: 'test', subject: 'actor' },
            operation: 'create',
            target: { type: 'server', id },
            outcome: 'success',
            request_id: randomUUID(),
            delta: {},
          });
        }),
      ).rejects.toMatchObject({ code: 'audit_unavailable' });
      expect(await db.client.server.findUnique({ where: { id } })).toBeNull();
    } finally {
      await client.query(
        'GRANT INSERT ON management.audit_logs TO management_runtime',
      );
      await client.end();
      await db.onModuleDestroy();
    }
  });
  // Break caught: an absent schema, successful unaudited mutation, or swallowed audit failure.
  it('rolls business insertion back when audit insertion fails', async () => {
    const client = await admin();
    const id = randomUUID();
    const mutationWithFailingAudit = async () => {
      await client.query('BEGIN');
      try {
        await client.query(
          "INSERT INTO management.servers(id,name,os,environment) VALUES($1,'rollback','linux','test')",
          [id],
        );
        try {
          await client.query(
            "INSERT INTO management.audit_logs(id,actor_kind,operation,resource_type,resource_id,outcome,request_id,delta) VALUES($1,'user','create','server',$2,NULL,$3,'{}')",
            [randomUUID(), id, randomUUID()],
          );
        } catch {
          throw Object.assign(new Error('Audit unavailable.'), {
            code: 'audit_unavailable',
          });
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    };
    try {
      await expect(mutationWithFailingAudit()).rejects.toMatchObject({
        code: 'audit_unavailable',
      });
      expect(
        (
          await client.query('SELECT id FROM management.servers WHERE id=$1', [
            id,
          ])
        ).rows,
      ).toHaveLength(0);
    } finally {
      await client.end();
    }
  });
});
