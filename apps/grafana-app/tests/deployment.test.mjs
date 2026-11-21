import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

test('ECS deployment does not ship a standalone Compose stack or env example', () => {
  for (const file of ['compose.aws.yaml', '.env.example']) {
    assert.equal(existsSync(new URL(`../../../deploy/compose/${file}`, import.meta.url)), false,
      `${file} would expose a second deployment path`);
  }
});

// Source regression for Grafana13's plugin-only environment forwarding on ECS.
// Real-process identity qualification remains a separate runtime check.
test('ECS forwards runtime environment only to the InfraPulse app', () => {
  const ecs = readFileSync(new URL('../../../infra/terraform/ecs.tf', import.meta.url), 'utf8');
  const entries = [...ecs.matchAll(/^\s+GF_PLUGINS_FORWARD_HOST_ENV_VARS\s+=\s*"([^"\r\n]*)"\s*$/gm)];
  assert.deepEqual(entries.map((entry) => entry[1]), ['infrapulse-infrapulse-app']);
  assert.match(ecs, /^\s+GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS\s+= "infrapulse-infrapulse-app,infrapulse-inventory-datasource"$/m);
});

test('Grafana image build is independent of dashboard release inputs', () => {
  const dockerfile = readFileSync(new URL('../../../deploy/docker/aws-grafana.Dockerfile', import.meta.url), 'utf8');
  assert.doesNotMatch(dockerfile, /^\s*(?:COPY|ADD)\s+[^\r\n]*(?:\bdeploy\/|observability\/grafana\/dashboards\/|cloudwatch-manifest\.json)/im);
  assert.doesNotMatch(dockerfile, /build-cloudwatch-dashboards\.mjs/);
  assert.match(dockerfile, /^COPY .*providers\.yml .*\/dashboards\/providers\.yml$/m);
});

test('current onboarding keeps bootstrap execution local and deliberate', () => {
  const install = readFileSync(new URL('../src/pages/Install.tsx', import.meta.url), 'utf8');
  assert.match(install, /Download one-time bootstrap file/);
  assert.match(install, /Run the saved file only on this intended/);
  assert.doesNotMatch(install, /install\.sh --management-url|ProvisioningPreview/);
});
