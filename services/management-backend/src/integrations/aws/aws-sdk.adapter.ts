import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  CreateActivationCommand,
  DeleteActivationCommand,
  DeregisterManagedInstanceCommand,
  DescribeActivationsCommand,
  DescribeInstanceInformationCommand,
  GetCommandInvocationCommand,
  ListCommandInvocationsCommand,
  ListCommandsCommand,
  ListTagsForResourceCommand,
  SSMClient,
  SendCommandCommand,
} from '@aws-sdk/client-ssm';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { queryAmpRange, type AmpRangePoint } from './amp-query.js';
import { remoteWriteToAmp, type AmpRemoteWriteFn } from './amp-remote-write.js';
import { parseStrictJson } from '../../app/common/pagination.js';
import {
  buildQueries,
  normalizeDimensions,
  sameDimensionNames,
} from '../../app/modules/onboarding/services/metric-verifier.service.js';
import type { AwsConfig } from '../../config/app.config.js';
import {
  emptyAgent,
  unknownCommand,
  type ActivationIntent,
  type ActivationMatch,
  type ActivationMetadata,
  type AgentCommand,
  type AgentMetadata,
  type AwsErrorCode,
  type AwsPort,
  type BootstrapArtifactInput,
  type CommandErrorCode,
  type CommandObservation,
  type CommandSummary,
  type CreateActivationResult,
  type MetricQuery,
  type MetricReadResult,
  type MetricSeries,
  type MutationResult,
  type NativeResource,
  type NodeIdentity,
  type NodeMatch,
  type PublishBootstrapArtifactResult,
  type TimeWindow,
} from './aws.port.js';
import type { AgentRelease } from './release-config.js';

export interface AwsCommand {
  readonly input: object;
  readonly constructor: { readonly name: string };
}

export interface AwsSender {
  readonly send: (command: AwsCommand, options: { abortSignal: AbortSignal }) => Promise<unknown>;
}

export interface AwsClients {
  mutation: AwsSender;
  read: AwsSender;
  metrics: AwsSender;
  s3?: AwsSender;
  presignGet?: (command: GetObjectCommand, expiresIn: number) => Promise<string>;
  ampQueryRange?: (
    promql: string,
    startSec: number,
    endSec: number,
    stepSec: number,
    signal: AbortSignal,
  ) => Promise<AmpRangePoint[]>;
}

type ContainerCredentials = ReturnType<typeof import('@aws-sdk/credential-provider-http').fromHttp>;

export function createAmpRemoteWriter(
  config: AwsConfig,
  credentials?: ContainerCredentials,
): AmpRemoteWriteFn | undefined {
  if (!config.ampEndpoint) return undefined;
  const endpoint = config.ampEndpoint;
  const s3 = new S3Client({
    region: config.region,
    ignoreConfiguredEndpointUrls: true,
    useFipsEndpoint: false,
    useDualstackEndpoint: false,
    ...(credentials === undefined ? {} : { credentials }),
  });
  return (samples, signal) =>
    remoteWriteToAmp({
      endpoint,
      region: config.region,
      credentials: () => s3.config.credentials(),
      samples,
      signal,
    });
}

export function createAwsClients(
  config: AwsConfig,
  credentials?: ContainerCredentials,
): AwsClients {
  const options = {
    region: config.region,
    ignoreConfiguredEndpointUrls: true,
    useFipsEndpoint: false,
    useDualstackEndpoint: false,
    ...(credentials === undefined ? {} : { credentials }),
  };
  const mutation = new SSMClient({ ...options, maxAttempts: 1 });
  const read = new SSMClient({ ...options, maxAttempts: 2 });
  const metrics = new CloudWatchClient({ ...options, maxAttempts: 2 });
  const s3 = new S3Client({ ...options, maxAttempts: 2 });

  return {
    mutation: {
      async send(c, o) {
        if (c instanceof CreateActivationCommand) return mutation.send(c, o);
        if (c instanceof SendCommandCommand) return mutation.send(c, o);
        if (c instanceof DeleteActivationCommand) return mutation.send(c, o);
        if (c instanceof DeregisterManagedInstanceCommand) return mutation.send(c, o);
        throw new Error('invalid_input');
      },
    },
    read: {
      async send(c, o) {
        if (c instanceof DescribeActivationsCommand) return read.send(c, o);
        if (c instanceof DescribeInstanceInformationCommand) return read.send(c, o);
        if (c instanceof ListTagsForResourceCommand) return read.send(c, o);
        if (c instanceof ListCommandsCommand) return read.send(c, o);
        if (c instanceof ListCommandInvocationsCommand) return read.send(c, o);
        if (c instanceof GetCommandInvocationCommand) return read.send(c, o);
        throw new Error('invalid_input');
      },
    },
    metrics: {
      async send(c, o) {
        if (c instanceof GetMetricDataCommand) return metrics.send(c, o);
        throw new Error('invalid_input');
      },
    },
    s3: {
      async send(c, o) {
        if (c instanceof PutObjectCommand) return s3.send(c, o);
        if (c instanceof DeleteObjectCommand) return s3.send(c, o);
        throw new Error('invalid_input');
      },
    },
    presignGet: (command, expiresIn) => getSignedUrl(s3, command, { expiresIn }),
    ...(config.ampEndpoint
      ? {
          ampQueryRange: (promql, startSec, endSec, stepSec, signal) =>
            queryAmpRange({
              endpoint: config.ampEndpoint!,
              region: config.region,
              credentials: () => s3.config.credentials(),
              promql,
              startSec,
              endSec,
              stepSec,
              signal,
            }),
        }
      : {}),
  };
}

