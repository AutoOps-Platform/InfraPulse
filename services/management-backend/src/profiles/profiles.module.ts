import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ProfilesController } from './profiles.controller.js';
import { ProfilesService } from './profiles.service.js';
@Module({
  imports: [AuditModule],
  controllers: [ProfilesController],
  providers: [ProfilesService],
  exports: [ProfilesService],
})
export class ProfilesModule {}
