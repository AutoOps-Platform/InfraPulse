import { Injectable, Optional } from '@nestjs/common';
import { ApiError } from '../../../common/errors.js';
import { PrismaService } from '../../../prisma/prisma.service.js';

@Injectable()
export class HealthService {
  constructor(@Optional() private readonly prisma?: PrismaService) {}

  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  async ready(): Promise<{ status: 'ok' }> {
    try {
      if (!this.prisma) throw new ApiError('dependency_unavailable');
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok' };
    } catch {
      throw new ApiError('dependency_unavailable');
    }
  }
}
