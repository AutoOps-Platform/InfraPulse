import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Regression for the observed Grafana13.3 live failure: without this setting,
// parent INFRAPULSE_* variables never reach the backend plugin process. This
// source guard supplements, but does not replace, the real-process E2E check.
test('Grafana13 forwards runtime environment only to the enrolled InfraPulse plugin', () => {
  const overlay = readFileSync(new URL('../../../deploy/compose/compose.grafana-app.yaml', import.meta.url), 'utf8');
  const entries = [...overlay.matchAll(/^\s+GF_PLUGINS_FORWARD_HOST_ENV_VARS:\s*([^\r\n]+)$/gm)];
  assert.equal(entries.length, 1, 'runtime environment forwarding must be explicit');
  assert.equal(entries[0][1].trim(), 'infrapulse-infrapulse-app', 'no wildcard or unrelated plugin may receive host config');
});

// Reviewed bundles can intentionally keep installer scripts non-executable
// (the Linux lab distribution is mode0600). Match the existing bash entrypoint.
test('Linux onboarding invokes its reviewed script through bash', () => {
  const source = readFileSync(new URL('../src/components/ProvisioningPreview.tsx', import.meta.url), 'utf8');
  assert.ok(source.includes('? `sudo bash ./install.sh --management-url'), 'non-executable bundles need the bash entrypoint');
});
