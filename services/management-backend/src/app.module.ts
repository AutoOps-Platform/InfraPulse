import { Module, type DynamicModule } from '@nestjs/common';
import type { ManagementConfig } from './config/config.js';
import { DatabaseModule } from './database/database.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { HealthModule } from './health/health.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ServersModule } from './servers/servers.module.js';
import { CredentialsModule } from './credentials/credentials.module.js';
import { ProfilesModule } from './profiles/profiles.module.js';
import { ProvisioningModule } from './provisioning/provisioning.module.js';
import { StatusModule } from './status/status.module.js';

@Module({
  imports: [HealthModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {
  static register(config: ManagementConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        DatabaseModule.register(config),
        AuditModule,
        AuthModule.register(config),
        StatusModule.register(config),
        ServersModule,
        CredentialsModule,
        ProfilesModule,
        ProvisioningModule.register(config),
      ],
    };
  }
}
