import { Controller, Get, Inject, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { inventoryPageSchema } from '../common/openapi.js';
import { UserRoles } from '../auth/policies.js';
import { AuditService } from './audit.service.js';
import type { AuditQuery } from './audit.dto.js';
@ApiTags('Audit')
@ApiBearerAuth('AdminAssertion')
@ApiResponse({ status: 401, description: 'Invalid assertion' })
@ApiResponse({ status: 403, description: 'Admin required' })
@ApiResponse({ status: 503, description: 'Dependency unavailable' })
@Controller('api/v1/audit-logs')
export class AuditController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}
  @Get()
  @UserRoles('Admin')
  @ApiOkResponse({ schema: inventoryPageSchema('AuditDto') })
  @ApiOperation({
    summary: 'List business audit',
    description:
      'Admin only; Viewer/Operator denied. Safe actor/resource/action/time projection, no raw body/credentials. Opaque cursor, limit20/max100. Filters actor_issuer/actor_subject/resource_type/resource_id/action/from/to (UTC ISO milliseconds). No-store; append-only, no update/delete endpoint.',
  })
  list(@Query() query: AuditQuery) {
    return this.audit.list(query);
  }
}
