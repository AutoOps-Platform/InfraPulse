import { Module, type DynamicModule } from '@nestjs/common';
import type { ManagementConfig } from '../config/app.config.js';
import type { AmpRemoteWriteFn } from '../integrations/aws/amp-remote-write.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { GroupsModule } from './modules/groups/groups.module.js';
import { HealthModule } from './modules/health/health.module.js';
import {
  OnboardingModule,
  type ProtectedOnboardingRuntime,
} from './modules/onboarding/onboarding.module.js';
import { ServersModule } from './modules/servers/servers.module.js';
import { SslTargetsModule } from './modules/ssl-targets/ssl-targets.module.js';
import { PrismaModule } from './prisma/prisma.module.js';

@Module({
  imports: [HealthModule],
})
export class AppModule {
  static register(
    config: ManagementConfig,
    onboarding?: ProtectedOnboardingRuntime,
    ampRemoteWrite?: AmpRemoteWriteFn,
  ): DynamicModule {
    if (config.aws && !onboarding) {
      throw new Error('Protected AWS runtime required.');
    }
    return {
      module: AppModule,
      imports: [
        PrismaModule.register(config),
        AuditModule,
        AuthModule.register(config),
        HealthModule,
        GroupsModule,
        ServersModule,
        SslTargetsModule.register(ampRemoteWrite),
        ...(onboarding ? [OnboardingModule.register(onboarding)] : []),
      ],
    };
  }
}
