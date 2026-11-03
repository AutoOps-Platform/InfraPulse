import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, isUuid } from '../api/client';
import type { Agent, Server } from '../api/types';
import { useResource } from './useApi';

// URL IDs are hints: resolve both through Management before using identity/OS.
export function useSelection() {
  const [params] = useSearchParams();
  const serverId = params.get('server') ?? '';
  const agentId = params.get('agent') ?? '';
  const context = `${serverId}:${agentId}`;
  const [manual, setManual] = useState<{ context: string; server?: Server; agent?: Agent }>();
  const initial = useResource(
    `initial:${context}`,
    async (signal) => {
      const server = await api.server(serverId, signal);
      const agent = agentId ? await api.agent(agentId, signal) : undefined;
      if (agent && agent.server_id !== server.id) {
        throw new Error('Selection mismatch');
      }
      return { server, agent };
    },
    isUuid(serverId) && (!agentId || isUuid(agentId))
  );
  // Manual selection wins over a late URL read; changing URL context drops old IDs immediately.
  if (manual && manual.context !== context) {
    setManual(undefined);
  }
  const current = manual?.context === context ? manual : initial.data;
  const server = current?.server;
  const agent = current?.agent;
  const setServer = (value: Server | undefined) => setManual({ context, server: value });
  const setAgent = (value: Agent | undefined) =>
    setManual({ context, server, agent: value?.server_id === server?.id ? value : undefined });
  const invalid = Boolean((serverId && !isUuid(serverId)) || (agentId && (!isUuid(agentId) || !serverId)));
  return { server, agent, setServer, setAgent, initial, invalid };
}
