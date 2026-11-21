import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, isUuid } from '../api/client';
import type { Server } from '../api/types';
import { useResource } from './useApi';

// URL IDs are hints; resolve only authoritative current AWS inventory.
export function useSelection() {
  const [params] = useSearchParams();
  const serverId = params.get('server') ?? '';
  const context = serverId;
  const [manual, setManual] = useState<{ context: string; server?: Server }>();
  const initial = useResource(
    `initial:${context}`,
    async (signal) => ({ server: await api.inventoryServer(serverId, signal) }),
    isUuid(serverId)
  );
  // Manual selection wins over a late URL read; URL changes drop old IDs immediately.
  if (manual && manual.context !== context) {
    setManual(undefined);
  }
  const current = manual?.context === context ? manual : initial.data;
  const server = current?.server;
  const setServer = (value: Server | undefined) => setManual({ context, server: value });
  const invalid = Boolean(serverId && !isUuid(serverId));
  return { server, setServer, initial, invalid };
}
