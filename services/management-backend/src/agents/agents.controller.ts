import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { inventoryPageSchema } from '../common/openapi.js';
import { UserRoles } from '../auth/policies.js';
import { CurrentUser } from '../auth/current-user.js';
import type { UserPrincipal } from '../auth/principal.js';
import type { PageQuery } from '../common/pagination.js';
import { AgentsService } from './agents.service.js';
import { AgentDto, transitionBody } from './agents.dto.js';
type AuditRequest = { managementRequestId: string };
@ApiTags('Agents')
@ApiBearerAuth('AdminAssertion')
@ApiResponse({ status: 401, description: 'Invalid assertion' })
@ApiResponse({ status: 403, description: 'Role not allowed' })
@ApiResponse({ status: 503, description: 'Dependency/audit unavailable' })
@Controller('api/v1/agents')
export class AgentsController {
  constructor(@Inject(AgentsService) private readonly agents: AgentsService) {}
  @Get()
  @UserRoles('Viewer', 'Operator', 'Admin')
  @ApiOkResponse({ schema: inventoryPageSchema('AgentDto') })
  @ApiOperation({
    summary: 'List Agents',
    description:
      'Viewer/Operator/Admin inventory read. limit20/max100, cursor, server/lifecycle filters. Active is permission, NOT Online. No-store.',
  })
  list(@Query() query: PageQuery) {
    return this.agents.list(query);
  }
  @Get(':id')
  @UserRoles('Viewer', 'Operator', 'Admin')
  @ApiOkResponse({ type: AgentDto })
  @ApiOperation({
    summary: 'Get Agent',
    description:
      'Viewer/Operator/Admin read. Lifecycle only; immutable Server/OS; no telemetry claim. No-store.',
  })
  get(@Param('id') id: string) {
    return this.agents.get(id);
  }
  @Post(':id/disable')
  @UserRoles('Admin')
  @ApiCreatedResponse({ type: AgentDto })
  @ApiBody({
    required: false,
    schema: { type: 'object', additionalProperties: false },
  })
  @ApiOperation({
    summary: 'Disable Agent',
    description:
      'Admin only. Revoke all key rows atomically with lifecycle/audit. No-store.',
  })
  disable(
    @Param('id') id: string,
    @Body() input: unknown,
    @CurrentUser() actor: UserPrincipal,
    @Req() req: AuditRequest,
  ) {
    transitionBody(input);
    return this.agents.transition(
      id,
      'disable',
      actor,
      req.managementRequestId,
    );
  }
  @Post(':id/enable')
  @UserRoles('Admin')
  @ApiCreatedResponse({ type: AgentDto })
  @ApiBody({
    required: false,
    schema: { type: 'object', additionalProperties: false },
  })
  @ApiOperation({
    summary: 'Enable Agent',
    description:
      'Admin only. Requires unarchived compatible Server, no other active Agent; never revives revoked keys. No-store.',
  })
  enable(
    @Param('id') id: string,
    @Body() input: unknown,
    @CurrentUser() actor: UserPrincipal,
    @Req() req: AuditRequest,
  ) {
    transitionBody(input);
    return this.agents.transition(id, 'enable', actor, req.managementRequestId);
  }
  @Post(':id/retire')
  @UserRoles('Admin')
  @ApiCreatedResponse({ type: AgentDto })
  @ApiBody({
    required: false,
    schema: { type: 'object', additionalProperties: false },
  })
  @ApiOperation({
    summary: 'Retire Agent',
    description:
      'Admin only. Terminal; revoke all key rows and preserve history atomically with audit. No-store.',
  })
  retire(
    @Param('id') id: string,
    @Body() input: unknown,
    @CurrentUser() actor: UserPrincipal,
    @Req() req: AuditRequest,
  ) {
    transitionBody(input);
    return this.agents.transition(id, 'retire', actor, req.managementRequestId);
  }
}
