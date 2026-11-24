import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
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
import { CurrentUser, UserRoles, type UserPrincipal } from '../../auth/guards/auth.guard.js';
import { CreateSslTargetDto, PatchSslTargetDto, SslTargetDto } from '../dto/ssl-targets.dto.js';
import { SslTargetsService } from '../services/ssl-targets.service.js';

type AuditRequest = { managementRequestId: string };

@ApiTags('SSL Targets')
@ApiBearerAuth('AdminAssertion')
@ApiResponse({ status: 401, description: 'Invalid assertion' })
@ApiResponse({ status: 403, description: 'Role not allowed' })
@ApiResponse({ status: 503, description: 'Dependency/audit unavailable' })
@Controller('api/v1/ssl-targets')
export class SslTargetsController {
  constructor(private readonly service: SslTargetsService) {}

  @Get()
  @UserRoles('Viewer', 'Operator', 'Admin')
  @ApiOkResponse({ description: 'Configured external HTTPS SSL targets.' })
  @ApiOperation({ summary: 'List SSL targets' })
  list() {
    return this.service.list();
  }

  @Post()
  @UserRoles('Admin')
  @ApiCreatedResponse({ type: SslTargetDto })
  @ApiOperation({ summary: 'Create and immediately probe an SSL target' })
  create(
    @Body() input: CreateSslTargetDto,
    @CurrentUser() actor: UserPrincipal,
    @Req() req: AuditRequest,
  ) {
    return this.service.create(input, actor, req.managementRequestId);
  }

  @Get(':id')
  @UserRoles('Viewer', 'Operator', 'Admin')
  @ApiOkResponse({ type: SslTargetDto })
  @ApiOperation({ summary: 'Get SSL target' })
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Patch(':id')
  @UserRoles('Admin')
  @ApiOkResponse({ type: SslTargetDto })
  @ApiOperation({ summary: 'Update SSL target' })
  update(
    @Param('id') id: string,
    @Body() input: PatchSslTargetDto,
    @CurrentUser() actor: UserPrincipal,
    @Req() req: AuditRequest,
  ) {
    return this.service.update(id, input, actor, req.managementRequestId);
  }

  @Post(':id/probe')
  @HttpCode(200)
  @UserRoles('Operator', 'Admin')
  @ApiOkResponse({ type: SslTargetDto })
  @ApiOperation({ summary: 'Probe SSL target immediately' })
  probe(@Param('id') id: string) {
    return this.service.probeOne(id);
  }

  @Delete(':id')
  @HttpCode(204)
  @UserRoles('Admin')
  @ApiNoContentResponse({ description: 'SSL target deleted.' })
  @ApiOperation({ summary: 'Delete SSL target' })
  remove(
    @Param('id') id: string,
    @CurrentUser() actor: UserPrincipal,
    @Req() req: AuditRequest,
  ) {
    return this.service.remove(id, actor, req.managementRequestId);
  }
}
