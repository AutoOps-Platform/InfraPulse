import { config } from '@grafana/runtime';

export const PLUGIN_ID = 'infrapulse-infrapulse-app';
export const appPath = (page = '') => `${config.appSubUrl}/a/${PLUGIN_ID}${page ? `/${page}` : ''}`;
export const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

export function selectedVm(search: string): string | undefined {
  const ids = new URLSearchParams(search).getAll('server');
  return ids.length === 1 && isUuid(ids[0]) ? ids[0] : undefined;
}

export function vmsHref(serverId?: string): string {
  return `${grafanaSubpath() ?? ''}/a/${PLUGIN_ID}/vms${serverId && isUuid(serverId) ? `?server=${encodeURIComponent(serverId)}` : ''}`;
}

export function legacyVmsHref(search: string): string {
  // Both old routes now open the same VM detail with onboarding inline.
  return vmsHref(selectedVm(search));
}

export function grafanaSubpath(): string | undefined {
  const subUrl = config.appSubUrl ?? '';
  if (subUrl && (!subUrl.startsWith('/') || subUrl.startsWith('//') || /[\\?#%\u0000-\u0020]/.test(subUrl) || subUrl.split('/').some(s => s === '.' || s === '..'))) return undefined;
  return subUrl.replace(/\/$/, '');
}

export function fleetHref(): string | undefined {
  const prefix = grafanaSubpath();
  return prefix === undefined ? undefined : `${prefix}/d/infrapulse-fleet`;
}

export function sslDashboardHref(): string | undefined {
  const prefix = grafanaSubpath();
  return prefix === undefined ? undefined : `${prefix}/d/infrapulse-ssl`;
}

export function vmMetricsHref(serverId: string, platform: 'linux' | 'windows' = 'linux'): string | undefined {
  const prefix = grafanaSubpath();
  if (prefix === undefined || !isUuid(serverId)) return undefined;
  const uid = platform === 'windows' ? 'infrapulse-windows-host' : 'infrapulse-linux-host';
  return `${prefix}/d/${uid}?${new URLSearchParams({ 'var-server_id': serverId })}`;
}
