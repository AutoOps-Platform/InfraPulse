import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { ApiError } from '../common/errors.js';
import type { UserPrincipal } from './principal.js';
import type { AuthenticatedRequest } from './auth.guard.js';
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): UserPrincipal => {
    const principal = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest>().principal;
    if (!principal || principal.kind !== 'user')
      throw new ApiError('forbidden');
    return principal;
  },
);
