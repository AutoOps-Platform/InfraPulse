export type UserRole = 'Viewer' | 'Operator' | 'Admin';
export type UserPrincipal = Readonly<{
  kind: 'user';
  issuer: string;
  subject: string;
  context: string;
  role: UserRole;
  display?: string;
}>;
export type ServicePrincipal = Readonly<{
  kind: 'service';
  issuer: string;
  subject: string;
  scopes: readonly string[];
}>;
export type CredentialScope =
  'metrics:write' | 'provisioning:read' | 'config:report';
export type AgentPrincipal = Readonly<{
  kind: 'agent';
  credential_id: string;
  server_id: string;
  agent_id: string;
  scopes: readonly CredentialScope[];
}>;
export type Principal = UserPrincipal | ServicePrincipal | AgentPrincipal;
export interface AgentAuthenticatorPort {
  authenticate(apiKey: string, scope: CredentialScope): Promise<AgentPrincipal>;
}
export const AGENT_AUTHENTICATOR = Symbol('AGENT_AUTHENTICATOR');
