import {
  Body,
  Controller,
  Get,
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
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserRoles } from '../auth/policies.js';
import { CurrentUser } from '../auth/current-user.js';
import type { UserPrincipal } from '../auth/principal.js';
import type { PageQuery } from '../common/pagination.js';
import { inventoryPageSchema } from '../common/openapi.js';
import { ProfilesService, emptyProfileQuery } from './profiles.service.js';
import {
  AssignmentDto,
  AssignmentInput,
  CreateProfileDto,
  emptyProfileBody,
  PatchProfileDto,
  ProfileDetailDto,
  ProfileDto,
  ProfileVersionDto,
  ProfileVersionInput,
} from './profiles.dto.js';
type AuditRequest = { managementRequestId: string };
@ApiTags('Profiles')
@ApiBearerAuth('AdminAssertion')
@ApiResponse({
  status: 400,
  description:
    'Invalid schema, unknown fields, Unicode, duplicate keys, unsafe number or query',
})
@ApiResponse({
  status: 409,
  description:
    'Immutable published version, OS mismatch, retired profile or archived Server',
})
@ApiResponse({
  status: 413,
  description: 'Profile write raw body/config exceeds64KiB UTF8',
})
@ApiResponse({
  status: 503,
  description: 'Dependency/audit unavailable; mutation rolled back',
})
@Controller('api/v1')
export class ProfilesController {
  constructor(
    @Inject(ProfilesService) private readonly profiles: ProfilesService,
  ) {}
  @Get('monitoring-profiles')
  @UserRoles('Viewer', 'Operator', 'Admin')
  @ApiOkResponse({ schema: inventoryPageSchema('ProfileDto') })
  @ApiOperation({
    summary: 'List profiles',
    description:
      'Viewer/Operator published-only; Admin may include drafts. Filters os/retired/status; limit20/max100. No-store.',
  })
  list(@Query() query: PageQuery, @CurrentUser() actor: UserPrincipal) {
    return this.profiles.list(query, actor);
  }
  @Post('monitoring-profiles')
  @UserRoles('Admin')
  @ApiCreatedResponse({ type: ProfileDto })
  @ApiOperation({
    summary: 'Create profile',
    description:
      'Admin only. Immutable OS, backend UUID, no startup writes. No-store.',
  })
  create(
    @Body() input: CreateProfileDto,
    @CurrentUser() actor: UserPrincipal,
    @Req() req: AuditRequest,
  ) {
    return this.profiles.create(input, actor, req.managementRequestId);
  }
  @Get('monitoring-profiles/:id')
  @UserRoles('Viewer', 'Operator', 'Admin')
  @ApiOkResponse({ type: ProfileDetailDto })
  @ApiOperation({
    summary: 'Get profile',
    description:
      'Viewer/Operator published-only versions; draft-only profile is404. Bounded100 versions; use versions pagination for further history. Retired exact pins remain usable. No-store.',
  })
  get(
    @Param('id') id: string,
    @Query() query: PageQuery,
    @CurrentUser() actor: UserPrincipal,
  ) {
    emptyProfileQuery(query);
    return this.profiles.get(id, actor);
  }
  @Patch('monitoring-profiles/:id')
  @UserRoles('Admin')
  @ApiOkResponse({ type: ProfileDto })
  @ApiOperation({
    summary: 'Edit profile metadata',
    description:
      'Admin only. Name/description only; OS is immutable. No-store.',
  })
  update(
    @Param('id') id: string,
    @Body() input: PatchProfileDto,
    @CurrentUser() actor: UserPrincipal,
    @Req() req: AuditRequest,
  ) {
    return this.profiles.update(id, input, actor, req.managementRequestId);
  }
  @Post('monitoring-profiles/:id/retire')
  @UserRoles('Admin')
  @ApiCreatedResponse({ type: ProfileDto })
  @ApiBody({
    required: false,
    schema: { type: 'object', additionalProperties: false },
  })
  @ApiOperation({
    summary: 'Retire profile',
    description:
      'Admin only. Blocks NEW assignment; existing pinned immutable config/history remains usable. Atomic audit. No-store.',
  })
  retire(
    @Param('id') id: string,
    @Body() input: unknown,
    @CurrentUser() actor: UserPrincipal,
    @Req() req: AuditRequest,
  ) {
    emptyProfileBody(input);
    return this.profiles.retire(id, actor, req.managementRequestId);
  }
  @Get('monitoring-profiles/:id/versions')
  @UserRoles('Viewer', 'Operator', 'Admin')
  @ApiOkResponse({ schema: inventoryPageSchema('ProfileVersionDto') })
  @ApiOperation({
    summary: 'List versions',
    description:
      'Viewer/Operator published-only, including guessed cursor IDs; draft filter denied. Admin may filter status. Opaque pagination limit20/max100. No-store.',
  })
  listVersions(
    @Param('id') id: string,
    @Query() query: PageQuery,
    @CurrentUser() actor: UserPrincipal,
  ) {
    return this.profiles.listVersions(id, query, actor);
  }
  @Post('monitoring-profiles/:id/versions')
  @UserRoles('Admin')
  @ApiCreatedResponse({ type: ProfileVersionDto })
  @ApiOperation({
    summary: 'Create draft version',
    description:
      'Admin only. Validated ProfileConfigV1 OS options; concurrent per-profile positive version allocation, no latest following. No-store.',
  })
  draft(
    @Param('id') id: string,
    @Body() input: ProfileVersionInput,
    @CurrentUser() actor: UserPrincipal,
    @Req() req: AuditRequest,
  ) {
    return this.profiles.createVersion(
      id,
      input,
      actor,
      req.managementRequestId,
    );
  }
  @Get('profile-versions/:id')
  @UserRoles('Viewer', 'Operator', 'Admin')
  @ApiOkResponse({ type: ProfileVersionDto })
  @ApiOperation({
    summary: 'Get exact version',
    description:
      'Viewer/Operator published-only even for guessed UUID; no query bypass. No-store.',
  })
  version(
    @Param('id') id: string,
    @Query() query: PageQuery,
    @CurrentUser() actor: UserPrincipal,
  ) {
    emptyProfileQuery(query);
    return this.profiles.getVersion(id, actor);
  }
  @Patch('profile-versions/:id')
  @UserRoles('Admin')
  @ApiOkResponse({ type: ProfileVersionDto })
  @ApiOperation({
    summary: 'Edit draft version',
    description:
      'Admin only. Published config/checksum/history is immutable. No-store.',
  })
  edit(
    @Param('id') id: string,
    @Body() input: ProfileVersionInput,
    @CurrentUser() actor: UserPrincipal,
    @Req() req: AuditRequest,
  ) {
    return this.profiles.editVersion(id, input, actor, req.managementRequestId);
  }
  @Post('profile-versions/:id/publish')
  @UserRoles('Admin')
  @ApiCreatedResponse({ type: ProfileVersionDto })
  @ApiBody({
    required: false,
    schema: { type: 'object', additionalProperties: false },
  })
  @ApiOperation({
    summary: 'Publish version',
    description:
      'Admin only. Revalidate config and RFC8785 SHA256, freeze version with DB clock and atomic audit; never alter desired assignments. No-store.',
  })
  publish(
    @Param('id') id: string,
    @Body() input: unknown,
    @CurrentUser() actor: UserPrincipal,
    @Req() req: AuditRequest,
  ) {
    emptyProfileBody(input);
    return this.profiles.publishVersion(id, actor, req.managementRequestId);
  }
  @Put('servers/:serverId/profile')
  @UserRoles('Admin')
  @ApiOkResponse({ type: AssignmentDto })
  @ApiOperation({
    summary: 'Assign exact profile version',
    description:
      'Admin only. Pin exact published/nonretired OS-compatible version with Server locks. Rollback assigns an exact old version, never latest. Atomic audit. No-store.',
  })
  assign(
    @Param('serverId') serverId: string,
    @Body() input: AssignmentInput,
    @CurrentUser() actor: UserPrincipal,
    @Req() req: AuditRequest,
  ) {
    return this.profiles.assign(
      serverId,
      input.profile_version_id,
      actor,
      req.managementRequestId,
    );
  }
  @Get('servers/:serverId/profile')
  @UserRoles('Viewer', 'Operator', 'Admin')
  @ApiOkResponse({ type: AssignmentDto })
  @ApiOperation({
    summary: 'Get exact assignment',
    description:
      'Viewer/Operator/Admin. Desired exact version, independent of applied/Online state. Retired profiles do not invalidate existing pins. No-store.',
  })
  assignment(@Param('serverId') serverId: string, @Query() query: PageQuery) {
    emptyProfileQuery(query);
    return this.profiles.getAssignment(serverId);
  }
}
