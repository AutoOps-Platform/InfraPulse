import { Module, type DynamicModule } from '@nestjs/common';
import type { AmpRemoteWriteFn } from '../../../integrations/aws/amp-remote-write.js';
import { AuditModule } from '../audit/audit.module.js';
import { SslTargetsController } from './controllers/ssl-targets.controller.js';
import { SslTargetsRepository } from './repositories/ssl-targets.repository.js';
import {
  SSL_AMP_REMOTE_WRITE,
  SslTargetsService,
} from './services/ssl-targets.service.js';
import { TlsProbeService } from './services/tls-probe.service.js';

@Module({})
export class SslTargetsModule {
  static register(ampRemoteWrite?: AmpRemoteWriteFn): DynamicModule {
    return {
      module: SslTargetsModule,
      imports: [AuditModule],
      controllers: [SslTargetsController],
      providers: [
        SslTargetsRepository,
        TlsProbeService,
        SslTargetsService,
        ...(ampRemoteWrite
          ? [{ provide: SSL_AMP_REMOTE_WRITE, useValue: ampRemoteWrite }]
          : []),
      ],
      exports: [SslTargetsService],
    };
  }
}
