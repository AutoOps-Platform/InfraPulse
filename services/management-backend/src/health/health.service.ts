import { Injectable, Optional } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { ApiError } from '../common/errors.js';

@Injectable()
export class HealthService {
  constructor(@Optional() private readonly database?: DatabaseService) {}
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }
  async ready(): Promise<{ status: 'ok' }> {
    if (!this.database || !(await this.database.ready()))
      throw new ApiError('dependency_unavailable');
    return { status: 'ok' };
  }
}
