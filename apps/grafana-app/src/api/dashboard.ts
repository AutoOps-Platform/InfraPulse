import type { AwsServer } from './types';
import { projectBinding } from './inventory';
import { grafanaSubpath, vmMetricsHref } from './vm-routes';

export function buildRuleUrl(uid: string): string | undefined {
  const prefix = grafanaSubpath();
  if (prefix === undefined || !/^ip_[a-f0-9]{32}_[a-z0-9]{4}$/.test(uid)) return undefined;
  return `${prefix}/alerting/grafana/${encodeURIComponent(uid)}/view`;
}

// The link identifies a VM, not a binding. The dashboard re-reads the
// current authorized binding and never treats URL dimensions as proof.
export function buildDashboardUrl(server: AwsServer): string | undefined {
  return projectBinding(server) ? vmMetricsHref(server.id) : undefined;
}
