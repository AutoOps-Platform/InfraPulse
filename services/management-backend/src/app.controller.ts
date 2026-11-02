import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOkResponse,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AppService } from './app.service.js';
import { UserRoles } from './auth/policies.js';
import { CurrentUser } from './auth/current-user.js';
import type { UserPrincipal } from './auth/principal.js';
import { ApiErrorDto, MeDto } from './common/openapi.js';

@ApiTags('Identity')
@Controller('api/v1')
export class AppController {
  constructor(private readonly appService: AppService) {}
  @Get('me')
  @UserRoles('Viewer', 'Operator', 'Admin')
  @ApiBearerAuth('AdminAssertion')
  @ApiOkResponse({
    type: MeDto,
    description: 'Verified immutable user snapshot. Cache-Control: no-store.',
  })
  @ApiHeader({
    name: 'Authorization',
    required: true,
    description:
      'Fresh signed assertion per request; never persist in the browser.',
  })
  @ApiResponse({ status: 401, type: ApiErrorDto })
  @ApiResponse({ status: 403, type: ApiErrorDto })
  @ApiResponse({ status: 503, type: ApiErrorDto })
  me(@CurrentUser() user: UserPrincipal): UserPrincipal {
    return this.appService.me(user);
  }
}
