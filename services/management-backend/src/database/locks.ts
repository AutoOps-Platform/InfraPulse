import type { Tx } from './database.service.js';
import { ApiError } from '../common/errors.js';

// Every mutation locks Server, then Agent, then credential (ordered by id).
export async function lockServer(tx: Tx, id: string): Promise<void> {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM management.servers WHERE id=${id}::uuid FOR UPDATE`;
  if (!rows.length) throw new ApiError('not_found');
}
export async function lockAgent(
  tx: Tx,
  serverId: string,
  id: string,
): Promise<void> {
  await lockServer(tx, serverId);
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM management.agents WHERE server_id=${serverId}::uuid AND id=${id}::uuid FOR UPDATE`;
  if (!rows.length) throw new ApiError('not_found');
  await tx.$queryRaw`SELECT id FROM management.api_credentials WHERE agent_id=${id}::uuid ORDER BY id FOR UPDATE`;
}
