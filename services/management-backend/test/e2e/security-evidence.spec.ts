import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { IsolatedStack, poll } from '../support/stack-harness.js';

const opted = process.env.INFRAPULSE_RUN_MANAGEMENT_E2E === '1';
describe.skipIf(!opted)('Task13 actual runtime security evidence and native isolation', () => {
  let stack: IsolatedStack;
  beforeAll(async () => { stack = new IsolatedStack(); await stack.start(); });
  afterAll(async () => { if (stack?.db) { try { if (stack.isReady) await stack.scan(); } finally { await stack.close(); } } });

  it('captures rejected inputs/one-time metadata and real SQL/ORM faults without key, URL, hash or body leakage', async () => {
    const began = performance.now();
    const marker = `task13-sensitive-${randomBytes(24).toString('hex')}`;
    stack.sentinels.push(marker);
    const owner = await stack.createOwner();
    await stack.assign(owner);
    const rotateId = randomUUID();
    const rotation = await stack.request('POST',`/api/v1/credentials/${owner.credential}/rotate`,{issuance_request_id:rotateId});
    expect(rotation.status).toBe(201);
    expect(rotation.headers.get('cache-control')).toBe('no-store');
    const retry = await stack.request('POST',`/api/v1/credentials/${owner.credential}/rotate`,{issuance_request_id:rotateId});
    expect(retry.status).toBe(409);
    expect(Object.hasOwn(retry.body,'api_key')).toBe(false);
    for (const path of ['/api/v1/credentials',`/api/v1/credentials/${owner.credential}`,'/api/v1/agent/provisioning']) {
      const r = await stack.request('GET',path,undefined,path.includes('/agent/')?{agentKey:owner.key}:{});
      expect(r.status).toBe(200);
    }
    // Every actual response is captured privately, including malformed parser and
    // validation paths. Assertions compare statuses only, never raw response bodies.
    expect((await stack.request('POST','/api/v1/servers',undefined,{raw:'{"name":"'+marker+'",'})).status).toBe(400);
    expect((await stack.request('POST','/api/v1/servers',{name:'bad',os:'linux',environment:'task13',metadata:{api_key:marker}})).status).toBe(400);
    const profile = await stack.request('POST','/api/v1/monitoring-profiles',{slug:`bad-${randomUUID()}`,name:'fault',os:'linux',description:''});
    expect(profile.status).toBe(201);
    expect((await stack.request('POST',`/api/v1/monitoring-profiles/${profile.body.id}/versions`,{config:{schema_version:1,os:'linux',interval_seconds:15,metric_groups:{cpu:true,memory:true,disk:true,network:true},options:{script:marker}}})).status).toBe(400);
    expect((await stack.request('GET',`/api/v1/servers?unknown=${marker}`)).status).toBe(400);
    expect((await stack.request('GET',`/api/v1/servers/${marker}`)).status).toBe(400);
    const binding = await stack.token('GET','/api/v1/me','');
    expect((await stack.request('GET',`/api/v1/me?path=${marker}`,undefined,{token:binding})).status).toBe(401);
    expect((await stack.request('GET','/api/v1/me',undefined,{token:marker})).status).toBe(401);
    // Fault injection is DCL only in this exact guarded, generated test DB;
    // restore grants in finally. No production schema/migration file changes.
    await stack.sql('REVOKE SELECT ON management.servers FROM management_runtime');
    try { expect((await stack.request('GET','/api/v1/servers')).status).toBe(503); }
    finally { await stack.sql('GRANT SELECT ON management.servers TO management_runtime'); }
    expect((await stack.request('GET','/api/v1/servers')).status).toBe(200);
    await stack.platform();
    expect(performance.now()-began).toBeLessThan(120_000);
  });

  it('preserves nonce replay rejection across real Nest restart and captures actual private-file/HTTPX/timeout paths', async () => {
    const began = performance.now();
    const token = await stack.token('GET','/api/v1/me','');
    expect((await stack.request('GET','/api/v1/me',undefined,{token})).status).toBe(200);
    expect((await stack.request('GET','/api/v1/me',undefined,{token})).status).toBe(401);
    stack.docker(stack.composeArgs('restart','--timeout','2','management'),'nonce-restart',15_000);
    stack.refreshManagementPort();
    await poll(async () => {try{return (await fetch(stack.managementUrl+'/health/ready',{signal:AbortSignal.timeout(2000)})).status;}catch{return 0;}},(s)=>s===200,20_000);
    expect((await stack.request('GET','/api/v1/me',undefined,{token})).status).toBe(401);
    const marker = `task13-file-${randomBytes(24).toString('hex')}`;
    stack.sentinels.push(marker);
    stack.file('malformed-key',marker);
    stack.file('fault-input',JSON.stringify({sentinel:marker}));
    const image = process.env.TASK13_GATEWAY_RUNTIME_IMAGE ?? 'infrapulse-task13-gateway:runtime';
    const args = ['run','--rm','--network','none','-e','PYTHONPATH=/app','--read-only','--tmpfs','/tmp','--cap-drop','ALL','--security-opt','no-new-privileges:true','--label',`infrapulse.test.run_id=${stack.db.runId}`];
    for (const [name,target] of [['malformed-key','malformed-key'],['fault-input','fault-input'],['gateway-signing-key','signing-key']])
      args.push('--mount',`type=bind,src=${resolve(stack.db.privateDir,name)},dst=/run/test/${target},readonly`);
    args.push('--mount',`type=bind,src=${resolve(import.meta.dirname,'../support/scripts/task13_faults.py')},dst=/run/test/faults.py,readonly`,image,'python','/run/test/faults.py');
    expect(stack.docker(args,'actual-python-key-httpx-timeout').includes('task13_actual_key_socket_timeout_faults_ok')).toBe(true);
    // Actual Node startup sanitizes the missing database secret failure first;
    // malformed Node trust parsing is not reached or separately probed here.
    const node = `import {loadConfig} from './dist/config/config.js'; try {loadConfig({MANAGEMENT_DATABASE_URL_FILE:'/run/test/missing',MANAGEMENT_ADMIN_TRUST_FILE:'/run/test/malformed',MANAGEMENT_SERVICE_TRUST_FILE:'/run/test/malformed',MANAGEMENT_GRAFANA_CONTEXT:'task13'});process.exitCode=2;}catch(e){console.error(e.message);console.log('task13_node_secret_failure_ok');}`;
    const output = stack.docker(['run','--rm','--network','none','--read-only','--tmpfs','/tmp','--cap-drop','ALL','--security-opt','no-new-privileges:true','--label',`infrapulse.test.run_id=${stack.db.runId}`,'--mount',`type=bind,src=${resolve(stack.db.privateDir,'malformed-key')},dst=/run/test/malformed,readonly`,process.env.TASK13_MANAGEMENT_RUNTIME_IMAGE ?? 'infrapulse-task13-management:runtime','node','--input-type=module','-e',node],'actual-node-secret-file');
    expect(output.includes('task13_node_secret_failure_ok')).toBe(true);
    // SQL timeout is real, bounded, and exception text is captured by the native
    // runtime command rather than dumped through a shell stderr pipe.
    const sql = `import fs from 'node:fs';import pg from 'pg';const db=new pg.Client({connectionString:fs.readFileSync('/run/test/url','utf8').trim(),connectionTimeoutMillis:1000,statement_timeout:20});try{await db.connect();try{await db.query('SELECT pg_sleep(0.1)');process.exitCode=2;}catch(e){if(e.code!=='57014')process.exitCode=3;console.error(e.message);console.log('task13_sql_timeout_ok');}}catch{process.exitCode=4;}finally{await db.end();}`;
    const timeout = stack.docker(['run','--rm','--network',`${stack.db.project}_database`,'--read-only','--tmpfs','/tmp','--cap-drop','ALL','--security-opt','no-new-privileges:true','--label',`infrapulse.test.run_id=${stack.db.runId}`,'--mount',`type=bind,src=${resolve(stack.db.privateDir,'runtime-network-url')},dst=/run/test/url,readonly`,process.env.TASK13_MANAGEMENT_RUNTIME_IMAGE ?? 'infrapulse-task13-management:runtime','node','--input-type=module','-e',sql],'actual-sql-timeout');
    expect(timeout.includes('task13_sql_timeout_ok')).toBe(true);
    expect(performance.now()-began).toBeLessThan(120_000);
  });

  it('captures actual loopback Swagger and test-only proxy validation/transport paths with runtime sentinels', async () => {
    const began = performance.now();
    const marker = `task13-proxy-${randomBytes(24).toString('hex')}`;
    stack.sentinels.push(marker);
    const owner = await stack.createOwner();
    await stack.assign(owner);
    const result = await stack.swaggerProxy(owner, marker);
    expect(result).toMatchObject({swagger_html_status:200,swagger_init_status:200,swagger_operations_present:true,proxy_validation_status:400,proxy_query_status:400,proxy_auth_status:401,proxy_agent_status:200,proxy_transport_status:503});
    expect(result.proxy_events).toBe(7);
    expect(performance.now()-began).toBeLessThan(120_000);
  });
});
