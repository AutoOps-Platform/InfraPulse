import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { GroupsController } from './controllers/groups.controller.js';
import { GroupsRepository } from './repositories/groups.repository.js';
import { GroupsService } from './services/groups.service.js';

@Module({
  imports: [AuditModule],
  controllers: [GroupsController],
  providers: [GroupsRepository, GroupsService],
  exports: [GroupsService],
})
export class GroupsModule {}
