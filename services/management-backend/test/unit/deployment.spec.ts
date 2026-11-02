import { createRequire } from 'node:module';
import { readFileSync, existsSync, mkdirSync, writeFileSync, openSync, closeSync, cpSync, statSync, rmSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { startDatabase, stopDatabase, guardDatabase, readTestUrl, type TestDatabase } from '../support/pg-harness.js';

// Reuse the already-pinned Swagger YAML parser, without adding a package/lock change.
const require = createRequire(import.meta.url);
const yaml = createRequire(require.resolve('@nestjs/swagger/package.json'))('js-yaml') as {
  load(text: string, options?: {schema: unknown}): any;
  YAML11_SCHEMA: unknown;
};
const root = process.env.TASK12_REPOSITORY_ROOT ?? resolve(import.meta.dirname, '../../../..');
const managementPath = resolve(root, 'services/management-backend');
// Compose supports merge keys; js-yaml5's default YAML1.2 schema does not.
const readYaml = (path: string) => yaml.load(readFileSync(path, 'utf8'), {schema: yaml.YAML11_SCHEMA});
const compose = () => readYaml(resolve(root, 'deploy/compose/compose.yaml'));
const hardening = {
  read_only: true, tmpfs: ['/tmp'], cap_drop: ['ALL'],
  security_opt: ['no-new-privileges:true'], mem_limit: '512m', pids_limit: 128,
  logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
};

// Breaks caught: public exposure, DB-network access by the Gateway, and privileged
// secrets leaking into the application instead of explicit operator jobs.
describe('Task12 deployment boundaries (repository only; no dotenv or Docker)', () => {
  it('isolates Management ports and networks without moving existing storage', () => {
    const config = compose();
    const management = config.services.management;
    expect(management).toBeDefined();
    expect(management.networks).toEqual(['monitoring', 'database']);
    expect(management.ports).toEqual(['127.0.0.1:${MANAGEMENT_HOST_PORT:-3001}:3000']);
    expect(management.build).toEqual({ context: '../../services/management-backend', target: 'runtime' });
    expect(management.depends_on).toEqual({ postgres: { condition: 'service_healthy' } });
    expect(config.services.ingest.networks).toEqual(['monitoring']);
    expect(config.services.ingest.depends_on).toEqual({
      prometheus: { condition: 'service_healthy' }, management: { condition: 'service_healthy' },
    });
    expect(config.volumes).toEqual({ prometheus_data: null, grafana_data: null, postgres_data: null });
    expect(config.services.prometheus.command).toContain('--web.enable-remote-write-receiver');
  });

  it('mounts only the runtime URL and public trust into the nonroot runtime', () => {
    const management = compose().services.management;
    expect(management).toBeDefined();
    for (const [name, value] of Object.entries(hardening)) expect(management[name]).toEqual(value);
    expect(management.user).toBe('10002:10002');
    expect(management.environment).toEqual({
      PORT: '3000', MANAGEMENT_DATABASE_URL_FILE: '/run/secrets/runtime-url',
      MANAGEMENT_ADMIN_TRUST_FILE: '/run/secrets/admin-trust',
      MANAGEMENT_SERVICE_TRUST_FILE: '/run/secrets/service-trust',
      MANAGEMENT_GRAFANA_CONTEXT: '${MANAGEMENT_GRAFANA_CONTEXT:?explicit Grafana context required}',
      MANAGEMENT_AGENT_INGEST_BASE_URL: '${MANAGEMENT_AGENT_INGEST_BASE_URL:-http://127.0.0.1:8000}',
      MANAGEMENT_LOG_LEVEL: '${MANAGEMENT_LOG_LEVEL:-INFO}',
      MANAGEMENT_REQUEST_RATE_PER_SECOND: '${MANAGEMENT_REQUEST_RATE_PER_SECOND:-20}',
      MANAGEMENT_REQUEST_BURST: '${MANAGEMENT_REQUEST_BURST:-40}',
      MANAGEMENT_DB_POOL_MAX: '${MANAGEMENT_DB_POOL_MAX:-10}',
      MANAGEMENT_DB_POOL_TIMEOUT_MS: '${MANAGEMENT_DB_POOL_TIMEOUT_MS:-1000}',
      MANAGEMENT_NONCE_MAX_ENTRIES: '${MANAGEMENT_NONCE_MAX_ENTRIES:-20000}',
    });
    expect(management.volumes.map((v: any) => v.target).sort()).toEqual([
      '/run/secrets/admin-trust', '/run/secrets/runtime-url', '/run/secrets/service-trust',
    ]);
    for (const mount of management.volumes) {
      expect(mount.type).toBe('bind'); expect(mount.read_only).toBe(true);
      expect(mount.bind).toEqual({ create_host_path: false });
    }
    for (const forbidden of ['env_file', 'command', 'entrypoint', 'privileged', 'network_mode'])
      expect(management).not.toHaveProperty(forbidden);
  });

  it('keeps bootstrap, migration, and seed explicit and owner-only', () => {
    const services = compose().services;
    for (const [name, command, targets] of [
      ['management-bootstrap', 'bootstrap-db.ts', ['/run/secrets/bootstrap-url', '/run/secrets/owner-url', '/run/secrets/runtime-url']],
      ['management-migrate', 'migrate-db.ts', ['/run/secrets/owner-url']],
      ['management-seed', 'seed-db.ts', ['/run/secrets/owner-url']],
    ] as const) {
      const job = services[name];
      expect(job).toBeDefined();
      expect(job.profiles).toEqual(['management-ops']);
      expect(job.build).toEqual({ context: '../../services/management-backend', target: 'migrate' });
      expect(job.command).toEqual(['node', `scripts/${command}`]);
      expect(job.networks).toEqual(['database']);
      expect(job.restart).toBe('no');
      expect(job.user).toBe('10002:10002');
      expect(job.volumes.map((v: any) => v.target).sort()).toEqual([...targets].sort());
      for (const mount of job.volumes) {
        expect(mount.read_only).toBe(true); expect(mount.bind.create_host_path).toBe(false);
      }
      for (const [key, value] of Object.entries(hardening)) expect(job[key]).toEqual(value);
    }
    // Completion is operator gated, never an automatic bootstrap/seed dependency.
    expect(services.management.depends_on).not.toHaveProperty('management-bootstrap');
    expect(services.management.depends_on).not.toHaveProperty('management-seed');
    expect(services['management-seed'].environment.INGEST_GATEWAY_ID)
      .toBe('${INGEST_GATEWAY_ID:?fixed canonical gateway UUID required}');
  });

  it('keeps isolated DB defaults and opt-in fullstack networks separate', () => {
    const config = readYaml(resolve(managementPath, 'test/compose.yaml'));
    expect(config.services.pg.image).toBe('postgres:18.6-bookworm');
    expect(config.services.pg.ports).toEqual(['127.0.0.1::5432']);
    expect(config.services.pg.tmpfs).toEqual(['/var/lib/postgresql:rw,noexec,nosuid,size=256m']);
    expect(config.services.pg.volumes[0].bind).toEqual({create_host_path: false});
    expect(config.services.pg).not.toHaveProperty('profiles');
    expect(config).not.toHaveProperty('volumes');
    for (const name of ['management', 'ingest', 'prometheus'])
      expect(config.services[name]?.profiles).toEqual(['fullstack']);
    expect(config.services.management.networks).toEqual(['monitoring', 'database']);
    expect(config.services.ingest.networks).toEqual(['monitoring']);
    expect(config.services.management.volumes.map((v: any) => v.target).sort())
      .toEqual(['/run/secrets/admin-trust', '/run/secrets/runtime-url', '/run/secrets/service-trust']);
  });

  it('provides build, test, migrate and default runtime targets', () => {
    const file = resolve(managementPath, 'Dockerfile');
    expect(existsSync(file)).toBe(true);
    const targets = readFileSync(file, 'utf8').split('\n')
      .filter((line) => /^FROM /i.test(line)).map((line) => / AS (\S+)$/i.exec(line)?.[1]);
    expect(targets).toEqual(['build', 'test', 'migrate', 'runtime']);
  });
});

// Opt-in real packaging gate; ordinary unit collection never starts Docker/DB.
// All private fixtures are locally generated, never printed or copied to images.
const imageGate = process.env.TASK12_RUN_IMAGES === '1';
describe.skipIf(!imageGate)('Task12 actual Linux images and isolated runtime', () => {
  const run = randomBytes(8).toString('hex');
  const workspace = resolve(root, '.superpowers/sdd/2026-10-31-management-backend');
  const evidence = resolve(workspace, `task-12-images-${run}`);
  const canaryDir = resolve(managementPath, 'secrets', `task12-${run}`);
  const gatewayId = '10000000-0000-4000-8000-000000000001';
  const image = (target: string) => `infrapulse-task12-${run}-management:${target}`;
  const gatewayImage = (target: string) => `infrapulse-task12-${run}-gateway:${target}`;
  let db: TestDatabase | undefined;
  let stackEnv: NodeJS.ProcessEnv;
  let sequence = 0;
  let privateValues: string[] = [];

  function docker(args: string[], label: string, env: NodeJS.ProcessEnv = process.env, timeout = 180_000): string {
    // No pipes and no error object/argv/expanded environment in failure messages.
    const output = resolve(evidence, `${++sequence}-${label}.private`);
    const fd = openSync(output, 'wx', 0o600);
    let code: number | null;
    try {
      const result = spawnSync('docker', args, { cwd: managementPath, env,
        stdio: ['ignore', fd, fd], timeout, windowsHide: true });
      code = result.status;
    } finally { closeSync(fd); }
    writeFileSync(`${output}.exit.json`, JSON.stringify({gate:label,native_exit:code})+'\n', {mode:0o600,flag:'wx'});
    if (code !== 0) throw new Error(`Task12 Docker gate failed: ${label}; output withheld.`);
    if (statSync(output).size > 16 * 1024 * 1024) throw new Error('Task12 output bound exceeded.');
    return readFileSync(output, 'utf8');
  }
  function privateFile(name: string, value: string): string {
    if (!db) throw new Error('Isolated database required.');
    const path = resolve(db.privateDir, name);
    writeFileSync(path, value, { mode: 0o600, flag: 'wx' });
    return path;
  }
  function networkUrl(name: string, source: string) {
    const url = new URL(readTestUrl(source));
    url.hostname = 'pg'; url.port = '5432';
    privateValues.push(url.toString(), decodeURIComponent(url.password));
    return privateFile(name, url.toString());
  }
  function composeArgs(...tail: string[]) {
    if (!db) throw new Error('Isolated database required.');
    return ['compose', '--env-file', resolve(db.privateDir, 'empty.env'), '-f',
      resolve(managementPath, 'test/compose.yaml'), '-p', db.project, '--profile', 'fullstack', ...tail];
  }
  function operation(command: string, mounts: [string, string][], extra: string[] = []) {
    if (!db) throw new Error('Isolated database required.');
    const args = ['run', '--rm', '--network', `${db.project}_database`, '--read-only', '--tmpfs', '/tmp',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '512m', '--pids-limit', '128',
      '--label', `infrapulse.test.run_id=${db.runId}`];
    for (const [file, key] of mounts) args.push('--mount', `type=bind,src=${resolve(db.privateDir, file)},dst=/run/secrets/${file},readonly`,
      '-e', `${key}=/run/secrets/${file}`);
    args.push(...extra, image('migrate'), 'node', `scripts/${command}.ts`);
    docker(args, command, stackEnv);
  }
  function execNode(script: string, label: string) {
    if (!db) throw new Error('Isolated database required.');
    return docker(['exec', `${db.project}-management-1`, 'node', '--input-type=module', '-e', script], label, stackEnv);
  }
  function safeMetadata(): string {
    const target = resolve(evidence, 'metadata');
    const files = ['deploy/compose/compose.yaml', '.env.example', '.gitignore',
      'observability/prometheus/prometheus.yml', 'services/management-backend/Dockerfile',
      'services/management-backend/.dockerignore', 'services/management-backend/package.json',
      'services/management-backend/test/compose.yaml', 'services/ingestion-gateway/Dockerfile',
      'services/ingestion-gateway/.dockerignore', 'services/ingestion-gateway/pyproject.toml'];
    for (const file of files) {
      const destination = resolve(target, file); mkdirSync(dirname(destination), {recursive: true});
      cpSync(resolve(root, file), destination);
    }
    cpSync(resolve(root, 'services/ingestion-gateway/tests'), resolve(target, 'services/ingestion-gateway/tests'), {
      recursive: true, filter: (path) => statSync(path).isDirectory() || /\.(py|hex)$/.test(path),
    });
    return target;
  }

  beforeAll(() => { mkdirSync(evidence, {recursive: true, mode: 0o700}); }, 10_000);
  afterAll(async () => {
    try {
      if (db) {
        // The T2 default down omits profiled services. Preserve its exact DB/run
        // guard, then tear down this fullstack profile explicitly (never -v).
        await guardDatabase(db);
        if (stackEnv) docker(composeArgs('down','--timeout','10'), 'fullstack-owned-down', stackEnv, 60_000);
        else stopDatabase(db);
        const remaining = docker(['ps','-a','--filter',`label=infrapulse.test.run_id=${db.runId}`,'--format','{{.ID}}'], 'teardown-owned-container-check', stackEnv).trim();
        if (remaining) throw new Error('Task12 owned fullstack containers remain after teardown.');
        const networks = docker(['network','ls','--filter',`label=com.docker.compose.project=${db.project}`,'--format','{{.ID}}'], 'teardown-owned-network-check', stackEnv).trim();
        if (networks) throw new Error('Task12 owned fullstack networks remain after teardown.');
      }
    } finally {
      // Delete only this positively identified generated canary subtree.
      if (basename(canaryDir) === `task12-${run}` && dirname(canaryDir) === resolve(managementPath, 'secrets') && existsSync(canaryDir))
        rmSync(canaryDir, {recursive: true});
    }
  }, 90_000);

  it('builds frozen targets and excludes dev CLI, source/tests and private fixtures from runtime', () => {
    mkdirSync(canaryDir, {recursive: true, mode: 0o700});
    const canary = randomBytes(32).toString('base64url'); privateValues.push(canary);
    writeFileSync(resolve(canaryDir, 'opaque-material'), canary, {mode: 0o600, flag: 'wx'});
    for (const target of ['build', 'test', 'migrate', 'runtime'])
      docker(['build', '--platform', 'linux/amd64', '--target', target, '-t', image(target), managementPath], `build-${target}`, process.env, 1_200_000);
    for (const target of ['test', 'runtime'])
      docker(['build', '--platform', 'linux/amd64', '--target', target, '-t', gatewayImage(target), resolve(root, 'services/ingestion-gateway')], `gateway-${target}`, process.env, 1_200_000);
    // Real filesystem/import resolution, including every installed package manifest.
    const result = docker(['run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp',
      '--mount', `type=bind,src=${resolve(canaryDir,'opaque-material')},dst=/run/task12-canary,readonly`, image('runtime'),
      'node', '--input-type=module', '-e', `
        import fs from 'node:fs'; import path from 'node:path';
        import {createRequire} from 'node:module'; const r=createRequire(import.meta.url);
        if(process.getuid()!==10002 || process.version!=='v24.20.0' || process.arch!=='x64' || process.platform!=='linux') process.exit(2);
        for(const name of ['npm','npx','yarn','yarnpkg','pnpm','corepack']) if(fs.existsSync('/usr/local/bin/'+name)) process.exit(8);
        for(const p of ['test','src','scripts','prisma','secrets','private']) if(fs.existsSync('/app/'+p)) process.exit(3);
        const canary=fs.readFileSync('/run/task12-canary');
        const forbidden=new Set(['prisma','typescript','vitest','vite','@nestjs/cli','@swc/core']);
        function visit(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
          if(entry.isSymbolicLink()) continue; const p=path.join(dir,entry.name);
          if(entry.isDirectory()) visit(p);
          else {const bytes=fs.readFileSync(p); if(bytes.includes(canary)) process.exit(7);
            if(entry.name==='package.json'){try{if(forbidden.has(JSON.parse(bytes.toString('utf8')).name)) process.exit(4);}catch{process.exit(5);}}}
        }} visit('/app');
        await import('./dist/generated/prisma/client.js');
        await import('@prisma/client/runtime/query_compiler_fast_bg.postgresql.mjs');
        const {wasm}=await import('@prisma/client/runtime/query_compiler_fast_bg.postgresql.wasm-base64.mjs');
        if(!wasm) process.exit(6); console.log('runtime_inventory_ok');
      `], 'runtime-inventory');
    expect(result.trim()).toBe('runtime_inventory_ok');
    process.stdout.write(`task12_image_evidence=${evidence}\n`);
  }, 2_400_000);

  it('runs explicit bootstrap/deploy/seed then isolated hardened runtime with actual UID-readable mounts and least grants', async () => {
    db = await startDatabase();
    await guardDatabase(db);
    const adminNetwork = networkUrl('admin-network-url', db.adminFile);
    networkUrl('owner-network-url', db.ownerFile); networkUrl('runtime-network-url', db.runtimeFile);
    privateFile('empty.env', '');
    const admin = generateKeyPairSync('ed25519');
    const service = generateKeyPairSync('ed25519');
    const pem = service.privateKey.export({type: 'pkcs8', format: 'pem'}).toString();
    privateValues.push(pem, readTestUrl(adminNetwork), readTestUrl(db.ownerFile), readTestUrl(db.runtimeFile));
    privateFile('gateway-signing-key', pem);
    privateFile('admin-trust', JSON.stringify({'task12-admin': {
      public_key_pem: admin.publicKey.export({type:'spki',format:'pem'}).toString(),
      issuer:'task12-grafana',audience:'task12-management-admin',
    }}));
    privateFile('service-trust', JSON.stringify({'task12-gateway': {
      public_key_pem: service.publicKey.export({type:'spki',format:'pem'}).toString(),
      issuer:'infrapulse-gateway',audience:'infrapulse-management-internal',subject:gatewayId,
      scopes:['credentials:verify','status:write'],
    }}));
    stackEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COMPOSE_')));
    Object.assign(stackEnv, {TEST_DB_RUN_ID:db.runId, TEST_DB_PRIVATE_DIR:db.privateDir,
      TASK12_PRIVATE_DIR:db.privateDir, TASK12_MANAGEMENT_RUNTIME_IMAGE:image('runtime'), TASK12_GATEWAY_RUNTIME_IMAGE:gatewayImage('runtime')});
    operation('bootstrap-db', [['admin-network-url','MANAGEMENT_BOOTSTRAP_DATABASE_URL_FILE'],
      ['owner-network-url','MANAGEMENT_MIGRATION_DATABASE_URL_FILE'], ['runtime-network-url','MANAGEMENT_DATABASE_URL_FILE']]);
    operation('migrate-db', [['owner-network-url','MANAGEMENT_MIGRATION_DATABASE_URL_FILE']]);
    operation('seed-db', [['owner-network-url','MANAGEMENT_MIGRATION_DATABASE_URL_FILE']], ['-e',`INGEST_GATEWAY_ID=${gatewayId}`]);
    docker(composeArgs('up', '-d', '--no-build', '--wait', '--wait-timeout', '180'), 'fullstack-up', stackEnv, 240_000);
    const query = execNode(`
      import fs from 'node:fs'; import {PrismaPg} from '@prisma/adapter-pg';
      import {PrismaClient} from './dist/generated/prisma/client.js';
      const db=new PrismaClient({adapter:new PrismaPg({connectionString:fs.readFileSync('/run/secrets/runtime-url','utf8').trim()},{schema:'management'}),log:[]});
      try{const rows=await db.gatewaySource.findMany(); if(rows.length!==1||rows[0].gateway_id!=='${gatewayId}') process.exitCode=2;
        const versions=await db.profileVersion.count(); if(versions!==2) process.exitCode=3;
        for(const route of ['/health/live','/health/ready']){const r=await fetch('http://127.0.0.1:3000'+route,{signal:AbortSignal.timeout(2000)}); if(!r.ok) process.exitCode=4;}
        for(const p of ['runtime-url','admin-trust','service-trust']) fs.accessSync('/run/secrets/'+p,fs.constants.R_OK);
        let denied=false;try{fs.writeFileSync('/app/task12-write','no');}catch(e){denied=['EROFS','EACCES'].includes(e.code);} if(!denied) process.exitCode=5;
        fs.writeFileSync('/tmp/task12-write','temporary'); fs.unlinkSync('/tmp/task12-write');
        if(!process.exitCode) console.log('runtime_query_health_uid_ro_ok');
      }catch{process.exitCode=6;}finally{await db.$disconnect();}
    `, 'runtime-query');
    expect(query.trim()).toBe('runtime_query_health_uid_ro_ok');
    const grants = execNode(`
      import fs from 'node:fs'; import pg from 'pg'; const c=new pg.Client({connectionString:fs.readFileSync('/run/secrets/runtime-url','utf8').trim(),connectionTimeoutMillis:1000,statement_timeout:1000});
      try{await c.connect();
        const q=await c.query("SELECT current_user AS role, has_schema_privilege(current_user,'management','CREATE') AS create, has_table_privilege(current_user,'management.audit_logs','SELECT,INSERT') AS audit");
        if(q.rows[0].role!=='management_runtime'||q.rows[0].create||!q.rows[0].audit) process.exitCode=2;
        const statements=['CREATE TABLE management.task12_forbidden(id int)','ALTER TABLE management.servers ADD COLUMN task12_forbidden int','DROP TABLE management.servers','TRUNCATE management.servers','UPDATE management.audit_logs SET outcome=outcome','DELETE FROM management.audit_logs',"INSERT INTO management._prisma_migrations(id,checksum,migration_name) VALUES('x','x','x')",'UPDATE management._prisma_migrations SET checksum=checksum','DELETE FROM management._prisma_migrations'];
        let denied=0;for(const sql of statements){await c.query('BEGIN');try{await c.query(sql);}catch(e){if(e.code==='42501') denied++;}finally{await c.query('ROLLBACK');}}
        if(denied!==statements.length) process.exitCode=3;
        await c.query('BEGIN'); await c.query("INSERT INTO management.audit_logs(id,actor_kind,actor_issuer,actor_subject,operation,resource_type,resource_id,outcome,request_id,delta) VALUES(gen_random_uuid(),'service','task12','fixture','task12','test',gen_random_uuid(),'success',gen_random_uuid(),'{}')"); await c.query('ROLLBACK');
        if(!process.exitCode) console.log('runtime_least_grants_9_denials_audit_insert_ok');
      }catch{process.exitCode=4;}finally{await c.end();}
    `, 'runtime-least-grants');
    expect(grants.trim()).toBe('runtime_least_grants_9_denials_audit_insert_ok');
    const inspect = docker(['inspect','--format', '{{json .Config.User}}|{{json .HostConfig.ReadonlyRootfs}}|{{json .HostConfig.CapDrop}}|{{json .HostConfig.SecurityOpt}}|{{json .HostConfig.Memory}}|{{json .HostConfig.PidsLimit}}|{{json .Mounts}}|{{json .NetworkSettings.Networks}}|{{json .Config.Labels}}',`${db.project}-management-1`], 'runtime-allowlisted-inspect', stackEnv).trim().split('|').map((v) => JSON.parse(v));
    expect(inspect[0]).toBe('10002:10002'); expect(inspect[1]).toBe(true); expect(inspect[2]).toEqual(['ALL']);
    expect(inspect[3]).toContain('no-new-privileges:true'); expect(inspect[4]).toBe(536870912); expect(inspect[5]).toBe(128);
    const binds = inspect[6].filter((v: any) => v.Type==='bind');
    expect(binds.map((v: any) => v.Destination).sort()).toEqual(['/run/secrets/admin-trust','/run/secrets/runtime-url','/run/secrets/service-trust']);
    expect(binds.every((v: any) => v.RW===false)).toBe(true);
    expect(Object.keys(inspect[7]).sort()).toEqual([`${db.project}_database`,`${db.project}_monitoring`].sort());
    expect(inspect[8]['infrapulse.test.run_id']).toBe(db.runId);
    const gatewayUid = docker(['exec',`${db.project}-ingest-1`,'python','-c',"import os; from pathlib import Path; assert os.getuid()==10001; assert Path('/run/secrets/gateway-signing-key').read_bytes(); print('gateway_uid_readable_ok')"], 'gateway-uid', stackEnv);
    expect(gatewayUid.trim()).toBe('gateway_uid_readable_ok');
    for (const name of ['management','ingest']) {
      const logs=docker(['logs',`${db.project}-${name}-1`], `${name}-logs-private`, stackEnv);
      // Do not put actual secret values into assertion diagnostics.
      if(privateValues.some((value) => value && logs.includes(value))) throw new Error('Task12 private fixture leakage detected.');
    }
    process.stdout.write('task12_runtime_grants_health_mounts_ok\n');
  }, 360_000);

  it('runs actual Management Linux unit/integration suites and the Gateway Linux test image', () => {
    if(!db) throw new Error('Task12 runtime prerequisite not completed.');
    docker(composeArgs('stop','management','ingest','prometheus'), 'stop-apps-before-db-suite', stackEnv, 60_000);
    const metadata = safeMetadata();
    const mount = ['--mount', `type=bind,src=${metadata},dst=/repo,readonly`];
    docker(['run','--rm','--network','none',...mount,'-e','TASK12_REPOSITORY_ROOT=/repo',image('test'),'pnpm','test'], 'linux-management-unit', stackEnv, 300_000);
    const args=['run','--rm','--network',`${db.project}_database`,'-e','INFRAPULSE_TEST_DB_EXTERNAL=1','-e',`TEST_DB_RUN_ID=${db.runId}`];
    for(const [file,key] of [['admin-network-url','TEST_DB_ADMIN_URL_FILE'],['owner-network-url','MANAGEMENT_MIGRATION_DATABASE_URL_FILE'],['runtime-network-url','MANAGEMENT_DATABASE_URL_FILE']])
      args.push('--mount',`type=bind,src=${resolve(db.privateDir,file)},dst=/run/test/${file},readonly`,'-e',`${key}=/run/test/${file}`);
    docker([...args,image('test'),'pnpm','test:integration'], 'linux-management-integration', stackEnv, 600_000);
    docker(['run','--rm','--network','none',...mount,'-w','/repo/services/ingestion-gateway',gatewayImage('test'),
      'pytest','-p','no:cacheprovider','--basetemp=/tmp/task12-gateway-linux','-q'], 'linux-gateway-suite', stackEnv, 300_000);
    process.stdout.write('task12_linux_suites_ok\n');
  }, 1_200_000);
});
