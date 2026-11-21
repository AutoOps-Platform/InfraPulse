import {
  Injectable,
  createParamDecorator,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiError, SafeLogger } from '../../../common/errors.js';
import { AssertionVerifier } from '../services/assertion.service.js';
import { NonceService } from '../services/nonce.service.js';

export type UserRole = 'Viewer' | 'Operator' | 'Admin';

export type UserPrincipal = Readonly<{
  kind: 'user';
  issuer: string;
  subject: string;
  context: string;
  role: UserRole;
  display?: string;
}>;

export type AuthenticatedRequest = Request & {
  rawBody?: Buffer;
  principal?: UserPrincipal;
  managementRequestId?: string;
};

export type Policy = Readonly<
  | { kind: 'user'; roles: readonly UserRole[] }
  | { kind: 'public-health' }
>;

const POLICY_METADATA = Symbol('management.route-policy');

function attachPolicy(value: Policy): MethodDecorator & ClassDecorator {
  return (target: object, _key?: string | symbol, descriptor?: PropertyDescriptor) => {
    const owner = descriptor?.value ?? target;
    const previous: readonly Policy[] = Reflect.getOwnMetadata(POLICY_METADATA, owner) ?? [];
    Reflect.defineMetadata(
      POLICY_METADATA,
      Object.freeze([...previous, Object.freeze(value)]),
      owner,
    );
  };
}

export const UserRoles = (...roles: UserRole[]) =>
  attachPolicy({ kind: 'user', roles: Object.freeze([...roles]) });

export const PublicHealth = () => attachPolicy({ kind: 'public-health' });

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): UserPrincipal => {
    const principal = context.switchToHttp().getRequest<AuthenticatedRequest>().principal;
    if (!principal || principal.kind !== 'user') throw new ApiError('unauthorized');
    return principal;
  },
);

export function routePolicy(handler: object, controller: object): Policy {
  const policies = [
    ...(Reflect.getOwnMetadata(POLICY_METADATA, handler) ?? []),
    ...(Reflect.getOwnMetadata(POLICY_METADATA, controller) ?? []),
  ] as Policy[];
  if (policies.length !== 1) throw new ApiError('forbidden');
  return policies[0];
}

export function authorize(policy: Policy, principal: UserPrincipal): void {
  if (policy.kind !== 'user' || !policy.roles.includes(principal.role)) {
    throw new ApiError('forbidden');
  }
}

function extractBearer(request: AuthenticatedRequest): string {
  const authHeaders = request.rawHeaders.filter(
    (_, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === 'authorization',
  );
  const raw = request.headers.authorization;
  if (authHeaders.length !== 1 || typeof raw !== 'string') {
    throw new ApiError('unauthorized');
  }
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(raw.trim());
  if (!match) throw new ApiError('unauthorized');
  return match[1];
}

@Injectable()
export class AuthenticationGuard implements CanActivate {
  private readonly logger = new SafeLogger();

  constructor(
    private readonly verifier: AssertionVerifier,
    private readonly nonces: NonceService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
      delete request.principal;

      const policy = routePolicy(context.getHandler(), context.getClass());
      if (policy.kind === 'public-health') {
        if (request.method !== 'GET' || !['/health/live', '/health/ready'].includes(request.path)) {
          throw new ApiError('forbidden');
        }
        return true;
      }

      const verified = await this.verifier.verify(extractBearer(request), {
        method: request.method,
        target: request.originalUrl,
        rawBody: request.rawBody ?? new Uint8Array(),
      });
      authorize(policy, verified.principal);
      await this.nonces.reserve(verified.issuer, verified.jti, verified.expiresAt);
      request.principal = verified.principal;
      return true;
    } catch (error) {
      const safe = error instanceof ApiError ? error : new ApiError('dependency_unavailable');
      this.logger.event('request_failed', { code: safe.code, status: safe.status });
      throw safe;
    }
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const policy = routePolicy(context.getHandler(), context.getClass());
    if (policy.kind === 'public-health') return true;
    const principal = context.switchToHttp().getRequest<AuthenticatedRequest>().principal;
    if (!principal) throw new ApiError('unauthorized');
    authorize(policy, principal);
    return true;
  }
}
