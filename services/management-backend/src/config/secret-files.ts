import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { TextDecoder } from 'node:util';

// Bounded descriptor read prevents path/IO/decoder details from escaping startup.
export function readSecretFile(path: string): string {
  let descriptor: number | undefined;
  try {
    if (!path || /[\u0000-\u001f]/u.test(path)) throw new Error();
    descriptor = openSync(path, constants.O_RDONLY);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size === 0 || stat.size > 65536)
      throw new Error();
    const bytes = Buffer.alloc(65537);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        size,
        bytes.length - size,
        null,
      );
      if (count === 0) break;
      size += count;
    }
    if (size === 0 || size > 65536) throw new Error();
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      .decode(bytes.subarray(0, size))
      .trim();
  } catch {
    throw new Error('Invalid management configuration.');
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        /* No unsafe IO error propagation. */
      }
    }
  }
}
