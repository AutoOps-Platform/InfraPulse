import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import { ApiError } from '../../../common/errors.js';
import { inventoryPageSchema } from '../../../common/http.js';
import type { PageQuery } from '../../../common/pagination.js';
import { CurrentUser, UserRoles, type UserPrincipal } from '../../auth/guards/auth.guard.js';
import { GroupsService } from '../../groups/services/groups.service.js';
import { CreateServerDto, PatchServerDto, ServerDto } from '../dto/servers.dto.js';
import { ServersService } from '../services/servers.service.js';

type AuditRequest = { managementRequestId: string };

@ApiTags('Servers')
@ApiBearerAuth('AdminAssertion')
@ApiResponse({ status: 401, description: 'Invalid assertion' })
@ApiResponse({ status: 403, description: 'Role not allowed' })
@ApiResponse({ status: 503, description: 'Dependency/audit unavailable' })
@Controller('api/v1/servers')
export class ServersController {
  constructor(
    private readonly serversService: ServersService,
    private readonly groupsService: GroupsService,
  ) {}

  @Get()
  @UserRoles('Viewer', 'Operator', 'Admin')
  @ApiOkResponse({ schema: inventoryPageSchema('ServerDto') })
  @ApiOperation({ summary: 'List servers' })
  list(@Query() query: PageQuery) {
    return this.serversService.list(query);
  }

  @Post()
  @UserRoles('Admin')
  @ApiCreatedResponse({ type: ServerDto })
  @ApiOperation({ summary: 'Create server' })
  create(
    @Body() input: CreateServerDto,
    @CurrentUser() actor: UserPrincipal,
    @Req() req: AuditRequest,
  ) {
    return this.serversService.create(input, actor, req.managementRequestId);
  }

  @Get(':id')
  @UserRoles('Viewer', 'Operator', 'Admin')
  @ApiOkResponse({ type: ServerDto })
  @ApiOperation({ summary: 'Get server' })
  get(@Param('id') id: string) {
    return this.serversService.get(id);
  }

  @Patch(':id')
  @UserRoles('Admin')
  @ApiOkResponse({ type: ServerDto })
  @ApiOperation({ summary: 'Patch server' })
  update(
    @Param('id') id: string,
    @Body() input: PatchServerDto,
    @CurrentUser() actor: UserPrincipal,
    @Req() req: AuditRequest,
  ) {
    return this.serversService.update(id, input, actor, req.managementRequestId);
  }

  @Delete(':id')
  @HttpCode(204)
  @UserRoles('Admin')
  @ApiNoContentResponse({ description: 'Atomic mutation committed; no-store.' })
  @ApiOperation({ summary: 'Archive or permanently delete server' })
  archive(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
    @CurrentUser() actor: UserPrincipal,
    @Req() req: AuditRequest,
  ) {
    const keys = Object.keys(query);
    if (keys.some((key) => key !== 'force')) {
      throw new ApiError('invalid_request');
    }
    const force = query.force;
    if (force !== undefined && force !== 'true' && force !== 'false') {
      throw new ApiError('invalid_request');
    }
    if (force === 'true') {
      return this.serversService.remove(id, actor, req.managementRequestId);
    }
    return this.serversService.archive(id, actor, req.managementRequestId);
  }

  @Put(':id/groups/:groupId')
  @HttpCode(204)
  @UserRoles('Admin')
  @ApiNoContentResponse({ description: 'Atomic mutation committed; no-store.' })
  @ApiOperation({ summary: 'Add membership' })
  addMembership(
    @Param('id') id: string,
    @Param('groupId') groupId: string,
    @CurrentUser() actor: UserPrincipal,
    @Req() req: AuditRequest,
  ) {
    return this.groupsService.membership(groupId, id, true, actor, req.managementRequestId);
  }

  @Delete(':id/groups/:groupId')
  @HttpCode(204)
  @UserRoles('Admin')
  @ApiNoContentResponse({ description: 'Atomic mutation committed; no-store.' })
  @ApiOperation({ summary: 'Remove membership' })
  removeMembership(
    @Param('id') id: string,
    @Param('groupId') groupId: string,
    @CurrentUser() actor: UserPrincipal,
    @Req() req: AuditRequest,
  ) {
    return this.groupsService.membership(groupId, id, false, actor, req.managementRequestId);
  }
}
