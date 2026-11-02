import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
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
import { ServersService } from './servers.service.js';
import { GroupsService } from '../groups/groups.service.js';
import { AgentsService } from '../agents/agents.service.js';
import { CreateServerDto, PatchServerDto, ServerDto } from './servers.dto.js';
import { RegisterAgentDto, AgentDto } from '../agents/agents.dto.js';

type AuditRequest = { managementRequestId: string };
@ApiTags('Servers')
@ApiBearerAuth('AdminAssertion')
@ApiResponse({ status: 401, description: 'Invalid assertion' })
@ApiResponse({ status: 403, description: 'Role not allowed' })
@ApiResponse({ status: 503, description: 'Dependency/audit unavailable' })
@Controller('api/v1/servers')
export class ServersController {
  constructor(
    @Inject(ServersService) private readonly servers: ServersService,
    @Inject(GroupsService) private readonly groups: GroupsService,
    @Inject(AgentsService) private readonly agents: AgentsService,
  ) {}
  @Get()
  @UserRoles('Viewer', 'Operator', 'Admin')
  @ApiOkResponse({ schema: inventoryPageSchema('ServerDto') })
  @ApiOperation({
    summary: 'List servers',
    description:
      'Viewer/Operator/Admin read-only. Opaque cursor, limit20/max100; filters os/environment/group/archive/name prefix. No-store.',
  })
  list(@Query() query: PageQuery) {
    return this.servers.list(query);
  }
  @Post()
  @UserRoles('Admin')
  @ApiCreatedResponse({ type: ServerDto })
  @ApiOperation({
    summary: 'Create server',
    description:
      'Admin only. Bounded non-secret metadata, UUID assigned by backend. No-store.',
  })
  create(
    @Body() input: CreateServerDto,
    @CurrentUser() actor: UserPrincipal,
    @Req() req: AuditRequest,
  ) {
    return this.servers.create(input, actor, req.managementRequestId);
  }
  @Get(':id')
  @UserRoles('Viewer', 'Operator', 'Admin')
  @ApiOkResponse({ type: ServerDto })
  @ApiOperation({
    summary: 'Get server',
    description:
      'Viewer/Operator/Admin inventory read includes nested conservative telemetry with status_as_of; Unknown when evidence is insufficient. No-store.',
  })
  get(@Param('id') id: string) {
    return this.servers.get(id);
  }
  @Patch(':id')
  @UserRoles('Admin')
  @ApiOkResponse({ type: ServerDto })
  @ApiOperation({
    summary: 'Patch server',
    description:
      'Admin only. Explicit name/OS/environment/metadata fields; OS change requires no active Agent or incompatible assignment. No-store.',
  })
  update(
    @Param('id') id: string,
    @Body() input: PatchServerDto,
    @CurrentUser() actor: UserPrincipal,
    @Req() req: AuditRequest,
  ) {
    return this.servers.update(id, input, actor, req.managementRequestId);
  }
  @Delete(':id')
  @HttpCode(204)
  @UserRoles('Admin')
  @ApiNoContentResponse({ description: 'Atomic mutation committed; no-store.' })
  @ApiOperation({
    summary: 'Archive server',
    description:
      'Admin only. Atomic disable/revoke/audit; retain Agent/key/history references; no restore. No-store.',
  })
  archive(
    @Param('id') id: string,
    @CurrentUser() actor: UserPrincipal,
    @Req() req: AuditRequest,
  ) {
    return this.servers.archive(id, actor, req.managementRequestId);
  }
  @Put(':id/groups/:groupId')
  @HttpCode(204)
  @UserRoles('Admin')
  @ApiNoContentResponse({ description: 'Atomic mutation committed; no-store.' })
  @ApiOperation({
    summary: 'Add membership',
    description:
      'Admin only. Idempotent membership; never deletes a Server. No-store.',
  })
  addMembership(
    @Param('id') id: string,
    @Param('groupId') groupId: string,
    @CurrentUser() actor: UserPrincipal,
    @Req() req: AuditRequest,
  ) {
    return this.groups.membership(
      groupId,
      id,
      true,
      actor,
      req.managementRequestId,
    );
  }
  @Delete(':id/groups/:groupId')
  @HttpCode(204)
  @UserRoles('Admin')
  @ApiNoContentResponse({ description: 'Atomic mutation committed; no-store.' })
  @ApiOperation({
    summary: 'Remove membership',
    description:
      'Admin only. Idempotent removal preserving Server history. No-store.',
  })
  removeMembership(
    @Param('id') id: string,
    @Param('groupId') groupId: string,
    @CurrentUser() actor: UserPrincipal,
    @Req() req: AuditRequest,
  ) {
    return this.groups.membership(
      groupId,
      id,
      false,
      actor,
      req.managementRequestId,
    );
  }
  @Post(':id/agents')
  @UserRoles('Admin')
  @ApiCreatedResponse({ type: AgentDto })
  @ApiOperation({
    summary: 'Register active Agent',
    description:
      'Admin only. OS inferred from unarchived Server; one active Agent or409. No credentials issued. No-store.',
  })
  register(
    @Param('id') id: string,
    @Body() input: RegisterAgentDto,
    @CurrentUser() actor: UserPrincipal,
    @Req() req: AuditRequest,
  ) {
    return this.agents.register(id, input, actor, req.managementRequestId);
  }
}
