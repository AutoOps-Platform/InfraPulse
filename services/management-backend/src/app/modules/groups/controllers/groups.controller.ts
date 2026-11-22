import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import { inventoryPageSchema } from '../../../common/http.js';
import type { PageQuery } from '../../../common/pagination.js';
import { CurrentUser, UserRoles, type UserPrincipal } from '../../auth/guards/auth.guard.js';
import { CreateGroupDto, GroupDto, PatchGroupDto } from '../dto/groups.dto.js';
import { GroupsService } from '../services/groups.service.js';

type AuditRequest = { managementRequestId: string };

@ApiTags('Server groups')
@ApiBearerAuth('AdminAssertion')
@ApiResponse({ status: 401, description: 'Invalid assertion' })
@ApiResponse({ status: 403, description: 'Role not allowed' })
@ApiResponse({ status: 503, description: 'Dependency/audit unavailable' })
@Controller('api/v1/server-groups')
export class GroupsController {
  constructor(private readonly groupsService: GroupsService) {}

  @Get()
  @UserRoles('Viewer', 'Operator', 'Admin')
  @ApiOkResponse({ schema: inventoryPageSchema('GroupDto') })
  @ApiOperation({ summary: 'List groups' })
  list(@Query() query: PageQuery) {
    return this.groupsService.list(query);
  }

  @Post()
  @UserRoles('Admin')
  @ApiCreatedResponse({ type: GroupDto })
  @ApiOperation({ summary: 'Create group' })
  create(
    @Body() input: CreateGroupDto,
    @CurrentUser() actor: UserPrincipal,
    @Req() req: AuditRequest,
  ) {
    return this.groupsService.create(input, actor, req.managementRequestId);
  }

  @Get(':id')
  @UserRoles('Viewer', 'Operator', 'Admin')
  @ApiOkResponse({ type: GroupDto })
  @ApiOperation({ summary: 'Get group' })
  get(@Param('id') id: string) {
    return this.groupsService.get(id);
  }

  @Patch(':id')
  @UserRoles('Admin')
  @ApiOkResponse({ type: GroupDto })
  @ApiOperation({ summary: 'Patch group' })
  update(
    @Param('id') id: string,
    @Body() input: PatchGroupDto,
    @CurrentUser() actor: UserPrincipal,
    @Req() req: AuditRequest,
  ) {
    return this.groupsService.update(id, input, actor, req.managementRequestId);
  }

  @Delete(':id')
  @HttpCode(204)
  @UserRoles('Admin')
  @ApiNoContentResponse({ description: 'Group/memberships removed; Servers preserved.' })
  @ApiOperation({ summary: 'Delete group' })
  delete(@Param('id') id: string, @CurrentUser() actor: UserPrincipal, @Req() req: AuditRequest) {
    return this.groupsService.delete(id, actor, req.managementRequestId);
  }
}
