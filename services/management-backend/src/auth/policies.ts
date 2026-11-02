import { ApiError } from '../common/errors.js';
import type { CredentialScope, Principal, UserRole } from './principal.js';
const POLICY = Symbol('management.route-policy');
export type Policy = Readonly<
  | { kind: 'user'; roles: readonly UserRole[] }
  | { kind: 'service'; scope: string }
  | { kind: 'agent'; scope: CredentialScope }
  | { kind: 'public-health' }
>;
function policy(value: Policy): MethodDecorator & ClassDecorator {
  return (
    target: object,
    _key?: string | symbol,
    descriptor?: PropertyDescriptor,
  ) => {
    const owner = descriptor?.value ?? target;
    const previous: readonly Policy[] =
      Reflect.getOwnMetadata(POLICY, owner) ?? [];
    Reflect.defineMetadata(
      POLICY,
      Object.freeze([...previous, Object.freeze(value)]),
      owner,
    );
  };
}
export const UserRoles = (...roles: UserRole[]) =>
  policy({ kind: 'user', roles: Object.freeze([...roles]) });
export const ServiceScope = (scope: string) =>
  policy({ kind: 'service', scope });
export const AgentScope = (scope: CredentialScope) =>
  policy({ kind: 'agent', scope });
export const PublicHealth = () => policy({ kind: 'public-health' });
export function routePolicy(handler: object, controller: object): Policy {
  const own = [
    ...(Reflect.getOwnMetadata(POLICY, handler) ?? []),
    ...(Reflect.getOwnMetadata(POLICY, controller) ?? []),
  ] as Policy[];
  if (own.length !== 1) throw new ApiError('forbidden');
  return own[0];
}
export function authorize(policy: Policy, principal: Principal): void {
  if (policy.kind !== principal.kind)
    throw new ApiError(
      principal.kind === 'service' ? 'not_found' : 'forbidden',
    );
  if (
    policy.kind === 'user' &&
    (principal.kind !== 'user' || !policy.roles.includes(principal.role))
  )
    throw new ApiError('forbidden');
  if (
    policy.kind === 'service' &&
    (principal.kind !== 'service' || !principal.scopes.includes(policy.scope))
  )
    throw new ApiError('forbidden');
  if (
    policy.kind === 'agent' &&
    (principal.kind !== 'agent' || !principal.scopes.includes(policy.scope))
  )
    throw new ApiError('forbidden');
}
