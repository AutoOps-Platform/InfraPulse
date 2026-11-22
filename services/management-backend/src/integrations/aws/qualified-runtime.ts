import { randomUUID } from 'node:crypto';
import { fromHttp } from '@aws-sdk/credential-provider-http';
import type { Platform } from '../../app/modules/onboarding/dto/onboarding.dto.js';
import type { PresetMatcher } from '../../app/modules/onboarding/repositories/onboarding.repository.js';
import {
  createCanonicalBootstrapAssets,
  type BootstrapAssetPins,
  type BootstrapAssetsPort,
} from '../../app/modules/onboarding/services/bootstrap.service.js';
import type { CommandFactory } from '../../app/modules/onboarding/services/onboarding-worker.service.js';
import { validateAwsConfig, type AwsConfig } from '../../config/app.config.js';
import type { AwsContractBinding, AwsPort, MetricSpec } from './aws.port.js';
import { AwsSdkAdapter } from './aws-sdk.adapter.js';
import { loadAgentRelease, type AgentRelease } from './release-config.js';

export interface MetricPresentation {
  title: string;
  invert: boolean;
  unit: string;
  plugin: string;
  input: string;
}

export interface QualifiedMetricContract {
  readonly config: AwsConfig;
  readonly manifest: AwsContractBinding;
  readonly release: AgentRelease;
  readonly presetVersionIds: Readonly<Partial<Record<Platform, string>>>;
  readonly orgId: number;
  readonly describeMetric: (platform: Platform, metric: MetricSpec) => MetricPresentation;
}

export interface QualifiedRuntime extends QualifiedMetricContract {
  readonly assets: BootstrapAssetsPort;
  readonly aws: AwsPort;
  readonly command: CommandFactory;
  readonly presetMatches: PresetMatcher;
  readonly accountClaim: 'CallerConfigNoAccountAttestationClaim';
}

const ECS_CREDENTIAL_PATH =
  /^\/v2\/credentials\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?![\s\S])/;
const BLOCKED_CREDENTIAL_ENV = [
  'AWS_PROFILE',
  'AWS_DEFAULT_PROFILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_ROLE_ARN',
];

