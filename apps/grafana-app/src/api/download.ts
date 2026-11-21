import { ApiError, isUuid, resourcePath } from './client';
import type { BootstrapIntent } from './types';

export const BOOTSTRAP_MAX_BYTES = 262144;
// Injectable browser effects only; route/auth policy is deliberately not injectable.
export interface DownloadDeps {
  fetch: typeof fetch;
  document: Document;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  deferRevoke: (cleanup: () => void) => void;
}
const browserDeps = (): DownloadDeps => ({
  fetch: window.fetch.bind(window), document,
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
  deferRevoke: (cleanup) => { window.setTimeout(cleanup, 0); },
});

// One call is exactly one POST. The caller owns the pre-await intent lock and
// treats *every* unsuccessful outcome (including abort) as possibly consumed.
export async function downloadBootstrap(
  serverId: string,
  intent: BootstrapIntent,
  signal: AbortSignal,
  deps: DownloadDeps = browserDeps()
): Promise<void> {
  if (!isUuid(serverId) || !isUuid(intent.requestId)) throw new ApiError(400, 'invalid_request');
  const path = resourcePath(`api/v1/servers/${serverId}/onboarding/bootstrap`);
  const url = new URL(path, deps.document.location.origin);
  if (!path.startsWith('/') || path.startsWith('//') || url.origin !== deps.document.location.origin || url.pathname !== path || url.search || url.hash) throw new ApiError(400, 'invalid_request');
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let anchor: HTMLAnchorElement | undefined;
  let objectUrl: string | undefined;
  const chunks: ArrayBuffer[] = [];
  try {
    const response = await deps.fetch(url.href, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', Accept: 'text/x-shellscript, text/plain, application/json' },
      body: JSON.stringify({ requestId: intent.requestId }),
    });
    // Never decode attachment/error bytes into script strings or exception text.
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new ApiError(response.status >= 400 && response.status <= 599 ? response.status : 502, 'bootstrap_outcome_unknown');
    }
    const mime = response.headers.get('Content-Type');
    const extension = mime === 'text/x-shellscript' ? '.sh' : mime === 'text/plain' ? '.ps1' : undefined;
    const filename = `infrapulse-${serverId}${extension ?? ''}`;
    const length = response.headers.get('Content-Length');
    if (!extension || response.redirected || (response.url && response.url !== url.href) || response.headers.has('Content-Encoding') || response.headers.get('Content-Disposition') !== `attachment; filename="${filename}"` || response.headers.get('X-Content-Type-Options') !== 'nosniff' || !response.headers.get('Cache-Control')?.split(',').some((part) => part.trim() === 'no-store') || (length !== null && (!/^[0-9]+$/.test(length) || Number(length) < 1 || Number(length) > BOOTSTRAP_MAX_BYTES)) || !response.body) {
      await response.body?.cancel();
      throw new ApiError(502, 'invalid_upstream_response');
    }
    reader = response.body.getReader();
    let total = 0;
    while (true) {
      if (signal.aborted) throw new DOMException('Download aborted', 'AbortError');
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > BOOTSTRAP_MAX_BYTES) {
        chunk.value.fill(0);
        throw new ApiError(502, 'invalid_upstream_response');
      }
      const owned = new Uint8Array(chunk.value.byteLength);
      owned.set(chunk.value);
      chunks.push(owned.buffer);
      chunk.value.fill(0);
    }
    if (signal.aborted || total === 0 || (length !== null && Number(length) !== total)) throw new ApiError(502, 'invalid_upstream_response');
    // Blob copies bytes; no script is ever React state, text, storage or clipboard.
    const blob = new Blob(chunks, { type: mime! });
    objectUrl = deps.createObjectURL(blob);
    anchor = deps.document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.hidden = true;
    deps.document.body.appendChild(anchor);
    if (signal.aborted) throw new DOMException('Download aborted', 'AbortError');
    anchor.click();
  } catch (error: unknown) {
    if (reader) await reader.cancel().catch(() => undefined);
    throw error instanceof ApiError ? error : new ApiError(0, 'bootstrap_outcome_unknown');
  } finally {
    reader?.releaseLock();
    chunks.forEach((chunk) => new Uint8Array(chunk).fill(0));
    const cleanup = () => {
      try { anchor?.remove(); } finally { if (objectUrl) deps.revokeObjectURL(objectUrl); }
    };
    // Also cleans up when URL creation/append/click fails. Never retain a Blob cache.
    try { deps.deferRevoke(cleanup); } catch { cleanup(); }
  }
}
