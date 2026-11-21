import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import { hasControlChars } from '../app/common/pagination.js';

export function readSecretFile(path: string): string {
  let fd: number | undefined;
  try {
    if (!path || hasControlChars(path)) throw new Error();
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size === 0 ||
      stat.size > 65536 ||
      (process.platform !== 'win32' &&
        ((stat.mode & 0o077) !== 0 || stat.uid !== process.geteuid?.()))
    ) {
      throw new Error();
    }
    const bytes = readFileSync(fd);
    if (bytes.length === 0 || bytes.length > 65536) throw new Error();
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      .decode(bytes)
      .trim();
  } catch {
    throw new Error('Invalid management configuration.');
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* Sanitized descriptor close. */
      }
    }
  }
}
