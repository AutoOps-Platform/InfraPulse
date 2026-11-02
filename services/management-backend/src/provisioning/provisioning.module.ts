import { Module, type DynamicModule } from '@nestjs/common';
import type { ManagementConfig } from '../config/config.js';
import { AuditModule } from '../audit/audit.module.js';
import { ProvisioningController } from './provisioning.controller.js';
import {
  PROVISIONING_INGEST_BASE,
  ProvisioningService,
} from './provisioning.service.js';

@Module({})
export class ProvisioningModule {
  static register(config: ManagementConfig): DynamicModule {
    return {
      module: ProvisioningModule,
      imports: [AuditModule],
      controllers: [ProvisioningController],
      providers: [
        ProvisioningService,
        {
          provide: PROVISIONING_INGEST_BASE,
          useValue: config.MANAGEMENT_AGENT_INGEST_BASE_URL,
        },
      ],
    };
  }
}
