import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { inventoryPageSchema } from '../../../common/http.js';
import { UserRoles } from '../../auth/guards/auth.guard.js';
import type { AuditQuery } from '../dto/audit.dto.js';
import { AuditService } from '../services/audit.service.js';

@ApiTags('Audit')
@ApiBearerAuth('AdminAssertion')
@ApiResponse({ status: 401, description: 'Invalid assertion' })
@ApiResponse({ status: 403, description: 'Admin required' })
@ApiResponse({ status: 503, description: 'Dependency unavailable' })
@Controller('api/v1/audit-logs')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @UserRoles('Admin')
  @ApiOkResponse({ schema: inventoryPageSchema('AuditDto') })
  @ApiOperation({ summary: 'List business audit' })
  list(@Query() query: AuditQuery) {
    return this.auditService.list(query);
  }
}
