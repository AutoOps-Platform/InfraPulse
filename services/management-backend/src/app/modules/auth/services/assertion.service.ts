import { createHash, createPublicKey, type KeyObject } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { decodeProtectedHeader, jwtVerify } from 'jose';
import type { ManagementConfig, TrustEntry } from '../../../../config/app.config.js';
import { ApiError, systemClock, type Clock } from '../../../common/errors.js';
import { isSafeText, isUuid } from '../../../common/pagination.js';
import type { UserPrincipal, UserRole } from '../guards/auth.guard.js';

export type VerifiedAssertion = Readonly<{
  principal: UserPrincipal;
  issuer: string;
  jti: string;
  expiresAt: Date;
}>;

export interface RequestBinding {
  method: string;
  target: string;
  rawBody: Uint8Array;
}

const ROLE_MAP: Readonly<Record<string, UserRole>> = {
  Viewer: 'Viewer',
  Editor: 'Operator',
  Admin: 'Admin',
};

@Injectable()
export class AssertionVerifier {
  private readonly users = new Map<string, { entry: TrustEntry; key: KeyObject }>();

  constructor(
    private readonly config: ManagementConfig,
    private readonly clock: Clock = systemClock,
  ) {
    try {
      const seenKeys = new Set<string>();
      for (const [kid, entry] of Object.entries(config.adminTrust)) {
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(kid) || !isSafeText(entry.issuer) || !isSafeText(entry.audience)) {
          throw new Error();
        }
        const key = createPublicKey(entry.public_key_pem);
        if (key.asymmetricKeyType !== 'ed25519') throw new Error();
        const canonicalPem = key.export({ type: 'spki', format: 'pem' }).toString();
        if (seenKeys.has(canonicalPem)) throw new Error();
        seenKeys.add(canonicalPem);
        this.users.set(kid, { entry, key });
      }
      if (!this.users.size) throw new Error();
    } catch {
      throw new ApiError('dependency_unavailable');
    }
  }

  async verify(token: string, binding: RequestBinding): Promise<VerifiedAssertion> {
    try {
      if (typeof token !== 'string' || token.length > 8192) throw new Error();
      const header = decodeProtectedHeader(token);
      if (
        header.alg !== 'EdDSA' ||
        typeof header.kid !== 'string' ||
        header.jku !== undefined ||
        header.x5u !== undefined ||
        header.jwk !== undefined
      ) {
        throw new Error();
      }

      const trusted = this.users.get(header.kid);
      if (!trusted) throw new Error();

      const { payload } = await jwtVerify(token, trusted.key, {
        algorithms: ['EdDSA'],
        issuer: trusted.entry.issuer,
        audience: trusted.entry.audience,
        currentDate: new Date(this.clock.nowMs()),
        clockTolerance: 5,
        requiredClaims: ['iss', 'aud', 'sub', 'iat', 'nbf', 'exp', 'jti'],
      });

      const now = this.clock.nowMs() / 1000;
      if (
        payload.kind !== 'user' ||
        ![payload.iat, payload.nbf, payload.exp].every(Number.isSafeInteger) ||
        payload.exp! <= payload.iat! ||
        payload.exp! - payload.iat! > 60 ||
        payload.iat! > now + 5 ||
        payload.nbf! >= payload.exp! ||
        !isSafeText(payload.sub) ||
        !isSafeText(payload.iss) ||
        typeof payload.aud !== 'string' ||
        !isUuid(payload.jti) ||
        (trusted.entry.subject !== undefined && payload.sub !== trusted.entry.subject) ||
        payload.m !== binding.method ||
        binding.method !== binding.method.toUpperCase() ||
        payload.t !== binding.target ||
        payload.b !== createHash('sha256').update(binding.rawBody).digest('base64url') ||
        typeof payload.grafana_role !== 'string' ||
        !Object.hasOwn(ROLE_MAP, payload.grafana_role) ||
        payload.ctx !== this.config.MANAGEMENT_GRAFANA_CONTEXT ||
        (payload.display !== undefined && !isSafeText(payload.display))
      ) {
        throw new Error();
      }

      const principal: UserPrincipal = Object.freeze({
        kind: 'user',
        issuer: payload.iss,
        subject: payload.sub,
        context: this.config.MANAGEMENT_GRAFANA_CONTEXT,
        role: ROLE_MAP[payload.grafana_role],
        ...(payload.display === undefined ? {} : { display: payload.display }),
      });

      return Object.freeze({
        principal,
        issuer: payload.iss,
        jti: payload.jti,
        expiresAt: new Date(payload.exp! * 1000),
      });
    } catch {
      throw new ApiError('unauthorized');
    }
  }
}
