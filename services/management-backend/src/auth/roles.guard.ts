import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ApiError } from '../common/errors.js';
import type { AuthenticatedRequest } from './auth.guard.js';
import { authorize, routePolicy } from './policies.js';
@Injectable()
export class RolesGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const policy = routePolicy(context.getHandler(), context.getClass());
    if (policy.kind === 'public-health') return true;
    const principal = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest>().principal;
    if (!principal) throw new ApiError('unauthorized');
    authorize(policy, principal);
    return true;
  }
}
