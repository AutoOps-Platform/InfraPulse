import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Request } from 'express';
import { ApiError } from '../common/errors.js';
import { SafeLogger } from '../common/safe-logger.js';
import { AssertionVerifier } from './assertions.js';
import { NonceService } from './nonce.service.js';
import {
  AGENT_AUTHENTICATOR,
  type AgentAuthenticatorPort,
  type Principal,
} from './principal.js';
import { authorize, routePolicy } from './policies.js';
export type AuthenticatedRequest = Request & {
  rawBody?: Uint8Array;
  principal?: Principal;
};
function bearer(request: Request): string {
  let count = 0;
  for (let i = 0; i < request.rawHeaders.length; i += 2)
    if (request.rawHeaders[i].toLowerCase() === 'authorization') count++;
  if (count > 1) throw new ApiError('invalid_request');
  const value = request.headers.authorization;
  if (!value || value.length > 8200 || !/^Bearer [A-Za-z0-9_.-]+$/.test(value))
    throw new ApiError('unauthorized');
  return value.slice(7);
}
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new SafeLogger();
  constructor(
    private readonly verifier: AssertionVerifier,
    private readonly nonces: NonceService,
    private readonly modules: ModuleRef,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      return await this.authenticate(context);
    } catch (error) {
      const safe =
        error instanceof ApiError
          ? error
          : new ApiError('dependency_unavailable');
      // Admission/rate bounds apply before this guard. Never log proof, request or exception objects.
      this.logger.event('request_failed', {
        code: safe.code,
        status: safe.status,
      });
      throw safe;
    }
  }
  private async authenticate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    // Never trust an upstream/user-populated principal object.
    delete request.principal;
    const policy = routePolicy(context.getHandler(), context.getClass());
    if (policy.kind === 'public-health') {
      if (
        request.method !== 'GET' ||
        !['/health/live', '/health/ready'].includes(request.path)
      )
        throw new ApiError('forbidden');
      return true;
    }
    if (policy.kind === 'agent') {
      let agents: AgentAuthenticatorPort;
      try {
        agents = this.modules.get<AgentAuthenticatorPort>(AGENT_AUTHENTICATOR, {
          strict: false,
        });
      } catch {
        throw new ApiError('dependency_unavailable');
      }
      if (!agents || typeof agents.authenticate !== 'function')
        throw new ApiError('dependency_unavailable');
      const principal = await agents.authenticate(
        bearer(request),
        policy.scope,
      );
      authorize(policy, principal);
      request.principal = Object.freeze({
        kind: 'agent',
        credential_id: principal.credential_id,
        server_id: principal.server_id,
        agent_id: principal.agent_id,
        scopes: Object.freeze([...principal.scopes]),
      });
      return true;
    }
    const verified = await this.verifier.verify(bearer(request), {
      method: request.method,
      target: request.originalUrl,
      rawBody: request.rawBody ?? new Uint8Array(),
    });
    authorize(policy, verified.principal);
    await this.nonces.reserve(
      verified.issuer,
      verified.jti,
      verified.expiresAt,
    );
    request.principal = verified.principal;
    return true;
  }
}
