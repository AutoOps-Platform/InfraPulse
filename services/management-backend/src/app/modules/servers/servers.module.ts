import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { GroupsModule } from '../groups/groups.module.js';
import { ServersController } from './controllers/servers.controller.js';
import { ServersRepository } from './repositories/servers.repository.js';
import { ServersService } from './services/servers.service.js';

@Module({
  imports: [AuditModule, GroupsModule],
  controllers: [ServersController],
  providers: [ServersRepository, ServersService],
  exports: [ServersService],
})
export class ServersModule {}