class SafeFailure extends Error {
  constructor(readonly code: AwsErrorCode) {
    super(code);
  }
}

function fail(c: AwsErrorCode): never {
  throw new SafeFailure(c);
}

const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const nodeId = (v: unknown): v is string =>
  typeof v === 'string' && /^mi-[a-f0-9]{17}$/.test(v);
const hash = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const date = (v: unknown): v is Date => v instanceof Date && Number.isFinite(+v);
const text = (v: unknown, max = 128): v is string =>
  typeof v === 'string' && /^[\x20-\x7e]+$/.test(v) && v.length <= max;
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : fail('invalid_response');
const array = (v: unknown, max: number): unknown[] =>
  Array.isArray(v) && v.length <= max ? v : fail('invalid_response');
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function exact(v: unknown, keys: string[]): Record<string, unknown> {
  const r = record(v);
  if (Object.keys(r).length !== keys.length || keys.some((k) => !Object.hasOwn(r, k))) {
    fail('invalid_response');
  }
  return r;
}

function toErrorCode(e: unknown): AwsErrorCode {
  if (e instanceof SafeFailure) return e.code;
  const rawName = e && typeof e === 'object' ? (e as { name?: unknown }).name : null;
  const name = typeof rawName === 'string' ? rawName : '';
  return ['AccessDeniedException', 'AccessDenied', 'UnauthorizedOperation'].includes(name)
    ? 'permission_denied'
    : name === 'AbortError'
      ? 'aborted'
      : ['TimeoutError', 'RequestTimeout'].includes(name)
        ? 'timeout'
        : 'dependency_unavailable';
}

function stamp(v: unknown): string | null {
  if (date(v)) return v.toISOString();
  if (
    typeof v === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(v) &&
    Number.isFinite(Date.parse(v))
  ) {
    return new Date(v).toISOString();
  }
  return null;
}

const COMMAND_ERRORS: CommandErrorCode[] = [
  'RELEASE_MISSING',
  'DEPENDENCY_UNAVAILABLE',
  'MANUAL_ADOPTION_REQUIRED',
  'CONFLICT',
  'DECOMMISSIONED',
  'PACKAGE_MISMATCH',
  'CREDENTIAL_SOURCE_UNSAFE',
  'PRESET_FETCH_FAILED',
  'PRESET_MISMATCH',
  'RESOURCE_MISMATCH',
  'CONFIGURE_FAILED',
  'CLEANUP_FAILED',
  'SUMMARY_TOO_LARGE',
  'COMMAND_FAILED',
  'INVALID_SUMMARY',
];

const isTerminalStatus = (v: unknown): boolean =>
  typeof v === 'string' && ['Success', 'Failed', 'Cancelled', 'TimedOut'].includes(v);

export class AwsSdkAdapter implements AwsPort {
  private readonly clients: AwsClients;

  constructor(
    private readonly config: AwsConfig,
    clients: AwsClients | undefined,
    private readonly now: () => Date = () => new Date(),
    private readonly release: AgentRelease = { schemaVersion: 1, platforms: {} },
    credentials?: ContainerCredentials,
  ) {
    this.clients = clients ?? createAwsClients(config, credentials);
  }

  private async send(client: AwsSender, command: AwsCommand, signal: AbortSignal) {
    if (signal.aborted) fail('aborted');
    const r = record(await client.send(command, { abortSignal: signal }));
    if (signal.aborted) fail('aborted');
    return r;
  }

