import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { ManagementConfig } from '../config/config.js';
import { DatabaseService } from '../database/database.service.js';
import { AssertionVerifier } from './assertions.js';
import { NonceService } from './nonce.service.js';
import { AuthGuard } from './auth.guard.js';
import { RolesGuard } from './roles.guard.js';
@Module({})
export class AuthModule {
  static register(config: ManagementConfig): DynamicModule {
    return {
      module: AuthModule,
      providers: [
        {
          provide: AssertionVerifier,
          useFactory: () => new AssertionVerifier(config),
        },
        {
          provide: NonceService,
          inject: [DatabaseService],
          useFactory: (database: DatabaseService) =>
            new NonceService(database, config.MANAGEMENT_NONCE_MAX_ENTRIES),
        },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
      exports: [AssertionVerifier, NonceService],
    };
  }
}
