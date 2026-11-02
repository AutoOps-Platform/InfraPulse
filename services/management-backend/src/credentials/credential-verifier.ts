import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

const tokenPattern =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;
const dummyHash = Buffer.alloc(32);
export function parseCredential(
  apiKey: string,
): { id: string; hash: Buffer } | null {
  if (typeof apiKey !== 'string') return null;
  const match = tokenPattern.exec(apiKey);
  if (!match || match[0] !== apiKey) return null;
  const secret = Buffer.from(match[2]!, 'base64url');
  // Buffer's base64 decoder is permissive. Require the one canonical encoding, not aliases.
  if (secret.length !== 32 || secret.toString('base64url') !== match[2])
    return null;
  return { id: match[1]!, hash: createHash('sha256').update(secret).digest() };
}
export function newCredential(): {
  id: string;
  apiKey: string;
  hash: Buffer;
  publicPrefix: string;
} {
  const id = randomUUID();
  const bytes = randomBytes(32);
  return {
    id,
    apiKey: `${id}.${bytes.toString('base64url')}`,
    hash: createHash('sha256').update(bytes).digest(),
    publicPrefix: id.slice(0, 8),
  };
}
export function matchesVerifier(
  candidate: Uint8Array,
  stored: Uint8Array | null,
): boolean {
  // Even corrupt/unknown rows compare fixed 32-byte operands; never compare variable token strings.
  const candidateValid = candidate.byteLength === 32;
  const storedValid = stored?.byteLength === 32;
  const equal = timingSafeEqual(
    candidateValid ? candidate : dummyHash,
    storedValid ? stored : dummyHash,
  );
  return candidateValid && storedValid === true && equal;
}
// remainingMs is calculated from one primary-DB verification snapshot, never Date.now().
export function verificationTtl(remainingMs: number): number {
  if (!Number.isFinite(remainingMs)) return 0;
  return Math.max(0, Math.floor(Math.min(30_000, remainingMs)));
}