  private async scope<T>(
    signal: AbortSignal,
    ms: number,
    work: (s: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (!signal || signal.aborted) fail('aborted');
    const c = new AbortController();
    const abort = () => c.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, ms);
    try {
      return await work(c.signal);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }

  private async pages(
    signal: AbortSignal,
    command: (token?: string) => AwsCommand,
    field: string,
  ): Promise<unknown[]> {
    let token: string | undefined;
    const seen = new Set<string>();
    const values: unknown[] = [];
    for (let page = 0; page < 10; page++) {
      const r = await this.send(this.clients.read, command(token), signal);
      values.push(...array(r[field] ?? [], 100));
      if (values.length > 1000) fail('invalid_response');
      if (r.NextToken === undefined || r.NextToken === '') return values;
      if (typeof r.NextToken !== 'string' || r.NextToken.length > 2048 || seen.has(r.NextToken)) {
        fail('invalid_response');
      }
      token = r.NextToken;
      seen.add(token);
    }
    return fail('invalid_response');
  }

  private tags(i: Pick<ActivationIntent, 'serverId' | 'enrollmentId'>) {
    return [
      { Key: 'Project', Value: 'InfraPulse' },
      { Key: 'Environment', Value: this.config.deploymentId },
      { Key: 'InfraPulseDeployment', Value: this.config.deploymentId },
      { Key: 'Owner', Value: this.config.owner },
      { Key: 'ServerId', Value: i.serverId },
      { Key: 'EnrollmentId', Value: i.enrollmentId },
    ];
  }

  private owned(raw: unknown, identity?: Pick<ActivationIntent, 'serverId' | 'enrollmentId'>) {
    const ts = array(raw, 50).map(record);
    if (new Set(ts.map((t) => t.Key)).size !== ts.length) fail('invalid_response');
    const get = (k: string) => ts.find((t) => t.Key === k)?.Value;
    const serverId = get('ServerId');
    const enrollmentId = get('EnrollmentId');
    if (!uuid(serverId) || !uuid(enrollmentId)) return null;
    return this.tags(identity ?? { serverId, enrollmentId }).every((t) => get(t.Key) === t.Value)
      ? { serverId, enrollmentId }
      : null;
  }

  private assertIntent(i: ActivationIntent): void {
    if (
      !uuid(i.serverId) ||
      !uuid(i.enrollmentId) ||
      !Number.isInteger(i.generation) ||
      i.generation < 1 ||
      i.generation > 2147483647 ||
      !['linux', 'windows'].includes(i.platform) ||
      !date(i.expiresAt)
    ) {
      fail('invalid_input');
    }
  }

  private description(
    i: Pick<ActivationIntent, 'platform' | 'generation' | 'serverId' | 'enrollmentId'>,
  ): string {
    return `InfraPulse:v1:${i.platform}:${i.generation}:${i.serverId}:${i.enrollmentId}`;
  }

  private async activations(s: AbortSignal, id?: string): Promise<ActivationMetadata[]> {
    const raw = await this.pages(
      s,
      (t) =>
        new DescribeActivationsCommand({
          Filters: [
            {
              FilterKey: id ? 'ActivationIds' : 'IamRole',
              FilterValues: [id ?? this.config.roleName],
            },
          ],
          MaxResults: 50,
          NextToken: t,
        }),
      'ActivationList',
    );
    const result: ActivationMetadata[] = [];
    for (const value of raw) {
      const a = record(value);
      const owner = this.owned(a.Tags);
      if (!owner || a.IamRole !== this.config.roleName) continue;
      const m =
        typeof a.Description === 'string'
          ? /^InfraPulse:v1:(linux|windows):([1-9]\d{0,9}):([a-f0-9-]{36}):([a-f0-9-]{36})$/.exec(
              a.Description,
            )
          : null;
      if (
        !uuid(a.ActivationId) ||
        (id && a.ActivationId !== id) ||
        !m ||
        Number(m[2]) > 2147483647 ||
        m[3] !== owner.serverId ||
        m[4] !== owner.enrollmentId ||
        !date(a.ExpirationDate) ||
        a.RegistrationLimit !== 1 ||
        !Number.isInteger(a.RegistrationsCount) ||
        Number(a.RegistrationsCount) < 0 ||
        Number(a.RegistrationsCount) > 1
      ) {
        fail('invalid_response');
      }
      result.push({
        ...owner,
        id: a.ActivationId,
        generation: Number(m[2]),
        platform: m[1] as ActivationIntent['platform'],
        expiresAt: a.ExpirationDate,
        registrations: Number(a.RegistrationsCount),
      });
    }
    if (new Set(result.map((a) => a.id)).size !== result.length) fail('conflict');
    return result;
  }

  readonly createActivation = async (
    i: ActivationIntent,
    signal: AbortSignal,
  ): Promise<CreateActivationResult> => {
    let dispatched = false;
    try {
      this.assertIntent(i);
      if (+i.expiresAt <= +this.now() || +i.expiresAt > +this.now() + 3_600_000) {
        fail('invalid_input');
      }
      const r = await this.scope(signal, 2500, async (s) => {
        if (s.aborted) fail('aborted');
        dispatched = true;
        return this.send(
          this.clients.mutation,
          new CreateActivationCommand({
            Description: this.description(i),
            IamRole: this.config.roleName,
            RegistrationLimit: 1,
            ExpirationDate: i.expiresAt,
            Tags: this.tags(i),
          }),
          s,
        );
      });
      if (
        !uuid(r.ActivationId) ||
        typeof r.ActivationCode !== 'string' ||
        !/^[A-Za-z0-9+/=_-]{1,250}$/.test(r.ActivationCode)
      ) {
        fail('invalid_response');
      }
      return {
        kind: 'Known',
        id: r.ActivationId,
        code: r.ActivationCode,
        expiresAt: new Date(i.expiresAt),
      };
    } catch (e) {
      const c = toErrorCode(e);
      return {
        kind: c === 'permission_denied' ? 'Denied' : !dispatched ? 'Invalid' : 'Ambiguous',
        code: c,
      };
    }
  };

  readonly findActivations = async (
    i: ActivationIntent,
    signal: AbortSignal,
  ): Promise<ActivationMatch> => {
    try {
      this.assertIntent(i);
      const matches = (await this.scope(signal, 5000, (s) => this.activations(s))).filter(
        (a) => this.description(a) === this.description(i) && +a.expiresAt === +i.expiresAt,
      );
      return matches.length === 0
        ? { kind: 'None' }
        : matches.length === 1
          ? { kind: 'One', activation: matches[0] }
          : { kind: 'Ambiguous', code: 'conflict' };
    } catch (e) {
      return { kind: 'Ambiguous', code: toErrorCode(e) };
    }
  };

  private metadata(n: Record<string, unknown>): AgentMetadata {
    const bounded = (v: unknown, max = 128) => (text(v, max) ? v : null);
    return {
      ...emptyAgent(),
      nodeId: nodeId(n.InstanceId) ? n.InstanceId : null,
      hostname: bounded(n.ComputerName, 255),
      ipAddress: bounded(n.IPAddress, 64),
      osVersion: bounded(n.PlatformVersion),
      ssmStatus:
        typeof n.PingStatus === 'string' &&
        ['Online', 'ConnectionLost', 'Inactive'].includes(n.PingStatus)
          ? (n.PingStatus as AgentMetadata['ssmStatus'])
          : null,
      ssmAgentVersion: bounded(n.AgentVersion),
      ssmLastPingAt: stamp(n.LastPingDateTime),
      observedAt: this.now().toISOString(),
    };
  }

  private async ownedNode(
    n: Record<string, unknown>,
    a: Pick<NodeIdentity, 'activationId' | 'serverId' | 'enrollmentId' | 'platform'>,
    s: AbortSignal,
  ): Promise<string> {
    if (
      !nodeId(n.InstanceId) ||
      n.ActivationId !== a.activationId ||
      n.ResourceType !== 'ManagedInstance' ||
      n.IamRole !== this.config.roleName ||
      (a.platform === 'linux' ? n.PlatformType !== 'Linux' : n.PlatformType !== 'Windows')
    ) {
      fail('conflict');
    }
    const tags = await this.send(
      this.clients.read,
      new ListTagsForResourceCommand({
        ResourceType: 'ManagedInstance',
        ResourceId: n.InstanceId,
      }),
      s,
    );
    if (!this.owned(tags.TagList, a)) fail('conflict');
    return n.InstanceId;
  }

  readonly findNodesByActivation = async (id: string, signal: AbortSignal): Promise<NodeMatch> => {
    try {
      if (!uuid(id)) fail('invalid_input');
      return await this.scope(signal, 5000, async (s) => {
        const aa = await this.activations(s, id);
        if (aa.length !== 1) fail('conflict');
        const a = aa[0];
        const ns = await this.pages(
          s,
          (t) =>
            new DescribeInstanceInformationCommand({
              Filters: [{ Key: 'ActivationIds', Values: [id] }],
              MaxResults: 50,
              NextToken: t,
            }),
          'InstanceInformationList',
        );
        if (ns.length > 1) fail('conflict');
        if (!ns.length) return { kind: 'None' };
        const n = record(ns[0]);
        const instanceId = await this.ownedNode(n, { ...a, activationId: id }, s);
        return {
          kind: 'One',
          node: {
            nodeId: instanceId,
            activationId: id,
            serverId: a.serverId,
            enrollmentId: a.enrollmentId,
            generation: a.generation,
            platform: a.platform,
            metadata: this.metadata(n),
          },
        };
      });
    } catch (e) {
      return { kind: 'Ambiguous', code: toErrorCode(e) };
    }
  };

  readonly observeNode = async (
    b: Pick<NodeIdentity, 'nodeId' | 'activationId' | 'serverId' | 'enrollmentId' | 'platform'>,
    signal: AbortSignal,
  ): Promise<AgentMetadata | null> => {
    if (
      !nodeId(b.nodeId) ||
      !uuid(b.activationId) ||
      !uuid(b.serverId) ||
      !uuid(b.enrollmentId) ||
      !['linux', 'windows'].includes(b.platform)
    ) {
      fail('invalid_input');
    }
    return this.scope(signal, 5000, async (s) => {
      const ns = await this.pages(
        s,
        (t) =>
          new DescribeInstanceInformationCommand({
            Filters: [{ Key: 'InstanceIds', Values: [b.nodeId] }],
            MaxResults: 50,
            NextToken: t,
          }),
        'InstanceInformationList',
      );
      if (ns.length !== 1) return null;
      const n = record(ns[0]);
      if (n.InstanceId !== b.nodeId) fail('conflict');
      await this.ownedNode(n, b, s);
      return this.metadata(n);
    });
  };

  private assertCommand(c: AgentCommand, current = true) {
    const i = c.identity;
    const p = this.release.platforms[i.platform];
    if (
      !uuid(i.serverId) ||
      !uuid(i.enrollmentId) ||
      !uuid(i.operationId) ||
      i.operationId === i.enrollmentId ||
      !nodeId(i.nodeId) ||
      !hash(i.configurationVersion) ||
      (current && (!p || p.revision !== i.configurationVersion)) ||
      !['Configure', 'Cleanup'].includes(c.kind) ||
      (c.previousOperationId !== null &&
        (!uuid(c.previousOperationId) || c.previousOperationId === i.operationId)) ||
      c.document.name !==
        (c.kind === 'Configure' ? this.config.configDocument : this.config.cleanupDocument) ||
      (current &&
        c.document.version !==
          (c.kind === 'Configure' ? this.config.configVersion : this.config.cleanupVersion)) ||
      !/^[1-9]\d{0,9}$/.test(c.document.version) ||
      Number(c.document.version) > 2147483647 ||
      c.preset.name !== `/infrapulse/lab-20261118/presets/${i.platform}` ||
      !/^[1-9]\d{0,6}$/.test(c.preset.version) ||
      Number(c.preset.version) > 1_000_000 ||
      (current &&
        (!p || c.preset.name !== p.parameter.name || c.preset.version !== String(p.parameter.version)))
    ) {
      fail('invalid_input');
    }
    return p!;
  }

  private parameters(c: AgentCommand) {
    const i = c.identity;
    return {
      ServerId: [i.serverId],
      EnrollmentId: [i.enrollmentId],
      ManagedNodeId: [i.nodeId],
      OperationId: [i.operationId],
      PreviousOperationId: [c.previousOperationId ?? ''],
      Platform: [i.platform],
      ConfigurationVersion: [i.configurationVersion],
      PresetName: [c.preset.name],
      PresetVersion: [c.preset.version],
    };
  }

  private comment(c: AgentCommand): string {
    return `InfraPulse:${c.kind}:${c.identity.operationId}`;
  }

  private matches(
    raw: unknown,
    c: AgentCommand,
  ): Record<string, unknown> & { CommandId: string } {
    const r = record(raw);
    const expected = this.parameters(c);
    const actual = exact(r.Parameters, Object.keys(expected));
    if (
      !uuid(r.CommandId) ||
      r.DocumentName !== c.document.name ||
      r.DocumentVersion !== c.document.version ||
      !equal(r.InstanceIds, [c.identity.nodeId]) ||
      (r.Targets !== undefined && !equal(r.Targets, [])) ||
      r.Comment !== this.comment(c) ||
      Object.keys(expected).some((k) => !equal(actual[k], expected[k as keyof typeof expected]))
    ) {
      fail('conflict');
    }
    return r as Record<string, unknown> & { CommandId: string };
  }

  readonly sendCommand = async (
    c: AgentCommand,
    signal: AbortSignal,
  ): ReturnType<AwsPort['sendCommand']> => {
    let dispatched = false;
    try {
      this.assertCommand(c);
      return await this.scope(signal, 5000, async (s) => {
        const tags = await this.send(
          this.clients.read,
          new ListTagsForResourceCommand({
            ResourceType: 'ManagedInstance',
            ResourceId: c.identity.nodeId,
          }),
          s,
        );
        if (!this.owned(tags.TagList, c.identity)) fail('conflict');

        const rows = await this.pages(
          s,
          (t) =>
            new ListCommandsCommand({
              InstanceId: c.identity.nodeId,
              MaxResults: 50,
              NextToken: t,
            }),
          'Commands',
        );
        for (const value of rows) {
          const r = record(value);
          if (r.Comment === this.comment(c)) fail('conflict');
          if (
            typeof r.DocumentName === 'string' &&
            [this.config.configDocument, this.config.cleanupDocument].includes(r.DocumentName) &&
            !isTerminalStatus(r.Status)
          ) {
            fail('conflict');
          }
        }
        if (s.aborted) fail('aborted');
        dispatched = true;
        const r = await this.send(
          this.clients.mutation,
          new SendCommandCommand({
            DocumentName: c.document.name,
            DocumentVersion: c.document.version,
            InstanceIds: [c.identity.nodeId],
            Parameters: this.parameters(c),
            Comment: this.comment(c),
            TimeoutSeconds: 1200,
            MaxConcurrency: '1',
            MaxErrors: '0',
          }),
          s,
        );
        return { kind: 'Known', commandId: this.matches(r.Command, c).CommandId };
      });
    } catch (e) {
      return { kind: dispatched ? 'Ambiguous' : 'Error', code: toErrorCode(e) };
    }
  };

  private summary(output: unknown, c: AgentCommand): CommandSummary {
    if (typeof output !== 'string' || Buffer.byteLength(output) > 16_384) fail('invalid_response');
    const r = exact(parseStrictJson(Buffer.from(output)), [
      'serverId',
      'enrollmentId',
      'nodeId',
      'operationId',
      'platform',
      'configurationVersion',
      'step',
      'errorCode',
      'cloudWatchVersion',
      'serviceState',
      'resources',
    ]);
    for (const k of Object.keys(c.identity) as (keyof AgentCommand['identity'])[]) {
      if (r[k] !== c.identity[k]) fail('conflict');
    }
    if (
      typeof r.step !== 'string' ||
      !['prepare', 'configure', 'cleanup'].includes(r.step) ||
      (r.errorCode !== null && !COMMAND_ERRORS.includes(r.errorCode as CommandErrorCode)) ||
      (r.cloudWatchVersion !== null &&
        (typeof r.cloudWatchVersion !== 'string' ||
          !/^\d+\.\d+\.\d+(?:\.\d+|b\d+)?$/.test(r.cloudWatchVersion))) ||
      (r.serviceState !== null &&
        (typeof r.serviceState !== 'string' ||
          !['running', 'stopped', 'failed'].includes(r.serviceState)))
    ) {
      fail('invalid_response');
    }
    const resources = array(r.resources, 32).map((v) => {
      const x = exact(v, ['id', 'kind', 'dimensions']);
      const expected = this.assertCommand(c)
        .configuration.plugins.flatMap((p) => p.resources)
        .find((p) => p.id === x.id);
      if (
        !expected ||
        x.kind !== expected.kind ||
        !sameDimensionNames(x.dimensions as NativeResource['dimensions'], expected.dimensions)
      ) {
        fail('invalid_response');
      }
      return {
        id: expected.id,
        kind: expected.kind,
        dimensions: normalizeDimensions(x.dimensions as NativeResource['dimensions']),
      };
    });
    if (new Set(resources.map((res) => res.id)).size !== resources.length) fail('invalid_response');
    return {
      ...c.identity,
      step: r.step as CommandSummary['step'],
      errorCode: r.errorCode as CommandErrorCode | null,
      cloudWatchVersion: r.cloudWatchVersion as string | null,
      serviceState: r.serviceState as CommandSummary['serviceState'],
      resources,
    };
  }

  readonly readCommand = async (
    c: AgentCommand,
    id: string | null,
    signal: AbortSignal,
  ): Promise<CommandObservation> => {
    try {
      this.assertCommand(c, false);
      if (id !== null && !uuid(id)) fail('invalid_input');
      return await this.scope(signal, 5000, async (s) => {
        const tags = await this.send(
          this.clients.read,
          new ListTagsForResourceCommand({
            ResourceType: 'ManagedInstance',
            ResourceId: c.identity.nodeId,
          }),
          s,
        );
        if (!this.owned(tags.TagList, c.identity)) fail('conflict');

        const raw = await this.pages(
          s,
          (t) =>
            new ListCommandsCommand({
              ...(id
                ? { CommandId: id }
                : {
                    InstanceId: c.identity.nodeId,
                    Filters: [{ key: 'DocumentName', value: c.document.name }],
                  }),
              MaxResults: 50,
              NextToken: t,
            }),
          'Commands',
        );
        const matches = raw
          .map(record)
          .filter((r) => (id ? r.CommandId === id : r.Comment === this.comment(c)));
        if (matches.length !== 1) return unknownCommand(id);

        const r = this.matches(matches[0], c);
        const commandId = r.CommandId;
        const invocations = await this.pages(
          s,
          (t) =>
            new ListCommandInvocationsCommand({
              CommandId: commandId,
              InstanceId: c.identity.nodeId,
              Details: true,
              MaxResults: 50,
              NextToken: t,
            }),
          'CommandInvocations',
        );
        if (invocations.length !== 1) return unknownCommand(commandId);

        const inv = record(invocations[0]);
        if (
          inv.CommandId !== commandId ||
          inv.InstanceId !== c.identity.nodeId ||
          inv.DocumentName !== c.document.name ||
          inv.DocumentVersion !== c.document.version
        ) {
          fail('conflict');
        }

        const awsStatus = r.Status === inv.Status && typeof inv.Status === 'string' ? inv.Status : 'Unknown';
        const status: CommandObservation['status'] =
          awsStatus === 'Delayed'
            ? 'Pending'
            : ['Pending', 'InProgress', 'Success', 'Failed', 'Cancelled', 'TimedOut'].includes(
                  awsStatus,
                )
              ? (awsStatus as CommandObservation['status'])
              : 'Unknown';

        const result = {
          ...unknownCommand(commandId),
          status,
          requestedAt: stamp(r.RequestedDateTime),
        };
        const plugin =
          (c.kind === 'Configure' ? 'configure' : 'cleanup') +
          (c.identity.platform === 'linux' ? 'Linux' : 'Windows');
        const ps = array(inv.CommandPlugins ?? [], 8).map(record);
        const final = ps.find((p) => p.Name === plugin);
        const failed = ps.find(
          (p) => typeof p.Status === 'string' && ['Failed', 'TimedOut', 'Cancelled'].includes(p.Status),
        );
        const selected = failed ?? final;
        const selectedName = typeof selected?.Name === 'string' ? selected.Name : '';

        result.step = selected
          ? selectedName.startsWith('install')
            ? 'install'
            : selectedName.startsWith('prepare')
              ? 'prepare'
              : c.kind === 'Cleanup'
                ? 'cleanup'
                : 'configure'
          : null;
        result.startedAt = selected ? stamp(selected.ResponseStartDateTime) : null;
        result.finishedAt = selected ? stamp(selected.ResponseFinishDateTime) : null;

        if (
          result.requestedAt &&
          result.startedAt &&
          Date.parse(result.startedAt) < Date.parse(result.requestedAt) - 30_000
        ) {
          fail('invalid_response');
        }
        if (
          result.finishedAt &&
          (!result.startedAt ||
            Date.parse(result.finishedAt) < Date.parse(result.startedAt) ||
            Date.parse(result.finishedAt) > +this.now() + 30_000)
        ) {
          fail('invalid_response');
        }

        if (
          final &&
          final.Status === 'Success' &&
          status === 'Success' &&
          this.release.platforms[c.identity.platform]?.revision === c.identity.configurationVersion
        ) {
          const output = await this.send(
            this.clients.read,
            new GetCommandInvocationCommand({
              CommandId: commandId,
              InstanceId: c.identity.nodeId,
              PluginName: plugin,
            }),
            s,
          );
          if (
            output.CommandId !== commandId ||
            output.InstanceId !== c.identity.nodeId ||
            output.DocumentName !== c.document.name ||
            output.DocumentVersion !== c.document.version ||
            output.PluginName !== plugin ||
            output.Status !== 'Success' ||
            output.ResponseCode !== 0 ||
            output.StandardErrorContent !== ''
          ) {
            fail('invalid_response');
          }
          try {
            const summary = this.summary(output.StandardOutputContent, c);
            if (
              summary.step !== (c.kind === 'Configure' ? 'configure' : 'cleanup') ||
              summary.errorCode !== null ||
              (c.kind === 'Configure' &&
                summary.cloudWatchVersion !== this.assertCommand(c).alloy.version)
            ) {
              fail('invalid_response');
            }
            const startedAt = stamp(output.ExecutionStartDateTime);
            const finishedAt = stamp(output.ExecutionEndDateTime);
            if (
              (startedAt &&
                result.requestedAt &&
                Date.parse(startedAt) < Date.parse(result.requestedAt) - 30_000) ||
              (finishedAt &&
                (!startedAt ||
                  Date.parse(finishedAt) < Date.parse(startedAt) ||
                  Date.parse(finishedAt) > +this.now() + 30_000))
            ) {
              fail('invalid_response');
            }
            Object.assign(result, {
              step: summary.step,
              errorCode: summary.errorCode,
              cloudWatchVersion: summary.cloudWatchVersion,
              serviceState: summary.serviceState,
              resources: summary.resources,
              startedAt,
              finishedAt,
            });
          } catch {
            result.errorCode = 'INVALID_SUMMARY';
          }
        } else if (isTerminalStatus(status)) {
          result.errorCode = 'COMMAND_FAILED';
        }
        return result;
      });
    } catch {
      return { ...unknownCommand(id), errorCode: 'DEPENDENCY_UNAVAILABLE' };
    }
  };

  readonly deleteUnusedActivation = async (
    id: string,
    signal: AbortSignal,
  ): Promise<MutationResult> => {
    let sent = false;
    try {
      if (!uuid(id)) fail('invalid_input');
      return await this.scope(signal, 5000, async (s) => {
        const aa = await this.activations(s, id);
        if (aa.length !== 1 || aa[0].registrations !== 0) fail('conflict');
        const ns = await this.pages(
          s,
          (t) =>
            new DescribeInstanceInformationCommand({
              Filters: [{ Key: 'ActivationIds', Values: [id] }],
              MaxResults: 50,
              NextToken: t,
            }),
          'InstanceInformationList',
        );
        const latest = await this.activations(s, id);
        if (
          ns.length ||
          latest.length !== 1 ||
          latest[0].registrations !== 0 ||
          this.description(latest[0]) !== this.description(aa[0]) ||
          +latest[0].expiresAt !== +aa[0].expiresAt
        ) {
          fail('conflict');
        }
        sent = true;
        await this.send(
          this.clients.mutation,
          new DeleteActivationCommand({ ActivationId: id }),
          s,
        );
        return { kind: 'Known' };
      });
    } catch (e) {
      return { kind: sent ? 'Ambiguous' : 'Error', code: toErrorCode(e) };
    }
  };

  readonly deregisterNode = async (
    b: Pick<NodeIdentity, 'nodeId' | 'activationId' | 'serverId' | 'enrollmentId' | 'platform'>,
    signal: AbortSignal,
  ): Promise<MutationResult> => {
    let sent = false;
    try {
      if (!(await this.observeNode(b, signal))) fail('conflict');
      sent = true;
      await this.send(
        this.clients.mutation,
        new DeregisterManagedInstanceCommand({ InstanceId: b.nodeId }),
        signal,
      );
      return { kind: 'Known' };
    } catch (e) {
      return { kind: sent ? 'Ambiguous' : 'Error', code: toErrorCode(e) };
    }
  };

  readonly readMetrics = async (
    queries: MetricQuery[],
    window: TimeWindow,
    signal: AbortSignal,
  ): Promise<MetricReadResult> => {
    try {
      return await this.scope(signal, 10000, async (s) => {
        if (
          !queries.length ||
          queries.length > 100 ||
          !date(window.start) ||
          !date(window.end) ||
          +window.end <= +window.start ||
          +window.end - +window.start > 900_000 ||
          new Set(queries.map((q) => q.id)).size !== queries.length
        ) {
          fail('invalid_input');
        }

        const resolved = queries.map((q) => {
          const p = this.release.platforms[q.binding.platform];
          if (!p) return fail('invalid_input');
          const contract = {
            accountId: this.config.accountId,
            region: this.config.region,
            deploymentId: this.config.deploymentId,
            configDocument: this.config.configDocument,
            configVersion: this.config.configVersion,
            cleanupDocument: this.config.cleanupDocument,
            cleanupVersion: this.config.cleanupVersion,
            presets: [
              {
                platform: q.binding.platform,
                name: p.parameter.name,
                version: String(p.parameter.version),
                hash: p.parameter.sha256,
                configurationVersion: p.revision,
                resources: p.configuration.plugins.flatMap((pl) => pl.resources),
                metrics: p.metrics,
              },
            ],
          };
          const exactQuery = buildQueries(
            contract,
            q.binding,
            contract.presets[0].resources,
          ).find((x) => x.key === q.key);
          const spec = p.metrics.find((m) => m.key === q.key);
          const identityOk = ['ServerId', 'ManagedNodeId', 'EnrollmentId'].every((name) => {
            const expectedDim = exactQuery?.dimensions.find((d) => d.name === name);
            const actualDim = q.dimensions.find((d) => d.name === name);
            return expectedDim && actualDim && actualDim.value === expectedDim.value;
          });
          if (
            !/^[a-z][A-Za-z0-9_]{0,63}$/.test(q.id) ||
            !spec ||
            !exactQuery ||
            !identityOk ||
            !sameDimensionNames(q.dimensions, exactQuery.dimensions)
          ) {
            fail('invalid_input');
          }
          return spec;
        });

        const series: MetricSeries[] = queries.map((q) => ({
          id: q.id,
          dimensions: q.dimensions,
          points: [],
        }));

        if (this.clients.ampQueryRange) {
          const ampQuery = this.clients.ampQueryRange;
          const alignedStart = Math.floor(+window.start / 60_000) * 60_000;
          const startSec = Math.floor(alignedStart / 1000);
          const endSec = Math.floor(+window.end / 1000);
          const selector = (b: MetricQuery['binding']): string =>
            `server_id="${b.serverId}",managed_node_id="${b.nodeId}",enrollment_id="${b.enrollmentId}"`;
          const promqlFor = (metricName: string, b: MetricQuery['binding']): string => {
            const sel = selector(b);
            if (metricName === 'windows_memory_available_bytes') {
              return `count(windows_memory_available_bytes{${sel}} or windows_os_physical_memory_free_bytes{${sel}} or windows_memory_physical_free_bytes{${sel}})`;
            }
            if (metricName === 'windows_net_bytes_received_total') {
              return `count(windows_net_bytes_received_total{${sel}} or windows_net_bytes_total{${sel}})`;
            }
            return `count(${metricName}{${sel}})`;
          };
          const results = await Promise.all(
            queries.map((q, i) => ampQuery(promqlFor(resolved[i].metricName, q.binding), startSec, endSec, 60, s)),
          );
          for (let i = 0; i < results.length; i++) {
            const seenTs = new Set<number>();
            for (const pt of results[i]) {
              if (
                pt.timestampMs < alignedStart ||
                pt.timestampMs >= +window.end ||
                !Number.isFinite(pt.value) ||
                seenTs.has(pt.timestampMs)
              ) {
                continue;
              }
              seenTs.add(pt.timestampMs);
              series[i].points.push({ timestamp: new Date(pt.timestampMs).toISOString(), value: pt.value });
            }
            series[i].points.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
          }
          return { kind: 'Complete', series };
        }

        let token: string | undefined;
        const seenTokens = new Set<string>();
        const seenPoints = new Set<string>();
        const represented = new Set<string>();
        let count = 0;
        let partial = false;

        for (let page = 0; page < 10; page++) {
          const r = await this.send(
            this.clients.metrics,
            new GetMetricDataCommand({
              StartTime: window.start,
              EndTime: window.end,
              ScanBy: 'TimestampAscending',
              MaxDatapoints: 1000,
              NextToken: token,
              MetricDataQueries: queries.map((q, i) => ({
                Id: q.id,
                ReturnData: true,
                MetricStat: {
                  Metric: {
                    Namespace: resolved[i].namespace,
                    MetricName: resolved[i].metricName,
                    Dimensions: q.dimensions.map((d) => ({ Name: d.name, Value: d.value })),
                  },
                  Period: 60,
                  Stat: resolved[i].statistic,
                  Unit: resolved[i].unit,
                },
              })),
            }),
            s,
          );
          if (array(r.Messages ?? [], 100).length) partial = true;
          const rows = array(r.MetricDataResults ?? [], 1000);
          const seenIds = new Set<string>();
          count += rows.length;
          if (count > 1000) fail('invalid_response');

          for (const value of rows) {
            const x = record(value);
            if (typeof x.Id !== 'string') fail('invalid_response');
            const id = x.Id;
            const index = queries.findIndex((q) => q.id === id);
            if (index < 0 || seenIds.has(id)) fail('invalid_response');
            seenIds.add(id);
            represented.add(id);
            if (x.StatusCode !== 'Complete' || array(x.Messages ?? [], 100).length) partial = true;

            const times = array(x.Timestamps ?? [], 1000);
            const values = array(x.Values ?? [], 1000);
            if (times.length !== values.length) fail('invalid_response');
            count += times.length;
            if (count > 1000) fail('invalid_response');

            const alignedStart = Math.floor(+window.start / 60_000) * 60_000;
            for (let j = 0; j < times.length; j++) {
              const t = times[j];
              const v = values[j];
              if (
                !date(t) ||
                +t < alignedStart ||
                +t >= +window.end ||
                typeof v !== 'number' ||
                !Number.isFinite(v)
              ) {
                fail('invalid_response');
              }
              const key = `${id}:${t.toISOString()}`;
              if (seenPoints.has(key)) fail('invalid_response');
              seenPoints.add(key);
              series[index].points.push({ timestamp: t.toISOString(), value: v });
            }
          }

          if (r.NextToken === undefined || r.NextToken === '') {
            if (queries.some((q) => !represented.has(q.id))) partial = true;
            for (const x of series) {
              x.points.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
            }
            return partial
              ? { kind: 'Partial', series, code: 'dependency_unavailable' }
              : { kind: 'Complete', series };
          }
          if (
            typeof r.NextToken !== 'string' ||
            r.NextToken.length > 2048 ||
            seenTokens.has(r.NextToken)
          ) {
            fail('invalid_response');
          }
          token = r.NextToken;
          seenTokens.add(token);
        }
        return { kind: 'Partial', series, code: 'invalid_response' };
      });
    } catch (e) {
      return { kind: 'Unavailable', code: toErrorCode(e) };
    }
  };

  readonly publishBootstrapArtifact = async (
    input: BootstrapArtifactInput,
    signal: AbortSignal,
  ): Promise<PublishBootstrapArtifactResult> => {
    try {
      const bucket = this.config.bootstrapBucket;
      if (
        !bucket ||
        !this.clients.s3 ||
        !this.clients.presignGet ||
        !/^bootstrap\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.(?:sh|ps1)$/.test(input.key) ||
        !Buffer.isBuffer(input.body) ||
        input.body.length === 0 ||
        input.body.length > 262_144 ||
        !['text/x-shellscript', 'text/plain'].includes(input.contentType) ||
        !Number.isInteger(input.expiresInSeconds) ||
        input.expiresInSeconds < 60 ||
        input.expiresInSeconds > 1800
      ) {
        fail('invalid_input');
      }

      return await this.scope(signal, 8000, async (s) => {
        await this.send(
          this.clients.s3!,
          new PutObjectCommand({
            Bucket: bucket,
            Key: input.key,
            Body: input.body,
            ContentType: input.contentType,
            CacheControl: 'no-store',
            ServerSideEncryption: 'AES256',
          }),
          s,
        );
        const signedAt = this.now();
        const url = await this.clients.presignGet!(
          new GetObjectCommand({
            Bucket: bucket,
            Key: input.key,
            ResponseCacheControl: 'no-store',
          }),
          input.expiresInSeconds,
        );
        if (
          s.aborted ||
          typeof url !== 'string' ||
          url.length > 4096 ||
          /[\s'"]/.test(url) ||
          !url.startsWith(`https://${bucket}.s3.${this.config.region}.amazonaws.com/${input.key}?`)
        ) {
          fail('invalid_response');
        }
        return {
          kind: 'Known',
          url,
          expiresAt: new Date(+signedAt + input.expiresInSeconds * 1000),
        };
      });
    } catch (e) {
      const code = toErrorCode(e);
      return { kind: code === 'permission_denied' ? 'Denied' : 'Error', code };
    }
  };

  readonly deleteBootstrapArtifact = async (
    key: string,
    signal: AbortSignal,
  ): Promise<MutationResult> => {
    try {
      const bucket = this.config.bootstrapBucket;
      if (
        !bucket ||
        !this.clients.s3 ||
        !/^bootstrap\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.(?:sh|ps1)$/.test(key)
      ) {
        fail('invalid_input');
      }
      return await this.scope(signal, 5000, async (s) => {
        await this.send(
          this.clients.s3!,
          new DeleteObjectCommand({ Bucket: bucket, Key: key }),
          s,
        );
        return { kind: 'Known' };
      });
    } catch (e) {
      return { kind: 'Error', code: toErrorCode(e) };
    }
  };
}
