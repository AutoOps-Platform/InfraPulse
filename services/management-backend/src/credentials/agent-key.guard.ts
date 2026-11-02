import { Inject, Injectable } from '@nestjs/common';
import type {
  AgentAuthenticatorPort,
  AgentPrincipal,
  CredentialScope,
} from '../auth/principal.js';
import { ApiError } from '../common/errors.js';
import { CredentialsService } from './credentials.service.js';

// Adapter consumed only through T3's global policy guard. It does not bypass that guard
// and is not a second APP_GUARD: @AgentScope is policy, never a proof by itself.
@Injectable()
export class AgentKeyGuard implements AgentAuthenticatorPort {
  constructor(
    @Inject(CredentialsService)
    private readonly credentials: CredentialsService,
  ) {}
  async authenticate(
    apiKey: string,
    scope: CredentialScope,
  ): Promise<AgentPrincipal> {
    const proof = await this.credentials.proof(apiKey);
    if (!proof.active) throw new ApiError('unauthorized');
    if (!proof.scopes.includes(scope)) throw new ApiError('forbidden');
    return Object.freeze({
      kind: 'agent',
      credential_id: proof.credential_id,
      server_id: proof.server_id,
      agent_id: proof.agent_id,
      scopes: Object.freeze([...proof.scopes]),
    });
  }
}