export async function createQualifiedRuntime(env: NodeJS.ProcessEnv): Promise<QualifiedRuntime> {
  try {
    const snapshot = { ...env };
    if (BLOCKED_CREDENTIAL_ENV.some((key) => snapshot[key] !== undefined)) throw new Error();
    const source = snapshot.INFRAPULSE_AWS_CREDENTIAL_SOURCE;
    const relativeUri = snapshot.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
    if (
      source === undefined
        ? relativeUri !== undefined
        : source !== 'ecs-task' || !relativeUri || !ECS_CREDENTIAL_PATH.test(relativeUri)
    ) {
      throw new Error();
    }

    const config = validateAwsConfig(snapshot);
    const orgId = Number(snapshot.INFRAPULSE_GRAFANA_ORG_ID);
    const credentials =
      relativeUri === undefined
        ? undefined
        : fromHttp({
            awsContainerCredentialsRelativeUri: relativeUri,
            awsContainerCredentialsFullUri: '',
            awsContainerAuthorizationToken: '',
            awsContainerAuthorizationTokenFile: '',
          });
    if (!/^[1-9]\d{0,9}$/.test(snapshot.INFRAPULSE_GRAFANA_ORG_ID ?? '') || !Number.isSafeInteger(orgId)) {
      throw new Error();
    }

    const release = await loadAgentRelease();
    const pins: BootstrapAssetPins = { platforms: {} };
    const presetVersionIds: Partial<Record<Platform, string>> = {};
    const manifest: AwsContractBinding = {
      accountId: config.accountId,
      region: config.region,
      deploymentId: config.deploymentId,
      configDocument: config.configDocument,
      configVersion: config.configVersion,
      cleanupDocument: config.cleanupDocument,
      cleanupVersion: config.cleanupVersion,
      presets: [],
    };

    for (const platform of ['linux', 'windows'] as const) {
      const p = release.platforms[platform];
      const key =
        platform === 'linux'
          ? 'INFRAPULSE_LINUX_PRESET_VERSION_ID'
          : 'INFRAPULSE_WINDOWS_PRESET_VERSION_ID';
      const id = snapshot[key];
      if (id !== undefined && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) {
        throw new Error();
      }
      if (!p) continue;
      manifest.presets.push({
        platform,
        name: p.parameter.name,
        version: String(p.parameter.version),
        hash: p.parameter.sha256,
        configurationVersion: p.revision,
        resources: p.configuration.plugins.flatMap((plugin) =>
          plugin.resources.map(({ id: resId, kind, dimensions }) => ({
            id: resId,
            kind,
            dimensions,
          })),
        ),
        metrics: p.metrics,
      });
      if (id && config.configVersion && config.cleanupVersion) {
        pins.platforms[platform] = {
          presetVersionId: id,
          configurationVersion: p.revision,
          presetHash: p.parameter.sha256,
        };
        presetVersionIds[platform] = id;
      }
    }

    const assets = await createCanonicalBootstrapAssets(pins);
    const decoder = Object.keys(release.platforms).length
      ? ((await import(
          new URL('../../../release/agent-release.mjs', import.meta.url).href
        )) as typeof import('../../../../../deploy/scripts/agent-release.mjs'))
      : null;

    const presetMatches: PresetMatcher = (platform, id, revision, checksum, value) => {
      const p = release.platforms[platform];
      return (
        !!p &&
        !!decoder &&
        presetVersionIds[platform] === id &&
        p.revision === revision &&
        p.parameter.sha256 === checksum &&
        decoder.canonicalJson(value) === decoder.canonicalJson(decoder.cloudWatchPreset(platform, p))
      );
    };

    const command: CommandFactory = (a, kind) => {
      const p = release.platforms[a.platform];
      const version = kind === 'Configure' ? config.configVersion : config.cleanupVersion;
      if (!p || !version || !a.binding || a.configurationVersion !== p.revision) return null;
      return {
        identity: {
          serverId: a.serverId,
          nodeId: a.binding.nodeId,
          enrollmentId: a.enrollmentId,
          operationId: randomUUID(),
          platform: a.platform,
          configurationVersion: p.revision,
        },
        kind,
        document: {
          name: kind === 'Configure' ? config.configDocument : config.cleanupDocument,
          version,
        },
        preset: { name: p.parameter.name, version: String(p.parameter.version) },
        previousOperationId: a.previousCommand?.command.identity.operationId ?? null,
      };
    };

    return Object.freeze({
      config,
      release,
      manifest,
      assets,
      command,
      presetMatches,
      orgId,
      presetVersionIds: Object.freeze(presetVersionIds),
      describeMetric: (platform: Platform, metric: MetricSpec): MetricPresentation => {
        const p = release.platforms[platform];
        const spec = p?.metrics.find((m) => m.key === metric.key);
        const plugin = p?.configuration.plugins.find((pl) =>
          pl.measurements.some((m) => m.metricKeys.includes(metric.key)),
        );
        const measurement = plugin?.measurements.find((m) => m.metricKeys.includes(metric.key));
        if (!spec || JSON.stringify(spec) !== JSON.stringify(metric) || !plugin || !measurement) {
          throw new Error('Metric unavailable.');
        }
        return {
          title: metric.key,
          invert: ['usage_idle', '% Free Space'].includes(measurement.input),
          unit: metric.unit,
          plugin: plugin.plugin,
          input: measurement.input,
        };
      },
      aws: new AwsSdkAdapter(config, undefined, undefined, release, credentials),
      accountClaim: 'CallerConfigNoAccountAttestationClaim' as const,
    });
  } catch {
    throw new Error('Agent runtime unavailable.');
  }
}
