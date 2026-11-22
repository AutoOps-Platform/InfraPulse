import { Controller, Get } from '@nestjs/common';
import { PublicHealth } from '../../auth/guards/auth.guard.js';
import { HealthService } from '../services/health.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @PublicHealth()
  @Get('live')
  live() {
    return this.healthService.live();
  }

  @PublicHealth()
  @Get('ready')
  ready() {
    return this.healthService.ready();
  }
}
