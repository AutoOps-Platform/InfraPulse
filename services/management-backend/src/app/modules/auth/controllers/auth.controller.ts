import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiErrorDto, MeDto } from '../../../common/http.js';
import { CurrentUser, UserRoles, type UserPrincipal } from '../guards/auth.guard.js';

@ApiTags('Identity')
@Controller('api/v1')
export class AuthController {
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
    description: 'Fresh signed assertion per request; never persist in the browser.',
  })
  @ApiResponse({ status: 401, type: ApiErrorDto })
  @ApiResponse({ status: 403, type: ApiErrorDto })
  @ApiResponse({ status: 503, type: ApiErrorDto })
  me(@CurrentUser() user: UserPrincipal): UserPrincipal {
    return Object.freeze({
      kind: 'user' as const,
      issuer: user.issuer,
      subject: user.subject,
      context: user.context,
      role: user.role,
      ...(user.display === undefined ? {} : { display: user.display }),
    });
  }
}
