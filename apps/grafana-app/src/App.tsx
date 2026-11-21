import React from 'react';
import { PluginPage } from '@grafana/runtime';
import { useStyles2 } from '@grafana/ui';
import { Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api/client';
import { buildDashboardUrl } from './api/dashboard';
import { fleetHref, legacyVmsHref, selectedVm, vmsHref } from './api/vm-routes';
import { useResource } from './hooks/useApi';
import { LoadState, PrincipalContext } from './components/Common';
import Servers from './pages/Servers';
import { getStyles } from './styles';

function LegacyVms() {
  return <ExternalDestination href={legacyVmsHref(useLocation().search)} />;
}

function LegacyMonitoring() {
  const id = selectedVm(useLocation().search);
  const current = useResource(`legacy-monitoring:${id ?? ''}`, (signal) => api.inventoryServer(id!, signal), Boolean(id));
  if (!current.loading) {
    const dashboard = current.data && buildDashboardUrl(current.data);
    if (dashboard) return <ExternalDestination href={dashboard} />;
    return <ExternalDestination href={vmsHref(id)} />;
  }
  return <LoadState {...current} />;
}

function ExternalDestination({ href }: { href: string }) {
  React.useEffect(() => { window.location.replace(href); }, [href]);
  return <a href={href}>Continue to dashboard</a>;
}

export default function App() {
  const principal = useResource('principal', api.me);
  const s = useStyles2(getStyles);
  const fleet = fleetHref();
  return <PluginPage><div className={s.root}>
    <LoadState {...principal}>
      {principal.data && <PrincipalContext.Provider value={principal.data}>
        <Routes>
          <Route path="vms" element={<Servers />} />
          <Route path="servers" element={<LegacyVms />} />
          <Route path="install" element={<LegacyVms />} />
          <Route path="overview" element={fleet ? <ExternalDestination href={fleet} /> : <ExternalDestination href={vmsHref()} />} />
          <Route path="monitoring" element={<LegacyMonitoring />} />
          <Route path="*" element={<ExternalDestination href={vmsHref()} />} />
        </Routes>
      </PrincipalContext.Provider>}
    </LoadState>
  </div></PluginPage>;
}
