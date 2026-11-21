import { Global, Module, type DynamicModule } from '@nestjs/common';
import type { ManagementConfig } from '../../config/app.config.js';
import { PrismaService } from './prisma.service.js';

@Global()
@Module({})
export class PrismaModule {
  static register(config: ManagementConfig): DynamicModule {
    return {
      global: true,
      module: PrismaModule,
      providers: [
        {
          provide: PrismaService,
          useFactory: () => new PrismaService(config),
        },
      ],
      exports: [PrismaService],
    };
  }
}
