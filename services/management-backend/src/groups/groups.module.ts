import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { GroupsController } from './groups.controller.js';
import { GroupsService } from './groups.service.js';
@Module({
  imports: [AuditModule],
  controllers: [GroupsController],
  providers: [GroupsService],
  exports: [GroupsService],
})
export class GroupsModule {}
