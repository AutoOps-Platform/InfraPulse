import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { resolve } from 'node:path';
import { IsolatedStack, poll } from '../support/stack-harness.js';

// No stack, key generation, filesystem or socket effects during collection.
const opted = process.env.INFRAPULSE_RUN_MANAGEMENT_E2E === '1';
describe.skipIf(!opted)('Task13 real Python -> Nest -> primary DB -> Prometheus', () => {
  let stack: IsolatedStack;
  beforeAll(async () => { stack = new IsolatedStack(); await stack.start(); });
  afterAll(async () => { if (stack?.db) { try { if (stack.isReady) await stack.scan(); } finally { await stack.close(); } } });

  it('binds real Admin/Agent/service identities, canonical profile, stored sample and receipt clock; refuses spoofing for full windows', async () => {
    const began = performance.now();
    expect((await stack.request('POST', '/api/v1/servers', {}, {role:'Viewer'})).status).toBe(403);
    expect((await stack.request('POST', '/api/v1/servers', {}, {kind:'service'})).status).toBe(404); // source policy conceals user-route family from service principals
    const owner = await stack.createOwner();
    const profile = await stack.assign(owner);
    const provisioning = await stack.request('GET', '/api/v1/agent/provisioning', undefined, {agentKey:owner.key});
    expect(provisioning.status).toBe(200);
    expect(provisioning.headers.get('cache-control')).toBe('no-store');
    expect(provisioning.body.profile).toMatchObject({version_id:profile.version,config:profile.config});
    // Independent canonicalizer, not profileChecksum from the implementation.
    expect(profile.checksum).toBe(createHash('sha256').update(canonicalize(profile.config)!).digest('hex'));
    expect(provisioning.body.ingestion.identity_headers).toEqual({'X-Server-ID':owner.server,'X-Agent-ID':owner.agent});
    const before = await stack.sql('SELECT lifecycle,last_metric_seen_at,last_applied_profile_version_id FROM management.agents WHERE id=$1',[owner.agent]);
    expect(before[0]).toMatchObject({lifecycle:'active',last_metric_seen_at:null,last_applied_profile_version_id:null});
    const neverSeen = await stack.request('GET',`/api/v1/agents/${owner.agent}`);
    expect(neverSeen.body.telemetry.status).toBe('Unknown');
    const sentAt = Date.now();
    const accepted = stack.send(owner); // independent scalar42.25/backdated sample; no identity claims/labels
    expect(accepted.status).toBe(204);
    const vector = await poll(() => stack.vector(stack.query(accepted.runId)), (v) => v.length > 0);
    expect(vector).toHaveLength(1);
    expect(vector[0].metric).toEqual({__name__:'infrapulse_e2e_value',run_id:accepted.runId,server_id:owner.server,agent_id:owner.agent});
    expect(Number(vector[0].value[1])).toBe(42.25);
    const timestamps = await stack.vector(`timestamp(${stack.query(accepted.runId)})`);
    expect(Number(timestamps[0].value[1])).toBeCloseTo(accepted.timestampMs / 1000, 4);
    const matching = stack.send(owner,{claim:'matching',labels:'matching',value:43.25});
    expect(matching.status).toBe(204);
    expect((await poll(() => stack.vector(stack.query(matching.runId)), (v) => v.length > 0))[0].metric.agent_id).toBe(owner.agent);
    const status = await poll(() => stack.request('GET',`/api/v1/agents/${owner.agent}`), (r) => r.status === 200 && r.body.telemetry.status === 'Online', 25_000);
    expect(status.body.telemetry.confidence_reason).toBe('recent_success');
    expect(Date.parse(status.body.telemetry.last_metric_seen_at)).toBeGreaterThanOrEqual(sentAt - 1000);
    expect(Date.parse(status.body.telemetry.last_metric_seen_at)).toBeGreaterThan(accepted.timestampMs + 50_000);
    expect(status.body.telemetry.status_as_of).toMatch(/Z$/);
    const rows = await stack.sql(`SELECT a.server_id,a.last_applied_profile_version_id,c.agent_id FROM management.agents a JOIN management.api_credentials c ON c.agent_id=a.id WHERE a.id=$1 AND c.id=$2`,[owner.agent,owner.credential]);
    expect(rows[0]).toMatchObject({server_id:owner.server,agent_id:owner.agent,last_applied_profile_version_id:null});
    const audits = await stack.sql('SELECT actor_kind,actor_issuer,actor_subject,outcome FROM management.audit_logs WHERE resource_id=$1',[owner.server]);
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.every((r) => r.actor_kind === 'user' && r.actor_issuer === stack.context && r.actor_subject === stack.subject && r.outcome === 'success')).toBe(true);
    const nonce = await stack.sql('SELECT count(*)::int AS n FROM management.request_nonces');
    expect(nonce[0].n).toBeGreaterThan(0);
    const conflictHeader = stack.send(owner,{claim:'conflict'});
    const conflictLabels = stack.send(owner,{labels:'conflict'});
    expect(conflictHeader.status).toBe(403);
    expect(conflictLabels.status).toBe(400);
    await Promise.all([stack.absent(conflictHeader.runId),stack.absent(conflictLabels.runId)]);
    stack.capture('real-flow-result',JSON.stringify({trusted_ids:{server_id:owner.server,agent_id:owner.agent},value:42.25,sample_timestamp_ms:accepted.timestampMs,elapsed_ms:performance.now()-began}));
    expect(performance.now()-began).toBeLessThan(120_000);
  });

  it('runs all five retained Gateway real E2E cases with the issued credential', async () => {
    const owner = await stack.createOwner();
    const gateway = resolve(import.meta.dirname,'../../../ingestion-gateway');
    const fixture = stack.file('gateway-e2e-credential.private',JSON.stringify({api_key:owner.key,server_id:owner.server,agent_id:owner.agent}));
    const python = process.env.TASK13_PYTHON ?? (process.platform === 'win32' ? resolve(gateway,'.venv/Scripts/python.exe') : 'python');
    const output = stack.command(python,['-m','pytest','tests/e2e/test_remote_write.py','-q','-s','--basetemp',resolve(stack.db.privateDir,'gateway-e2e-pytest')],'retained-gateway-five-e2e',{
      ...process.env,INFRAPULSE_RUN_E2E:'1',E2E_CREDENTIAL_FILE:fixture,E2E_GATEWAY_URL:stack.gatewayUrl,E2E_PROMETHEUS_URL:stack.prometheusUrl,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',
    },110_000);
    expect(output.includes('5 passed')).toBe(true);
  });

  it('uses committed revoke time, allows only bounded warm-cache window and proves post-bound refusal has no forward for30s', async () => {
    const began = performance.now();
    const target = await stack.createOwner();
    expect(stack.send(target).status).toBe(204); // warm whole-key cache
    const revoke = await stack.request('POST',`/api/v1/credentials/${target.credential}/revoke`,{});
    expect(revoke.status).toBe(204);
    const commit = (await stack.sql('SELECT revoked_at,clock_timestamp() AS observed_at FROM management.api_credentials WHERE id=$1',[target.credential]))[0];
    expect(commit.revoked_at).toBeInstanceOf(Date);
    // DB observed_at is after API commit; waiting beyond it is conservative.
    const deadline = commit.observed_at.getTime()+30_050;
    const initially = stack.send(target);
    expect([204,401]).toContain(initially.status);
    await poll(async () => {
      const decision = stack.send(target);
      if (Date.now() >= deadline) return decision.status;
      return 0;
    }, (status) => status === 401, 35_000);
    const rejected = stack.send(target);
    expect(rejected.status).toBe(401);
    await stack.absent(rejected.runId);
    const audit = await stack.sql("SELECT count(*)::int AS n FROM management.audit_logs WHERE resource_id=$1 AND operation='revoke' AND actor_subject=$2",[target.credential,stack.subject]);
    expect(audit[0].n).toBe(1);
    stack.capture('revoke-bound',JSON.stringify({credential_id:target.credential,revoked_at:commit.revoked_at.toISOString(),commit_observed_at:commit.observed_at.toISOString(),post_bound_status:rejected.status,elapsed_ms:performance.now()-began}));
    expect(performance.now()-began).toBeLessThan(120_000);
  });

  it('fails closed with cold/expired cache on isolated control outage, distinguishes liveness/readiness, and recovers Unknown to reliable', async () => {
    const began = performance.now();
    const live = await stack.createOwner(), cold = await stack.createOwner();
    const short = await stack.createOwner(new Date(Date.now()+12_000).toISOString());
    expect(stack.send(live).status).toBe(204);
    expect(stack.send(short).status).toBe(204);
    const wrongKey = live.key.slice(0,-1)+(live.key.endsWith('A')?'B':'A');
    stack.addCredential(wrongKey);
    expect(stack.send(live,{key:wrongKey}).status).toBe(401);
    await poll(() => stack.request('GET',`/api/v1/agents/${live.agent}`), (r) => r.body.telemetry.status === 'Online',25_000);
    await stack.sql('SELECT clock_timestamp()');
    stack.docker(stack.composeArgs('stop','--timeout','2','management'),'owned-management-outage',10_000);
    let liveCacheStatus = 0;
    try {
      expect(await stack.health('/health/live')).toBe(200);
      expect(await stack.health('/health/ready')).toBe(503);
      const probe = "import urllib.request,json,time; s=time.monotonic(); ok=False; error=None\ntry:\n r=urllib.request.urlopen('http://prometheus:9090/-/ready',timeout=2); ok=r.status==200\nexcept Exception as e: error=type(e).__name__\nprint(json.dumps({'prometheus_ready':ok,'error_class':error,'elapsed_ms':(time.monotonic()-s)*1000}))";
      const forwardHealth = JSON.parse(stack.docker(['exec',`${stack.db.project}-ingest-1`,'python','-c',probe],'outage-forward-dependency-health',5000));
      expect(forwardHealth.prometheus_ready).toBe(true);
      liveCacheStatus = stack.send(live).status;
      stack.capture('outage-live-cache-result',JSON.stringify({status:liveCacheStatus,forward_dependency_ready:forwardHealth.prometheus_ready}));
      // Preserve the204 requirement, but assert it after independent observations
      // so a transport failure cannot conceal cold/expired/recovery evidence.
      const unavailable = stack.send(cold);
      expect(unavailable.status).toBe(503);
      // Repeated real requests are bounded observations, not sleeps as proof.
      await Promise.all([
        poll(async () => stack.send(short).status, (s) => s === 503,18_000),
        poll(async () => stack.send(live).status, (s) => s === 503,35_000),
        stack.absent(unavailable.runId),
      ]);
    } finally {
      stack.docker(stack.composeArgs('start','management'),'owned-management-recover',10_000);
      stack.refreshManagementPort();
      await poll(async () => {try{return (await fetch(stack.managementUrl+'/health/ready',{signal:AbortSignal.timeout(2000)})).status;}catch{return 0;}},(s)=>s===200,20_000);
    }
    // More than30s source loss must not project false Offline on recovery.
    const unknown = await stack.request('GET',`/api/v1/agents/${live.agent}`);
    expect(unknown.body.telemetry.status).toBe('Unknown');
    expect(stack.send(short).status).toBe(401); // actual finite credential expiry, not clock mock
    expect(stack.send(live).status).toBe(204);
    expect(stack.send(cold).status).toBe(204);
    await poll(() => stack.request('GET',`/api/v1/agents/${live.agent}`),(r)=>r.body.telemetry.status==='Online',25_000);
    expect(await stack.health('/health/ready')).toBe(200);
    expect(performance.now()-began).toBeLessThan(120_000);
    stack.capture('outage-recovery-result',JSON.stringify({recovered:true,short_expiry:true,live_cache_status:liveCacheStatus,elapsed_ms:performance.now()-began}));
    expect(liveCacheStatus).toBe(204);
  });
});
