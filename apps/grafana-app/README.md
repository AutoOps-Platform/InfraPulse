# InfraPulse Grafana App

React/TypeScript app plugin plus Go resource adapter. This is Grafana-native UI, not a separate Admin Web or a custom datasource.

## Current capabilities

- **Overview:** bounded current AWS inventory scan, onboarding stage, independent metrics health and alert-sync status.
- **Servers:** literal name-prefix search, filters/cursor pagination, create/update/detail/archive with Management enforcing current AWS ownership and retirement guards.
- **AWS onboarding:** select authoritative Server inventory, deliberately download one-time registration bootstrap, inspect persisted progress and request eligible recovery/decommission.
- **AWS Monitoring:** open the OS CloudWatch dashboard using the protected current binding/resource projection, never a browser-inferred node identity or old Agent ID.

The unmounted Agents/API Keys/Profiles editors, credential/provisioning modal chain, legacy client types/API methods and Telegraf installer instructions have been deleted. Retired URL notices remain; old backend endpoints are not re-enabled.

## Deployment and identity

Use the [current deployment guide](<../../docs/deployment/grafana-app.md>), [AWS runbook](<../../docs/deployment/aws-lab.md>) and [current API contract](<../../docs/contracts/grafana-management-api.md>). The custom Grafana image owns plugin/backend/CloudWatch provisioning. Do not use the removed old dist-mount Compose overlay.

Browser requests are same-origin. The Go adapter verifies the actual enrolled Grafana `X-Grafana-Id` identity and current PluginContext, then signs exact method/target/body assertions with a fresh nonce. NestJS remains the authentication, RBAC, validation and business authority. Viewer/Editor map to read-only Viewer/Operator; Admin mutations require actual verified Management Admin. No browser role, username or Admin fallback.

Grafana 13.3 identity remains experimental upstream and requires deliberate acknowledgement/enrollment. Identity/Management TLS trust, bounded fixed-origin JWKS and private assertion-key custody remain unchanged. No Agent-key transport or Gateway origin is part of the current flow.

## Local source commands

```sh
pnpm typecheck
pnpm build
pnpm build:backend
```

Use the existing pinned Node/pnpm/Go toolchain. Generated frontend assets and the Linux Go binary are packaged by the current two-image build flow. Type checking/building is not browser, deployed-identity, AWS or native qualification. Historical [Linux/UI lab evidence](<../../docs/testing/grafana-app-vm1-20261103.md>) remains historical only.
