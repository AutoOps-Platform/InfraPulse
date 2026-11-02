import { createReadStream, statSync } from 'node:fs';

export interface Capture { location: string; chunks: Iterable<string> | AsyncIterable<string>; complete: boolean }
export interface Scan { complete: boolean; leak_count: number; locations: readonly string[] }

/** Bounded, streaming and count-only. Retain enough tail to find a split match;
 * only matches ending in the new chunk count, so overlap is never counted twice. */
export async function scanChunks(sentinels: readonly string[], captures: readonly Capture[], maxBytes = 16 * 1024 * 1024): Promise<Scan> {
  if (!sentinels.length || sentinels.some((s) => !s || Buffer.byteLength(s) > 65536) || !Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new Error('Invalid evidence scan inputs.');
  const needles = [...new Set(sentinels)];
  const overlap = Math.max(...needles.map((s) => s.length)) - 1;
  let complete = captures.length > 0, leak_count = 0, bytes = 0;
  const locations = new Set<string>();
  for (const capture of captures) {
    complete = complete && capture.complete;
    let tail = '';
    try {
      for await (const chunk of capture.chunks) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) { complete = false; break; }
        const text = tail + chunk;
        for (const needle of needles) {
          let index = text.indexOf(needle);
          while (index !== -1) {
            if (index + needle.length > tail.length) { leak_count++; locations.add(capture.location); }
            index = text.indexOf(needle, index + 1);
          }
        }
        tail = overlap ? text.slice(-overlap) : '';
      }
    } catch { complete = false; }
  }
  return { complete, leak_count, locations: [...locations].sort() };
}

// Opening must be lazy: eagerly opening all later files can emit an error
// before their async iterators have installed handlers. scanChunks catches the
// active iterator's failure and marks evidence incomplete instead of hiding it.
async function* readCapture(path: string): AsyncGenerator<string> {
  for await (const chunk of createReadStream(path, {encoding:'utf8',highWaterMark:65536})) yield chunk as string;
}

export class Evidence {
  private readonly files = new Map<string, {path: string; complete: boolean}>();
  register(location: string, path: string, complete = true): void {
    if (!/^[a-zA-Z0-9_.-]+$/.test(location) || this.files.has(location)) throw new Error('Duplicate or unsafe capture location.');
    this.files.set(location, {path, complete});
  }
  manifest(): readonly {location: string; path: string; bytes: number; complete: boolean}[] {
    return [...this.files].map(([location, f]) => {
      try { return {location, ...f, bytes: statSync(f.path).size}; }
      catch { return {location, ...f, bytes: 0, complete: false}; }
    });
  }
  async scan(sentinels: readonly string[]): Promise<Scan> {
    const captures = this.manifest().map((f) => ({location: f.location, complete: f.complete,
      chunks: readCapture(f.path)}));
    return scanChunks(sentinels, captures);
  }
}
let current: Evidence | undefined;
export function useEvidence(evidence: Evidence): void { current = evidence; }
export async function scanEvidence(sentinels: readonly string[]): Promise<Scan> {
  if (!current) return {complete: false, leak_count: 0, locations: []};
  return current.scan(sentinels);
}
