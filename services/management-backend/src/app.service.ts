import { Injectable } from '@nestjs/common';
import type { UserPrincipal } from './auth/principal.js';
@Injectable()
export class AppService {
  me(user: UserPrincipal): UserPrincipal {
    return Object.freeze({
      kind: 'user',
      issuer: user.issuer,
      subject: user.subject,
      context: user.context,
      role: user.role,
      ...(user.display === undefined ? {} : { display: user.display }),
    });
  }
}
