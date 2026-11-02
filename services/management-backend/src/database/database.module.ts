import { Global, Module, type DynamicModule } from '@nestjs/common';
import type { ManagementConfig } from '../config/config.js';
import { DatabaseService } from './database.service.js';

@Global()
@Module({})
export class DatabaseModule {
  static register(config: ManagementConfig): DynamicModule {
    return {
      global: true,
      module: DatabaseModule,
      providers: [
        {
          provide: DatabaseService,
          useFactory: () => new DatabaseService(config),
        },
      ],
      exports: [DatabaseService],
    };
  }
}
