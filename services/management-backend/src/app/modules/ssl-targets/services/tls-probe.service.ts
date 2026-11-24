import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { connect, type PeerCertificate } from 'node:tls';
import { Injectable } from '@nestjs/common';

export interface TlsProbeSuccess {
  ok: true;
  subjectCn: string;
  issuerCn: string;
  serialNumber: string | null;
  notBefore: Date;
  notAfter: Date;
  authorized: boolean;
  authorizationError: string | null;
}

export interface TlsProbeFailure {
  ok: false;
  error: string;
}

export type TlsProbeResult = TlsProbeSuccess | TlsProbeFailure;

const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function isAllowedPublicIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return false;
    }
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 169 && b === 254) return false; // link-local / IMDS
    if (a === 172 && b >= 16 && b <= 31) return false; // RFC1918
    if (a === 192 && b === 168) return false; // RFC1918
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmark
    if (a >= 224) return false; // multicast / reserved
    return true;
  }
  if (family === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === '::' || normalized === '::1') return false;
    if (normalized.startsWith('::ffff:')) {
      return isAllowedPublicIp(normalized.slice('::ffff:'.length));
    }
    if (
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb') ||
      normalized.startsWith('ff')
    ) {
      return false;
    }
    return true;
  }
  return false;
}

export function normalizeSslHost(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase().replace(/\.$/, '');
  if (!trimmed || isIP(trimmed) !== 0) return null;
  if (!HOSTNAME_PATTERN.test(trimmed)) return null;
  if (trimmed === 'localhost' || trimmed.endsWith('.local') || trimmed.endsWith('.internal')) {
    return null;
  }
  return trimmed;
}

function firstString(value: string | string[] | undefined): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 255);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string' && item.trim()) return item.trim().slice(0, 255);
    }
  }
  return null;
}

function extractSubjectCn(cert: PeerCertificate, fallbackHost: string): string {
  const cn = firstString(cert.subject?.CN);
  if (cn) return cn;
  if (typeof cert.subjectaltname === 'string') {
    const match = /DNS:([^,\s]+)/i.exec(cert.subjectaltname);
    if (match?.[1]) return match[1].trim().slice(0, 255);
  }
  return fallbackHost;
}

function extractIssuerCn(cert: PeerCertificate): string {
  return (
    firstString(cert.issuer?.CN) ??
    firstString(cert.issuer?.O) ??
    firstString(cert.issuer?.OU) ??
    'Unknown'
  );
}

function sanitizeError(err: unknown): string {
  if (typeof err === 'string' && err.trim()) {
    return err
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
  }
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) {
      return [...message]
        .map((ch) => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? ' ' : ch))
        .join('')
        .trim()
        .slice(0, 200);
    }
  }
  return 'TLS_PROBE_FAILED';
}

@Injectable()
export class TlsProbeService {
  async probe(host: string, port: number, timeoutMs = 3000): Promise<TlsProbeResult> {
    const normalized = normalizeSslHost(host);
    if (!normalized || !Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, error: 'INVALID_TARGET' };
    }

    let safeAddress: string;
    try {
      const records = await Promise.race([
        lookup(normalized, { all: true }),
        new Promise<never>((_, reject) => {
          const t = setTimeout(() => reject(new Error('DNS_TIMEOUT')), timeoutMs);
          t.unref();
        }),
      ]);
      const ipv4 = records.find((r) => r.family === 4 && isAllowedPublicIp(r.address));
      const allowed = ipv4 ?? records.find((r) => isAllowedPublicIp(r.address));
      if (!allowed) {
        return { ok: false, error: 'PRIVATE_ADDRESS_BLOCKED' };
      }
      safeAddress = allowed.address;
    } catch (err) {
      return { ok: false, error: sanitizeError(err) };
    }

    return new Promise<TlsProbeResult>((resolve) => {
      let settled = false;
      const finish = (result: TlsProbeResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(result);
      };

      const socket = connect({
        host: safeAddress,
        port,
        servername: normalized,
        rejectUnauthorized: false,
        timeout: timeoutMs,
      });

      const timer = setTimeout(() => finish({ ok: false, error: 'TLS_TIMEOUT' }), timeoutMs);
      timer.unref();

      socket.once('secureConnect', () => {
        try {
          const cert = socket.getPeerCertificate(false);
          if (!cert || !cert.valid_to || !cert.valid_from) {
            finish({ ok: false, error: 'NO_PEER_CERTIFICATE' });
            return;
          }
          const notBefore = new Date(cert.valid_from);
          const notAfter = new Date(cert.valid_to);
          if (!Number.isFinite(notBefore.getTime()) || !Number.isFinite(notAfter.getTime())) {
            finish({ ok: false, error: 'INVALID_CERTIFICATE_DATES' });
            return;
          }
          const authErr =
            !socket.authorized && socket.authorizationError
              ? sanitizeError(socket.authorizationError)
              : null;
          finish({
            ok: true,
            subjectCn: extractSubjectCn(cert, normalized),
            issuerCn: extractIssuerCn(cert),
            serialNumber:
              typeof cert.serialNumber === 'string' && cert.serialNumber.trim()
                ? cert.serialNumber.trim().slice(0, 128)
                : null,
            notBefore,
            notAfter,
            authorized: socket.authorized,
            authorizationError: authErr,
          });
        } catch (err) {
          finish({ ok: false, error: sanitizeError(err) });
        }
      });

      socket.once('timeout', () => finish({ ok: false, error: 'TLS_TIMEOUT' }));
      socket.once('error', (err) => finish({ ok: false, error: sanitizeError(err) }));
    });
  }
}
