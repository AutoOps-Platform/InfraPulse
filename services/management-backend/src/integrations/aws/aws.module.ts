import { Module, type DynamicModule } from '@nestjs/common';
import type { AwsConfig } from '../../config/app.config.js';
import { AWS_PORT, type AwsPort } from './aws.port.js';
import { AwsSdkAdapter, type AwsClients } from './aws-sdk.adapter.js';
import type { AgentRelease } from './release-config.js';

@Module({})
export class AwsModule {
  static fromQualifiedPort(aws: AwsPort): DynamicModule {
    if (!aws) throw new Error('AWS runtime required.');
    return {
      module: AwsModule,
      providers: [{ provide: AWS_PORT, useValue: aws }],
      exports: [AWS_PORT],
    };
  }

  static register(config: AwsConfig, release: AgentRelease, clients?: AwsClients): DynamicModule {
    return AwsModule.fromQualifiedPort(new AwsSdkAdapter(config, clients, undefined, release));
  }
}
