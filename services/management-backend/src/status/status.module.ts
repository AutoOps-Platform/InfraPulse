import { Global, Module, type DynamicModule } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import type { ManagementConfig } from '../config/config.js';
import { StatusController } from './status.controller.js';
import { StatusService } from './status.service.js';

@Global()
@Module({})
export class StatusModule {
  static register(config: ManagementConfig): DynamicModule {
    // A configured public trust entry is the sole source selector. Duplicate
    // rotating keys for one issuer/subject do not create multiple sources.
    const sources = [
      ...new Map(
        Object.values(config.serviceTrust)
          .filter(
            (t) =>
              t.scopes?.includes('status:write') &&
              !!t.subject &&
              /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
                t.subject,
              ),
          )
          .map((t) => [
            `${t.issuer}\0${t.subject}`,
            Object.freeze({ issuer: t.issuer, subject: t.subject! }),
          ]),
      ).values(),
    ];
    return {
      module: StatusModule,
      controllers: [StatusController],
      providers: [
        {
          provide: StatusService,
          inject: [DatabaseService],
          useFactory: (db: DatabaseService) =>
            new StatusService(db, Object.freeze(sources)),
        },
      ],
      exports: [StatusService],
    };
  }
}
