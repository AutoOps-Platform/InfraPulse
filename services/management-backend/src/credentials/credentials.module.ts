import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AGENT_AUTHENTICATOR } from '../auth/principal.js';
import { AgentKeyGuard } from './agent-key.guard.js';
import {
  CredentialsController,
  InternalCredentialsController,
} from './credentials.controller.js';
import { CredentialsService } from './credentials.service.js';

@Module({
  imports: [AuditModule],
  controllers: [CredentialsController, InternalCredentialsController],
  providers: [
    CredentialsService,
    AgentKeyGuard,
    { provide: AGENT_AUTHENTICATOR, useExisting: AgentKeyGuard },
  ],
  exports: [CredentialsService, AGENT_AUTHENTICATOR],
})
export class CredentialsModule {}
