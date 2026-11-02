import { createHash, createPublicKey, type KeyObject } from 'node:crypto';
import { decodeProtectedHeader, jwtVerify } from 'jose';
import type { ManagementConfig, TrustEntry } from '../config/config.js';
import { systemClock, type Clock } from '../common/clock.js';
import { ApiError } from '../common/errors.js';
import type { ServicePrincipal, UserPrincipal, UserRole } from './principal.js';

export type VerifiedAssertion = Readonly<{
  principal: UserPrincipal | ServicePrincipal;
  issuer: string;
  jti: string;
  expiresAt: Date;
}>;
export type RequestBinding = {
  method: string;
  target: string;
  rawBody: Uint8Array;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const text = (value: unknown, max = 128): value is string =>
  typeof value === 'string' &&
  value.length >= 1 &&
  value.length <= max &&
  !/[\u0000-\u001f\u007f]/u.test(value);
type TrustedKey = {
  entry: TrustEntry;
  key: KeyObject;
  kind: 'user' | 'service';
};

export class AssertionVerifier {
  private readonly users = new Map<string, TrustedKey>();
  private readonly services = new Map<string, TrustedKey>();
  constructor(
    private readonly config: ManagementConfig,
    private readonly clock: Clock = systemClock,
  ) {
    // Startup trust validation is separate from T1's bounded JSON shape checks.
    try {
      const fingerprints = new Map<string, 'user' | 'service'>();
      for (const [kind, trust, destination] of [
        ['user', config.adminTrust, this.users],
        ['service', config.serviceTrust, this.services],
      ] as const) {
        for (const [kid, entry] of Object.entries(trust)) {
          if (
            !/^[A-Za-z0-9._-]{1,64}$/.test(kid) ||
            !text(entry.issuer) ||
            !text(entry.audience)
          )
            throw new Error();
          if (
            kind === 'service' &&
            (!text(entry.subject) ||
              !entry.scopes?.length ||
              entry.scopes.some(
                (scope) =>
                  !['credentials:verify', 'status:write'].includes(scope),
              ))
          )
            throw new Error();
          const key = createPublicKey(entry.public_key_pem);
          if (key.asymmetricKeyType !== 'ed25519') throw new Error();
          const fingerprint = createHash('sha256')
            .update(key.export({ type: 'spki', format: 'der' }))
            .digest('hex');
          if (
            fingerprints.has(fingerprint) &&
            fingerprints.get(fingerprint) !== kind
          )
            throw new Error();
          fingerprints.set(fingerprint, kind);
          destination.set(kid, { entry, key, kind });
        }
      }
      for (const user of this.users.values())
        for (const service of this.services.values()) {
          if (
            user.entry.issuer === service.entry.issuer ||
            user.entry.audience === service.entry.audience
          )
            throw new Error();
        }
      if (!this.users.size || !this.services.size) throw new Error();
    } catch {
      throw new ApiError('dependency_unavailable');
    }
  }
  async verify(
    token: string,
    binding: RequestBinding,
  ): Promise<VerifiedAssertion> {
    try {
      if (typeof token !== 'string' || token.length > 8192) throw new Error();
      const header = decodeProtectedHeader(token);
      if (
        header.alg !== 'EdDSA' ||
        typeof header.kid !== 'string' ||
        header.jku !== undefined ||
        header.x5u !== undefined ||
        header.jwk !== undefined
      )
        throw new Error();
      const candidates = [
        this.users.get(header.kid),
        this.services.get(header.kid),
      ].filter((value): value is TrustedKey => !!value);
      let verified:
        | {
            payload: Awaited<ReturnType<typeof jwtVerify>>['payload'];
            trusted: TrustedKey;
          }
        | undefined;
      for (const trusted of candidates) {
        try {
          const { payload } = await jwtVerify(token, trusted.key, {
            algorithms: ['EdDSA'],
            issuer: trusted.entry.issuer,
            audience: trusted.entry.audience,
            currentDate: new Date(this.clock.nowMs()),
            clockTolerance: 5,
            requiredClaims: ['iss', 'aud', 'sub', 'iat', 'nbf', 'exp', 'jti'],
          });
          if (payload.kind !== trusted.kind) continue;
          verified = { payload, trusted };
          break;
        } catch {
          /* Only local allowlisted keys are considered; never fetch token URLs. */
        }
      }
      if (!verified) throw new Error();
      const { payload: p, trusted } = verified;
      const now = this.clock.nowMs() / 1000;
      if (
        ![p.iat, p.nbf, p.exp].every(Number.isSafeInteger) ||
        p.exp! <= p.iat! ||
        p.exp! - p.iat! > 60 ||
        p.iat! > now + 5 ||
        p.nbf! >= p.exp!
      )
        throw new Error();
      if (
        !text(p.sub) ||
        !text(p.iss) ||
        typeof p.aud !== 'string' ||
        typeof p.jti !== 'string' ||
        !uuid.test(p.jti)
      )
        throw new Error();
      if (
        trusted.entry.subject !== undefined &&
        p.sub !== trusted.entry.subject
      )
        throw new Error();
      if (
        p.m !== binding.method ||
        binding.method !== binding.method.toUpperCase() ||
        p.t !== binding.target ||
        p.b !== createHash('sha256').update(binding.rawBody).digest('base64url')
      )
        throw new Error();
      let principal: UserPrincipal | ServicePrincipal;
      if (trusted.kind === 'user') {
        const roles: Readonly<Record<string, UserRole>> = {
          Viewer: 'Viewer',
          Editor: 'Operator',
          Admin: 'Admin',
        };
        if (
          typeof p.grafana_role !== 'string' ||
          !Object.hasOwn(roles, p.grafana_role) ||
          p.ctx !== this.config.MANAGEMENT_GRAFANA_CONTEXT ||
          (p.display !== undefined && !text(p.display))
        )
          throw new Error();
        principal = Object.freeze({
          kind: 'user',
          issuer: p.iss,
          subject: p.sub,
          context: this.config.MANAGEMENT_GRAFANA_CONTEXT,
          role: roles[p.grafana_role],
          ...(p.display === undefined ? {} : { display: p.display as string }),
        });
      } else {
        if (p.grafana_role !== undefined || p.ctx !== undefined)
          throw new Error();
        principal = Object.freeze({
          kind: 'service',
          issuer: p.iss,
          subject: p.sub,
          scopes: Object.freeze([...trusted.entry.scopes!]),
        });
      }
      return Object.freeze({
        principal,
        issuer: p.iss,
        jti: p.jti,
        expiresAt: new Date(p.exp! * 1000),
      });
    } catch {
      throw new ApiError('unauthorized');
    }
  }
}
