import React from 'react';
import { AppPlugin } from '@grafana/data';

// Grafana owns the router and session. Backend configuration is operator-only,
// not editable browser jsonData/secureJsonData used as identity assertions.
export const plugin = new AppPlugin().setRootPage(React.lazy(() => import('./App')));
