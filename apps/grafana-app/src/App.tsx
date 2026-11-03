import React from 'react';
import type { AppRootProps } from '@grafana/data';
import { PluginPage } from '@grafana/runtime';
import { Alert, useStyles2 } from '@grafana/ui';
import { Route, Routes, useLocation } from 'react-router-dom';
import { api, appPath } from './api/client';
import { useResource } from './hooks/useApi';
import { LoadState, PrincipalContext } from './components/Common';
import Overview from './pages/Overview';
import Servers from './pages/Servers';
import Agents from './pages/Agents';
import Install from './pages/Install';
import ApiKeys from './pages/ApiKeys';
import Profiles from './pages/Profiles';
import Monitoring from './pages/Monitoring';
import { getStyles } from './styles';

const sections = [
  ['overview', 'Overview'],
  ['servers', 'Servers'],
  ['agents', 'Agents'],
  ['install', 'Install'],
  ['api-keys', 'API keys'],
  ['profiles', 'Profiles'],
  ['monitoring', 'Monitoring'],
] as const;
export default function App(props: AppRootProps) {
  const principal = useResource('principal', api.me);
  const location = useLocation();
  const s = useStyles2(getStyles);
  return (
    <PluginPage>
      <div className={s.root}>
        <nav className={s.nav} aria-label={`${props.meta.name} sections`}>
          {sections.map(([path, label]) => (
            <a
              key={path}
              href={appPath(path)}
              aria-current={
                location.pathname === appPath(path) || (path === 'overview' && location.pathname === appPath())
                  ? 'page'
                  : undefined
              }
            >
              {label}
            </a>
          ))}
        </nav>
        <LoadState {...principal}>
          {principal.data && (
            <PrincipalContext.Provider value={principal.data}>
              <Alert severity="info" title={`Management role: ${principal.data.role}`}>
                Backend-verified /me identity is a UI hint only. Management enforces authorization for every request. No
                browser role assertion is used.
              </Alert>
              <Routes>
                <Route path="overview" element={<Overview />} />
                <Route path="servers" element={<Servers />} />
                <Route path="agents" element={<Agents />} />
                <Route path="install" element={<Install />} />
                <Route path="api-keys" element={<ApiKeys />} />
                <Route path="profiles" element={<Profiles />} />
                <Route path="monitoring" element={<Monitoring />} />
                <Route path="*" element={<Overview />} />
              </Routes>
            </PrincipalContext.Provider>
          )}
        </LoadState>
      </div>
    </PluginPage>
  );
}
