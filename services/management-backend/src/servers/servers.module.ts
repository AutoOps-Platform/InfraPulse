import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { GroupsModule } from '../groups/groups.module.js';
import { AgentsModule } from '../agents/agents.module.js';
import { ServersController } from './servers.controller.js';
import { ServersService } from './servers.service.js';
@Module({
  imports: [AuditModule, GroupsModule, AgentsModule],
  controllers: [ServersController],
  providers: [ServersService],
  exports: [ServersService],
})
export class ServersModule {}
