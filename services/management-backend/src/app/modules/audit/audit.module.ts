import { Module } from '@nestjs/common';
import { AuditController } from './controllers/audit.controller.js';
import { AuditRepository } from './repositories/audit.repository.js';
import { AuditService } from './services/audit.service.js';

@Module({
  controllers: [AuditController],
  providers: [AuditRepository, AuditService],
  exports: [AuditService],
})
export class AuditModule {}
