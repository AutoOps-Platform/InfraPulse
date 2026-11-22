import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

const sourceRoot = new URL('../src/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('plugin.json', sourceRoot), 'utf8'));
const routesUrl = new URL('api/vm-routes.ts', sourceRoot).href;
let routesPromise;
function routes() {
  if (!routesPromise) {
    const hook = registerHooks({
      resolve(specifier, context, next) {
        if (context.parentURL === routesUrl && specifier === '@grafana/runtime') {
          return next('data:text/javascript,export const config = {appSubUrl:%22/grafana%22};', context);
        }
        return next(specifier, context);
      },
    });
    routesPromise = import(routesUrl).finally(() => hook.deregister());
  }
  return routesPromise;
}
const id = '11111111-1111-4111-8111-111111111111';
const vmRoot = '/grafana/a/infrapulse-infrapulse-app/vms';

test('plugin offers one default VM menu to Viewers', () => {
  const pages = manifest.includes.filter(({ addToNav, type }) => type === 'page' && addToNav);
  assert.deepEqual(pages.map(({ name, path, defaultNav, role }) => [name, path, defaultNav, role]), [
    ['VMs', '/a/infrapulse-infrapulse-app/vms', true, 'Viewer'],
  ]);
});

test('legacy inventory and setup links route to the selected VM only', async () => {
  const { legacyVmsHref } = await routes();
  assert.equal(legacyVmsHref(`?server=${id}&binding=forged`), `${vmRoot}?server=${id}`);
  assert.equal(legacyVmsHref('?server=bad'), vmRoot);
  assert.equal(legacyVmsHref(`?server=${id}&server=${id}`), vmRoot);
  assert.equal(legacyVmsHref(''), vmRoot);
});

test('fleet and detail link destinations use the deployed subpath and never inherit binding params', async () => {
  const { fleetHref, vmMetricsHref } = await routes();
  assert.equal(fleetHref(), '/grafana/d/infrapulse-fleet');
  const detail = vmMetricsHref(id);
  assert.equal(detail, `/grafana/d/infrapulse-linux-host?var-server_id=${id}`);
  assert.equal(vmMetricsHref(id, 'windows'), `/grafana/d/infrapulse-windows-host?var-server_id=${id}`);
  assert.equal(vmMetricsHref(`//foreign/?server=${id}`), undefined);
});
