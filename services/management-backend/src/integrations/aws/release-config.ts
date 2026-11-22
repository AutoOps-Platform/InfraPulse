import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { AgentRelease } from '../../../../../deploy/scripts/agent-release.mjs';
export type { AgentRelease, PlatformRelease } from '../../../../../deploy/scripts/agent-release.mjs';

// Image-owned deployment input, NOT an environment/request-selected path.
// Task4 copies the SAME deploy/scripts/agent-release.mjs into this fixed image
// directory (adjacent to the optional release JSON), not a second validator.
const RELEASE = new URL('../../../release/agent-release.json', import.meta.url);
const DECODER = new URL('../../../release/agent-release.mjs', import.meta.url);
const LIMIT = 262144;
export async function loadAgentRelease(): Promise<AgentRelease> {
  let handle;
  try {
    const path = await lstat(RELEASE);
    if (!path.isFile() || path.isSymbolicLink() || path.uid !== 0 || (path.mode & 0o022) !== 0) throw Error('AGENT_RELEASE_UNSAFE');
    for (const parent of [new URL('.', RELEASE), new URL('..', RELEASE)]) {
      const dir = await lstat(parent);
      if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== 0 || (dir.mode & 0o022) !== 0) throw Error('AGENT_RELEASE_UNSAFE');
    }
    handle = await open(RELEASE, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, platforms: {} };
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.size < 1 || stat.size > LIMIT) throw Error('AGENT_RELEASE_UNSAFE');
    const bytes = await handle.readFile();
    if (bytes.length > LIMIT) throw Error('AGENT_RELEASE_INVALID');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const { decodeAgentRelease } = await import(DECODER.href) as typeof import('../../../../../deploy/scripts/agent-release.mjs');
    return decodeAgentRelease(JSON.parse(text));
  } catch {
    // Never put malformed input fragments or supplied secret fields in errors.
    throw Error('AGENT_RELEASE_INVALID');
  } finally { await handle.close(); }
}
