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
import { GroupsService } from './groups.service.js';
import { CreateGroupDto, PatchGroupDto, GroupDto } from './groups.dto.js';
type AuditRequest = { managementRequestId: string };
@ApiTags('Server groups')
@ApiBearerAuth('AdminAssertion')
@ApiResponse({ status: 401, description: 'Invalid assertion' })
@ApiResponse({ status: 403, description: 'Role not allowed' })
@ApiResponse({ status: 503, description: 'Dependency/audit unavailable' })
@Controller('api/v1/server-groups')
export class GroupsController {
  constructor(@Inject(GroupsService) private readonly groups: GroupsService) {}
  @Get()
  @UserRoles('Viewer', 'Operator', 'Admin')
  @ApiOkResponse({ schema: inventoryPageSchema('GroupDto') })
  @ApiOperation({
    summary: 'List groups',
    description:
      'Viewer/Operator/Admin read. Opaque cursor, limit20/max100; no filters. No-store.',
  })
  list(@Query() query: PageQuery) {
    return this.groups.list(query);
  }
  @Post()
  @UserRoles('Admin')
  @ApiCreatedResponse({ type: GroupDto })
  @ApiOperation({
    summary: 'Create group',
    description: 'Admin only. Unique lowercase slug; backend UUID. No-store.',
  })
  create(
    @Body() input: CreateGroupDto,
    @CurrentUser() actor: UserPrincipal,
    @Req() req: AuditRequest,
  ) {
    return this.groups.create(input, actor, req.managementRequestId);
  }
  @Get(':id')
  @UserRoles('Viewer', 'Operator', 'Admin')
  @ApiOkResponse({ type: GroupDto })
  @ApiOperation({
    summary: 'Get group',
    description: 'Viewer/Operator/Admin inventory read. No-store.',
  })
  get(@Param('id') id: string) {
    return this.groups.get(id);
  }
  @Patch(':id')
  @UserRoles('Admin')
  @ApiOkResponse({ type: GroupDto })
  @ApiOperation({
    summary: 'Patch group',
    description: 'Admin only. Name/slug allowlist, unique slug. No-store.',
  })
  update(
    @Param('id') id: string,
    @Body() input: PatchGroupDto,
    @CurrentUser() actor: UserPrincipal,
    @Req() req: AuditRequest,
  ) {
    return this.groups.update(id, input, actor, req.managementRequestId);
  }
  @Delete(':id')
  @HttpCode(204)
  @UserRoles('Admin')
  @ApiNoContentResponse({
    description: 'Group/memberships removed; Servers preserved. No-store.',
  })
  @ApiOperation({
    summary: 'Delete group',
    description:
      'Admin only. Removes memberships, never Servers/history. No-store.',
  })
  delete(
    @Param('id') id: string,
    @CurrentUser() actor: UserPrincipal,
    @Req() req: AuditRequest,
  ) {
    return this.groups.delete(id, actor, req.managementRequestId);
  }
}
