import { open, lstat } from 'node:fs/promises';
import { decodeAgentRelease } from './agent-release.mjs';

const ROOT = new URL('../../', import.meta.url);
const MAX_BYTES = 262144;
const ALLOWED = new Set([
  'deploy/agent-release.json',
  'observability/grafana/dashboards/infrapulse/container-detail.json',
  'observability/grafana/dashboards/infrapulse/containers.json',
  'observability/grafana/dashboards/infrapulse/fleet.json',
  'observability/grafana/dashboards/infrapulse/linux-host.json',
  'observability/grafana/dashboards/infrapulse/ssl-certs.json',
  'observability/grafana/dashboards/infrapulse/windows-host.json',
]);

/** Parse a byte-bounded input without accepting ambiguous duplicate members. */
export function parseUniqueJson(text) {
  const value = JSON.parse(text);
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') stack.push(new Set());
    else if (text[i] === '[') stack.push(null);
    else if (text[i] === '}' || text[i] === ']') stack.pop();
    else if (text[i] === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
      let next = i + 1;
      while (next < text.length && /\s/.test(text[next])) next++;
      if (text[next] === ':') {
        const key = JSON.parse(text.slice(start, i + 1));
        if (!stack.at(-1) || stack.at(-1).has(key)) throw new Error('JSON_DUPLICATE_MEMBER');
        stack.at(-1).add(key);
      }
    }
  }
  return value;
}

/** Bounded local public inputs only. Unsafe or invalid input is not readable. */
export async function readPublicJson(relativePath) {
  if (!ALLOWED.has(relativePath)) return undefined;
  let handle;
  try {
    const url = new URL(relativePath, ROOT);
    const parts = relativePath.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = await lstat(new URL(parts.slice(0, i).join('/'), ROOT));
      if (!parent.isDirectory() || parent.isSymbolicLink()) return undefined;
    }
    const info = await lstat(url);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 2 || info.size > MAX_BYTES) return undefined;
    handle = await open(url, 'r');
    const opened = await handle.stat();
    if (opened.dev !== info.dev || opened.ino !== info.ino || !opened.isFile() || opened.nlink !== 1) return undefined;
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(bytes, used, bytes.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > MAX_BYTES) return undefined;
    return parseUniqueJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used)));
  } catch { return undefined; }
  finally { if (handle) await handle.close(); }
}

/** Only genuine absence permits release-missing; malformed present bytes fail closed. */
export async function readBuildRelease() {
  const parent = await lstat(new URL('deploy/', ROOT));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('AGENT_RELEASE_INVALID');
  try { await lstat(new URL('deploy/agent-release.json', ROOT)); }
  catch (error) { if (error.code === 'ENOENT') return decodeAgentRelease({ schemaVersion: 1, platforms: {} }); throw error; }
  return decodeAgentRelease(await readPublicJson('deploy/agent-release.json'));
}
