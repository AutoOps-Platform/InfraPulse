import { createHash, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { closeSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { connect } from 'node:net';
import { SignJWT } from 'jose';
import pg from 'pg';
import { startDatabase, guardDatabase, readTestUrl, type TestDatabase } from './pg-harness.js';
import { Evidence, scanEvidence, useEvidence } from './evidence.js';

const root = resolve(import.meta.dirname, '../../../..');
const management = resolve(root, 'services/management-backend');
const gateway = resolve(root, 'services/ingestion-gateway');
const compose = resolve(management, 'test/compose.yaml');
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export async function startIfOptedIn<T>(env: NodeJS.ProcessEnv, start: () => Promise<T>): Promise<T | null> {
  return env.INFRAPULSE_RUN_MANAGEMENT_E2E === '1' ? start() : null;
}
export async function boundedSend<T extends {status: number}>(body: Uint8Array, send: (body: Uint8Array, remainingMs: number) => Promise<T>, options: {now?:()=>number;pause?:(ms:number)=>Promise<void>;deadlineMs?:number} = {}): Promise<T> {
  const now = options.now ?? (() => performance.now());
  const wait = options.pause ?? pause;
  const budget = options.deadlineMs ?? 20_000;
  if (!Number.isFinite(budget) || budget <= 0) throw new Error('Invalid sender deadline.');
  const end = now() + Math.min(budget, 20_000), bytes = body.slice();
  let result: T | undefined;
  for (let attempt = 0; attempt < 3 && now() < end; attempt++) {
    result = await send(bytes.slice(), end - now());
    if (result.status !== 429 && (result.status < 500 || result.status > 599)) return result;
    const delay = 500 * (2 ** attempt);
    if (attempt === 2 || delay >= end - now()) break;
    await wait(delay);
  }
  if (!result) throw new Error('Sender deadline exhausted.');
  return result;
}
export async function poll<T>(work: () => Promise<T>, accepts: (value: T) => boolean, deadlineMs = 30_000): Promise<T> {
  const end = performance.now() + deadlineMs;
  while (performance.now() < end) {
    const value = await work();
    if (accepts(value)) return value;
    await pause(Math.min(250, Math.max(0, end - performance.now())));
  }
  throw new Error('Task13 bounded observation deadline exhausted.');
}
export interface Owner { server: string; agent: string; credential: string; key: string }
export interface Reply { status: number; body: any; headers: Headers }

/** Imports/collection do no I/O. Every effect belongs to this exact generated run.
 * No root .env, socket mount, shared service name, named volume or public signer. */
export class IsolatedStack {
  db!: TestDatabase;
  readonly evidence = new Evidence();
  readonly sentinels: string[] = [];
  readonly gatewayId = randomUUID();
  readonly context = `task13-${randomUUID()}`;
  readonly subject = `task13-user-${randomUUID()}`;
  private adminKey!: KeyObject;
  private serviceKey!: KeyObject;
  private sequence = 0;
  private env!: NodeJS.ProcessEnv;
  private override!: string;
  managementUrl = '';
  gatewayUrl = '';
  prometheusUrl = '';
  readonly receipts: {gate: string; native_exit: number | null}[] = [];
  private ready = false;
  private closed = false;
  get isReady(): boolean { return this.ready && !this.closed; }

  file(name: string, value: string): string {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error('Unsafe fixture filename.');
    const path = resolve(this.db.privateDir, name);
    writeFileSync(path, value, {flag: 'wx', mode: 0o600});
    return path;
  }
  capture(name: string, value: string): string {
    const location = `${++this.sequence}-${name}`;
    const path = this.file(`${location}.capture`, value);
    this.evidence.register(location, path);
    return path;
  }
  command(exe: string, args: string[], label: string, env = this.env, timeout = 60_000, allowFailure = false): string {
    const location = `${++this.sequence}-${label}`;
    const out = this.file(`${location}.stdout`, ''), err = this.file(`${location}.stderr`, '');
    const stdout = openSync(out, 'a'), stderr = openSync(err, 'a');
    let code: number | null = null;
    try {
      const child = spawnSync(exe, args, {cwd: gateway, env, stdio: ['ignore', stdout, stderr], timeout: Math.ceil(timeout), windowsHide: true});
      code = child.status;
    } finally { closeSync(stdout); closeSync(stderr); }
    this.receipts.push({gate: label, native_exit: code});
    this.file(`${location}.exit.json`, JSON.stringify({gate: label, native_exit: code}) + '\n');
    this.evidence.register(`${location}-stdout`, out, code !== null);
    this.evidence.register(`${location}-stderr`, err, code !== null);
    if (statSync(out).size > 16 * 1024 * 1024) throw new Error('Task13 capture bound exceeded.');
    if (code !== 0 && !allowFailure) throw new Error(`Task13 prerequisite/command failed: ${label}; private output withheld.`);
    return readFileSync(out, 'utf8');
  }
  docker(args: string[], label: string, timeout = 60_000, allowFailure = false): string {
    return this.command('docker', args, label, this.env, timeout, allowFailure);
  }
  composeArgs(...args: string[]): string[] {
    return ['compose', '--env-file', resolve(this.db.privateDir, 'empty.env'), '-f', compose, '-f', this.override, '-p', this.db.project, '--profile', 'fullstack', ...args];
  }
  async start(): Promise<void> {
    if (process.env.INFRAPULSE_RUN_MANAGEMENT_E2E !== '1') throw new Error('Explicit isolated E2E opt-in required.');
    if (process.env.INFRAPULSE_TEST_DB_EXTERNAL === '1') throw new Error('Fullstack lifecycle belongs to the native parent; Linux DB mode is integration-only.');
    const began = performance.now();
    this.db = await startDatabase();
    useEvidence(this.evidence);
    this.env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('COMPOSE_')));
    Object.assign(this.env, {TEST_DB_RUN_ID: this.db.runId, TEST_DB_PRIVATE_DIR: this.db.privateDir,
      TASK12_PRIVATE_DIR: this.db.privateDir, TASK12_MANAGEMENT_RUNTIME_IMAGE: process.env.TASK13_MANAGEMENT_RUNTIME_IMAGE ?? 'infrapulse-task13-management:runtime',
      TASK12_GATEWAY_RUNTIME_IMAGE: process.env.TASK13_GATEWAY_RUNTIME_IMAGE ?? 'infrapulse-task13-gateway:runtime'});
    this.file('empty.env', '');
    try {
      await guardDatabase(this.db);
      for (const [name, path] of [['admin-network-url', this.db.adminFile], ['owner-network-url', this.db.ownerFile], ['runtime-network-url', this.db.runtimeFile]]) {
        const original = readTestUrl(path), url = new URL(original); url.hostname = 'pg'; url.port = '5432';
        this.sentinels.push(original, url.toString(), url.password);
        this.file(name, url.toString());
      }
      const admin = generateKeyPairSync('ed25519'), service = generateKeyPairSync('ed25519');
      this.adminKey = admin.privateKey; this.serviceKey = service.privateKey;
      const adminPem = admin.privateKey.export({type: 'pkcs8', format: 'pem'}).toString();
      const servicePem = service.privateKey.export({type: 'pkcs8', format: 'pem'}).toString();
      this.sentinels.push(adminPem, servicePem, adminPem.split('\n')[1], servicePem.split('\n')[1]);
      this.file('admin-signing-key', adminPem); this.file('gateway-signing-key', servicePem);
      this.file('admin-trust', JSON.stringify({'task13-admin': {public_key_pem: admin.publicKey.export({type: 'spki',format: 'pem'}).toString(), issuer: this.context, audience: 'task13-admin'}}));
      this.file('service-trust', JSON.stringify({'task13-gateway': {public_key_pem: service.publicKey.export({type: 'spki',format: 'pem'}).toString(), issuer: 'infrapulse-gateway', audience: 'infrapulse-management-internal', subject: this.gatewayId, scopes: ['credentials:verify', 'status:write']}}));
      const promConfig = 'global:\n  scrape_interval: 1s\nscrape_configs:\n  - job_name: ingestion-gateway\n    static_configs:\n      - targets: ["ingest:8000"]\n';
      const promPath = this.file('prometheus.yaml', promConfig);
      this.override = this.file('stack-override.json', JSON.stringify({services: {
        management: {environment: {MANAGEMENT_GRAFANA_CONTEXT: this.context, MANAGEMENT_REQUEST_RATE_PER_SECOND: '1000', MANAGEMENT_REQUEST_BURST: '1000', MANAGEMENT_AGENT_INGEST_BASE_URL: 'http://127.0.0.1:8000'}},
        ingest: {environment: {INGEST_GATEWAY_ID: this.gatewayId, INGEST_SERVICE_KEY_ID: 'task13-gateway'}},
        prometheus: {ports: ['127.0.0.1::9090'], volumes: [{type: 'bind', source: promPath, target: '/etc/prometheus/prometheus.yml', read_only: true, bind: {create_host_path: false}}]},
      }}));
      // Images are separately built and receipted prerequisites, not hidden in the startup budget.
      for (const tag of [this.env.TASK12_MANAGEMENT_RUNTIME_IMAGE!, this.env.TASK12_GATEWAY_RUNTIME_IMAGE!, process.env.TASK13_MANAGEMENT_MIGRATE_IMAGE ?? 'infrapulse-task13-management:migrate'])
        this.docker(['image', 'inspect', '--format', '{{.Id}}', tag], 'image-prerequisite');
      this.operation('bootstrap-db', [['admin-network-url','MANAGEMENT_BOOTSTRAP_DATABASE_URL_FILE'], ['owner-network-url','MANAGEMENT_MIGRATION_DATABASE_URL_FILE'], ['runtime-network-url','MANAGEMENT_DATABASE_URL_FILE']]);
      this.operation('migrate-db', [['owner-network-url','MANAGEMENT_MIGRATION_DATABASE_URL_FILE']]);
      this.operation('seed-db', [['owner-network-url','MANAGEMENT_MIGRATION_DATABASE_URL_FILE']], ['-e', `INGEST_GATEWAY_ID=${this.gatewayId}`]);
      this.docker(this.composeArgs('up', '-d', '--no-build', '--wait', '--wait-timeout', '150'), 'fullstack-up', Math.max(1000, 180_000 - (performance.now() - began)));
      for (const [service, port] of [['management',3000], ['ingest',8000], ['prometheus',9090]] as const) {
        const info = JSON.parse(this.docker(['inspect', '--format', '{{json .NetworkSettings.Ports}}', `${this.db.project}-${service}-1`], `${service}-port`));
        const bindings = info[`${port}/tcp`];
        if (bindings.length !== 1 || bindings[0].HostIp !== '127.0.0.1') throw new Error('Task13 unsafe published binding.');
        const origin = `http://127.0.0.1:${bindings[0].HostPort}`;
        if (service === 'management') this.managementUrl = origin;
        if (service === 'ingest') this.gatewayUrl = origin;
        if (service === 'prometheus') this.prometheusUrl = origin;
      }
      this.ready = true;
      this.capture('startup-budget', JSON.stringify({elapsed_ms: performance.now() - began, budget_ms: 180000}));
      if (performance.now() - began > 180_000) throw new Error('Task13 startup deadline exceeded.');
    } catch (error) { await this.close(); throw error; }
  }
  operation(name: string, mounts: readonly string[][], extra: string[] = []): void {
    const args = ['run', '--rm', '--network', `${this.db.project}_database`, '--label', `infrapulse.test.run_id=${this.db.runId}`, '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '512m', '--pids-limit', '128'];
    for (const [file, key] of mounts) args.push('--mount', `type=bind,src=${resolve(this.db.privateDir, file)},dst=/run/test/${file},readonly`, '-e', `${key}=/run/test/${file}`);
    args.push(...extra, process.env.TASK13_MANAGEMENT_MIGRATE_IMAGE ?? 'infrapulse-task13-management:migrate', 'node', `scripts/${name}.ts`);
    this.docker(args, name, 45_000);
  }
  async sql(text: string, values: unknown[] = []): Promise<any[]> {
    await guardDatabase(this.db);
    const db = new pg.Client({connectionString: readTestUrl(this.db.adminFile), connectionTimeoutMillis: 1000, statement_timeout: 2000});
    try { await db.connect(); return (await db.query(text, values)).rows; }
    catch { throw new Error('Task13 primary database query failed; details withheld.'); }
    finally { await db.end(); }
  }
  async token(method: string, target: string, body: string, role = 'Admin', kind = 'user'): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({kind, iss: kind === 'user' ? this.context : 'infrapulse-gateway', aud: kind === 'user' ? 'task13-admin' : 'infrapulse-management-internal', sub: kind === 'user' ? this.subject : this.gatewayId, ...(kind === 'user' ? {ctx: this.context, grafana_role: role} : {}),
      iat: now, nbf: now, exp: now + 60, jti: randomUUID(), m: method, t: target, b: createHash('sha256').update(body).digest('base64url')})
      .setProtectedHeader({alg: 'EdDSA',kid: kind === 'user' ? 'task13-admin' : 'task13-gateway'}).sign(kind === 'user' ? this.adminKey : this.serviceKey);
    this.sentinels.push(token); return token;
  }
  async request(method: string, target: string, payload?: unknown, options: {role?:string;kind?:string;token?:string;raw?:string;agentKey?:string} = {}): Promise<Reply> {
    const body = options.raw ?? (payload === undefined ? '' : JSON.stringify(payload));
    const token = options.agentKey ?? options.token ?? await this.token(method, target, body, options.role, options.kind);
    let response: Response;
    try { response = await fetch(this.managementUrl + target, {method, headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Request-Id': randomUUID()}, body: body || undefined, signal: AbortSignal.timeout(5000)}); }
    catch { throw new Error('Task13 HTTP request failed; details withheld.'); }
    const text = await response.text();
    let parsed: any; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    if (parsed?.api_key) {
      this.addCredential(parsed.api_key);
      this.capture('issue-rotate-instrumentation', JSON.stringify({status: response.status, cache_control: response.headers.get('cache-control'), secret_fields: Object.keys(parsed).filter((k) => k === 'api_key').length}));
    } else this.capture('http-response', text);
    return {status: response.status, body: parsed, headers: response.headers};
  }
  addCredential(key: string): void {
    const secret = key.split('.')[1];
    this.sentinels.push(key, secret, createHash('sha256').update(Buffer.from(secret, 'base64url')).digest('hex'), createHash('sha256').update(Buffer.from(secret, 'base64url')).digest('base64'));
  }
  async createOwner(expiresAt?: string): Promise<Owner> {
    const server = await this.request('POST', '/api/v1/servers', {name: 'task13 isolated', os: 'linux', environment: this.context});
    if (server.status !== 201) throw new Error(`Task13 create server status ${server.status}.`);
    const agent = await this.request('POST', `/api/v1/servers/${server.body.id}/agents`, {});
    if (agent.status !== 201) throw new Error(`Task13 register Agent status ${agent.status}.`);
    const key = await this.request('POST', `/api/v1/agents/${agent.body.id}/credentials`, {issuance_request_id: randomUUID(), scopes: ['metrics:write', 'provisioning:read', 'config:report'], ...(expiresAt ? {expires_at: expiresAt} : {})});
    if (key.status !== 201 || typeof key.body.api_key !== 'string') throw new Error(`Task13 issue credential status ${key.status}.`);
    return {server: server.body.id, agent: agent.body.id, credential: key.body.id, key: key.body.api_key};
  }
  async assign(owner: Owner): Promise<{version:string;checksum:string;config:unknown}> {
    const config = {schema_version: 1, os: 'linux', interval_seconds: 15, metric_groups: {cpu:true,memory:true,disk:true,network:true}, options:{}};
    const profile = await this.request('POST', '/api/v1/monitoring-profiles', {slug: `t13-${randomUUID()}`, name:'task13 isolated',os:'linux',description:''});
    if (profile.status !== 201) throw new Error(`Task13 create profile status ${profile.status}.`);
    const version = await this.request('POST', `/api/v1/monitoring-profiles/${profile.body.id}/versions`, {config});
    if (version.status !== 201) throw new Error(`Task13 create version status ${version.status}.`);
    const published = await this.request('POST', `/api/v1/profile-versions/${version.body.id}/publish`, {});
    const assigned = await this.request('PUT', `/api/v1/servers/${owner.server}/profile`, {profile_version_id: version.body.id});
    if (published.status !== 201 || assigned.status !== 200) throw new Error('Task13 publish/assignment failed.');
    return {version: version.body.id, checksum: version.body.checksum, config};
  }
  send(owner: Owner, options: {runId?:string;value?:number;timestampMs?:number;claim?:string;labels?:string;key?:string} = {}): {status:number;runId:string;timestampMs:number} {
    const runId = options.runId ?? randomUUID(), timestampMs = options.timestampMs ?? Date.now() - 60_000;
    const requestFile = this.file(`${++this.sequence}-sender.private`, JSON.stringify({gateway_url:this.gatewayUrl, api_key: options.key ?? owner.key, server_id:owner.server, agent_id:owner.agent, run_id:runId, value:options.value ?? 42.25, timestamp_ms:timestampMs, claim:options.claim ?? 'missing', labels:options.labels ?? 'missing'}));
    const env = {...this.env, TASK13_REQUEST_FILE:requestFile, PYTHONPATH:gateway, PYTHONUTF8:'1', PYTHONIOENCODING:'utf-8'};
    const python = process.env.TASK13_PYTHON ?? (process.platform === 'win32' ? resolve(gateway, '.venv/Scripts/python.exe') : 'python');
    const output = this.command(python, [resolve(management, 'test/support/scripts/task13_sender.py')], 'python-httpx-sender', env, 25_000);
    let result: any; try { result = JSON.parse(output); } catch { throw new Error('Task13 sender result invalid; private capture withheld.'); }
    if (!Number.isInteger(result.status)) throw new Error('Task13 sender failed; private capture withheld.');
    return {status:result.status,runId,timestampMs};
  }
  query(runId: string): string { return `infrapulse_e2e_value{run_id="${runId}"}`; }
  async vector(query: string): Promise<any[]> {
    const r = await fetch(this.prometheusUrl + '/api/v1/query?query=' + encodeURIComponent(query), {signal:AbortSignal.timeout(3000)});
    const b = await r.json() as any;
    if (!r.ok || b.status !== 'success' || b.data?.resultType !== 'vector' || !Array.isArray(b.data.result)) throw new Error('Task13 Prometheus query failed; never evidence of absence.');
    return b.data.result;
  }
  async absent(runId: string, seconds = 30): Promise<void> {
    const start = performance.now(), end = start + seconds * 1000;
    let queries = 0;
    for (;;) {
      if ((await this.vector(this.query(runId))).length) throw new Error('Task13 rejected run unexpectedly forwarded.');
      queries++;
      if (performance.now() >= end) break;
      await pause(Math.min(500, end - performance.now()));
    }
    this.capture('absence-window', JSON.stringify({run_id:runId,elapsed_ms:performance.now()-start,queries}));
  }
  refreshManagementPort(): void {
    const ports = JSON.parse(this.docker(['inspect','--format','{{json .NetworkSettings.Ports}}',`${this.db.project}-management-1`],'management-port-after-lifecycle'));
    const bindings = ports['3000/tcp'];
    if (bindings.length !== 1 || bindings[0].HostIp !== '127.0.0.1') throw new Error('Unsafe restarted listener.');
    const next = `http://127.0.0.1:${bindings[0].HostPort}`;
    this.capture('management-dynamic-port-reconciliation',JSON.stringify({port_changed:this.managementUrl !== next}));
    this.managementUrl = next;
  }
  async health(path: string): Promise<number> {
    try { return (await fetch(this.gatewayUrl + path, {signal:AbortSignal.timeout(2500)})).status; }
    catch { return 0; }
  }
  async swaggerProxy(owner: Owner, marker: string): Promise<{swagger_html_status:number;swagger_init_status:number;swagger_operations_present:boolean;proxy_validation_status:number;proxy_query_status:number;proxy_auth_status:number;proxy_agent_status:number;proxy_transport_status:number;proxy_events:number}> {
    await guardDatabase(this.db);
    const badJson = '{"name":"'+marker+'",', queryTarget = '/api/v1/servers?unknown='+marker;
    const input = this.file(`${++this.sequence}-swagger-proxy.private`,JSON.stringify({marker,agent_key:owner.key,bad_json:badJson,bad_assertion:await this.token('POST','/api/v1/servers',badJson),query_target:queryTarget,query_assertion:await this.token('GET',queryTarget,'')}));
    const args = ['run','--rm','--network',`${this.db.project}_database`,'--label',`infrapulse.test.run_id=${this.db.runId}`,'--read-only','--tmpfs','/tmp','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','512m','--pids-limit','128'];
    for (const [file,key] of [['runtime-network-url','MANAGEMENT_DATABASE_URL_FILE'],['admin-trust','MANAGEMENT_ADMIN_TRUST_FILE'],['service-trust','MANAGEMENT_SERVICE_TRUST_FILE']]) args.push('--mount',`type=bind,src=${resolve(this.db.privateDir,file)},dst=/run/test/${file},readonly`,'-e',`${key}=/run/test/${file}`);
    args.push('-e',`MANAGEMENT_GRAFANA_CONTEXT=${this.context}`,'--mount',`type=bind,src=${input},dst=/run/test/input,readonly`,'--mount',`type=bind,src=${resolve(management,'test/support/scripts/task13-swagger-proxy.mjs')},dst=/run/test/qualifier.mjs,readonly`,process.env.TASK13_MANAGEMENT_RUNTIME_IMAGE ?? 'infrapulse-task13-management:runtime','node','/run/test/qualifier.mjs');
    const output = this.docker(args,'actual-swagger-proxy-sentinel',45_000);
    const summaries = output.split('\n').flatMap((line) => {try {const parsed=JSON.parse(line) as Record<string,unknown>;return parsed.event==='task13_swagger_proxy_summary'?[parsed]:[];}catch{return [];}});
    if (summaries.length !== 1) throw new Error('Task13 Swagger/proxy qualifier receipt missing; private captures withheld.');
    const summary = summaries[0];
    const number = (key: string): number => {if (!Number.isInteger(summary[key])) throw new Error('Task13 Swagger/proxy receipt invalid.');return summary[key] as number;};
    return {swagger_html_status:number('swagger_html_status'),swagger_init_status:number('swagger_init_status'),swagger_operations_present:summary.swagger_operations_present===true,proxy_validation_status:number('proxy_validation_status'),proxy_query_status:number('proxy_query_status'),proxy_auth_status:number('proxy_auth_status'),proxy_agent_status:number('proxy_agent_status'),proxy_transport_status:number('proxy_transport_status'),proxy_events:number('proxy_events')};
  }
  async platform(): Promise<void> {
    const results: unknown[] = [];
    for (const [name, uid, networks, mounts] of [['management','10002:10002',['database','monitoring'],['/run/secrets/admin-trust','/run/secrets/runtime-url','/run/secrets/service-trust']], ['ingest','10001:10001',['monitoring'],['/run/secrets/gateway-signing-key']]] as const) {
      const row = this.docker(['inspect','--format','{{json .Config.User}}|{{json .HostConfig.ReadonlyRootfs}}|{{json .HostConfig.CapDrop}}|{{json .HostConfig.SecurityOpt}}|{{json .HostConfig.Memory}}|{{json .HostConfig.PidsLimit}}|{{json .HostConfig.LogConfig}}|{{json .Mounts}}|{{json .NetworkSettings.Networks}}',`${this.db.project}-${name}-1`], `${name}-hardening`).trim().split('|').map((p) => JSON.parse(p));
      const binds = row[7].filter((m: any) => m.Type === 'bind');
      if (row[0] !== uid || row[1] !== true || JSON.stringify(row[2]) !== '["ALL"]' || !row[3].includes('no-new-privileges:true') || row[4] !== 536870912 || row[5] !== 128 || row[6].Config['max-size'] !== '10m' || row[6].Config['max-file'] !== '3' || binds.some((m:any) => m.RW) || JSON.stringify(binds.map((m:any) => m.Destination).sort()) !== JSON.stringify([...mounts].sort()) || JSON.stringify(Object.keys(row[8]).sort()) !== JSON.stringify(networks.map((n) => `${this.db.project}_${n}`).sort())) throw new Error('Task13 hardening boundary failed.');
      results.push({service:name,hardening:'pass'});
    }
    const probe = (host: string, port: number): Promise<boolean> => new Promise((done) => {
      const socket = connect({host,port}); const finish = (ok: boolean) => {socket.destroy();done(ok);};
      socket.setTimeout(1000, () => finish(false)); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
    });
    for (const [name, origin] of [['management',this.managementUrl],['ingest',this.gatewayUrl],['prometheus',this.prometheusUrl]]) {
      const port = Number(new URL(origin).port);
      if (!await probe('127.0.0.1', port)) throw new Error('Task13 native loopback probe failed.');
      results.push({service:name,host:'loopback-v4',connected:true});
      const addresses = Object.values(networkInterfaces()).flat().filter((v) => v && !v.internal && v.family === 'IPv4');
      if (!addresses.length) throw new Error('Task13 no nonloopback IPv4 interface to probe.');
      for (const address of addresses) {
        const connected = await probe(address!.address, port); results.push({service:name,host:'nonloopback-v4',connected});
        if (connected) throw new Error('Task13 nonloopback exposure detected.');
      }
      const connected = await probe('::1', port); results.push({service:name,host:'loopback-v6',connected});
      if (connected) throw new Error('Task13 unexpected IPv6 published listener.');
    }
    this.capture('native-platform-probes', JSON.stringify(results));
  }
  async collect(): Promise<void> {
    for (const name of ['management','ingest','pg','prometheus']) this.docker(['logs', `${this.db.project}-${name}-1`], `${name}-container-logs`);
    this.capture('audit-database', JSON.stringify(await this.sql('SELECT actor_kind,actor_issuer,actor_subject,operation,resource_type,resource_id,outcome,delta FROM management.audit_logs')));
  }
  async scan(): Promise<void> {
    await this.collect();
    const scan = await scanEvidence(this.sentinels);
    this.file(`${++this.sequence}-scan-verdict.json`, JSON.stringify({scan,manifest:this.evidence.manifest(),receipts:this.receipts}));
    if (!scan.complete || scan.leak_count !== 0) throw new Error(`Task13 evidence scan failed: complete=${scan.complete} leak_count=${scan.leak_count} locations=${scan.locations.join(',')}; no captured values emitted.`);
  }
  async close(): Promise<void> {
    if (!this.db || this.db.external || this.closed) return;
    await guardDatabase(this.db);
    this.file('scan-sentinels.private', JSON.stringify(this.sentinels));
    if (!this.override) { this.override = this.file('cleanup-override.json', '{}'); }
    if (!this.env) this.env = {...process.env, TEST_DB_RUN_ID:this.db.runId,TEST_DB_PRIVATE_DIR:this.db.privateDir};
    this.docker(this.composeArgs('down', '--timeout', '10', '--remove-orphans'), 'fullstack-down', 60_000);
    const containers = this.docker(['ps','-aq','--filter',`label=infrapulse.test.run_id=${this.db.runId}`], 'owned-containers-after');
    const networks = this.docker(['network','ls','-q','--filter',`label=com.docker.compose.project=${this.db.project}`], 'owned-networks-after');
    this.file('cleanup-receipt.json',JSON.stringify({run_id:this.db.runId,project:this.db.project,containers:containers.trim()?1:0,networks:networks.trim()?1:0,was_ready:this.ready}));
    if (containers.trim() || networks.trim()) throw new Error('Task13 owned cleanup incomplete.');
    this.closed = true;
  }
}
