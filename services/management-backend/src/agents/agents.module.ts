import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AgentsController } from './agents.controller.js';
import { AgentsService } from './agents.service.js';
@Module({
  imports: [AuditModule],
  controllers: [AgentsController],
  providers: [AgentsService],
  exports: [AgentsService],
})
export class AgentsModule {}
