import { Module, type DynamicModule } from '@nestjs/common';
import { AwsModule } from '../../../integrations/aws/aws.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { ServersModule } from '../servers/servers.module.js';
import { OnboardingController } from './controllers/onboarding.controller.js';
import {
  OnboardingRepository,
  type PresetMatcher,
} from './repositories/onboarding.repository.js';
import type { BootstrapAssetsPort } from './services/bootstrap.service.js';
import { DecommissionService } from './services/decommission.service.js';
import { OnboardingService } from './services/onboarding.service.js';
import {
  OnboardingRuntime,
  OnboardingWorker,
  type Clock,
  type CommandFactory,
  type MetricVerifierPort,
  type Scheduler,
} from './services/onboarding-worker.service.js';

export interface ProtectedOnboardingRuntime {
  awsModule: DynamicModule;
  accountId: string;
  region: 'ap-southeast-1';
  verifier: MetricVerifierPort;
  command: CommandFactory;
  presetMatches: PresetMatcher;
  bootstrapAssets?: BootstrapAssetsPort;
  clock?: Clock;
  scheduler?: Scheduler;
  jitter?: () => number;
}

@Module({})
export class OnboardingModule {
  static register(runtime?: ProtectedOnboardingRuntime): DynamicModule {
    if (
      !runtime ||
      runtime.awsModule?.module !== AwsModule ||
      !runtime.verifier ||
      typeof runtime.command !== 'function' ||
      typeof runtime.presetMatches !== 'function' ||
      typeof runtime.verifier.verify !== 'function' ||
      !/^\d{12}$/.test(runtime.accountId) ||
      runtime.region !== 'ap-southeast-1'
    ) {
      throw new Error('Protected onboarding runtime required.');
    }

    return {
      module: OnboardingModule,
      imports: [runtime.awsModule, AuditModule, ServersModule],
      controllers: [OnboardingController],
      providers: [
        { provide: OnboardingRuntime, useValue: new OnboardingRuntime(runtime) },
        OnboardingRepository,
        DecommissionService,
        OnboardingWorker,
        OnboardingService,
      ],
      exports: [OnboardingRepository, OnboardingWorker, OnboardingService],
    };
  }
}
