import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { ManagementConfig } from '../../../config/app.config.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuthController } from './controllers/auth.controller.js';
import { AuthenticationGuard, RolesGuard } from './guards/auth.guard.js';
import { NonceRepository } from './repositories/nonce.repository.js';
import { AssertionVerifier } from './services/assertion.service.js';
import { NonceService } from './services/nonce.service.js';

@Module({})
export class AuthModule {
  static register(config: ManagementConfig): DynamicModule {
    return {
      module: AuthModule,
      controllers: [AuthController],
      providers: [
        NonceRepository,
        {
          provide: AssertionVerifier,
          useFactory: () => new AssertionVerifier(config),
        },
        {
          provide: NonceService,
          inject: [PrismaService, NonceRepository],
          useFactory: (prisma: PrismaService, repo: NonceRepository) =>
            new NonceService(prisma, repo, config.MANAGEMENT_NONCE_MAX_ENTRIES),
        },
        { provide: APP_GUARD, useClass: AuthenticationGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
      exports: [AssertionVerifier, NonceService],
    };
  }
}
