import { Controller, Get } from '@nestjs/common';
import { HealthService } from './health.service.js';
import { PublicHealth } from '../auth/policies.js';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}
  @PublicHealth()
  @Get('live')
  live() {
    return this.health.live();
  }
  @PublicHealth()
  @Get('ready')
  ready() {
    return this.health.ready();
  }
}
