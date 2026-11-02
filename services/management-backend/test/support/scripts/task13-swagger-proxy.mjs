// Test-only loopback app/proxy qualifier, mounted into an isolated runtime operation.
// No public signer, production proxy, new trust policy or secret-bearing argv.
import {readFileSync} from 'node:fs';
import {createServer,request as httpRequest} from 'node:http';
import {createManagementApp} from '/app/dist/bootstrap.js';
import {loadConfig} from '/app/dist/config/config.js';
import {installOpenApi} from '/app/dist/common/openapi.js';
const deadline=setTimeout(()=>{console.error('task13_swagger_proxy_deadline');process.exit(1);},20_000);
const listen=server=>new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
const close=server=>new Promise(done=>server.close(done));
let app,proxy;
let proxyEvents=0,closedPort=0;
try {
  const input=JSON.parse(readFileSync('/run/test/input','utf8'));
  app=await createManagementApp(loadConfig(process.env));
  // Explicitly enable the real Swagger middleware only in this private, temporary
  // loopback fixture. The production runtime's default docs remain disabled.
  installOpenApi(app,{enabled:true,listenHost:'127.0.0.1'});
  await app.listen(0,'127.0.0.1');
  const port=app.getHttpServer().address().port;
  proxy=createServer((incoming,response)=>{
    const fault=incoming.url.startsWith('/__task13_fault');
    const route=fault?'fault':incoming.url.startsWith('/docs')?'docs':'api';
    let completed=false;
    const record=(status,error_class=null)=>{
      if(completed)return;completed=true;proxyEvents++;
      console.log(JSON.stringify({event:'task13_proxy_result',route,status,error_class}));
    };
    const outgoing=httpRequest({hostname:'127.0.0.1',port:fault?closedPort:port,method:incoming.method,path:incoming.url,headers:incoming.headers,timeout:2000},upstream=>{
      response.writeHead(upstream.statusCode,upstream.headers);
      upstream.pipe(response);upstream.once('end',()=>record(upstream.statusCode));
    });
    outgoing.once('timeout',()=>outgoing.destroy());
    outgoing.once('error',error=>{
      record(503,error.code==='ECONNREFUSED'?'ECONNREFUSED':'TRANSPORT_ERROR');
      if(!response.headersSent)response.writeHead(503,{'content-type':'application/json'});
      response.end('{"code":"dependency_unavailable"}');
    });
    incoming.pipe(outgoing);
  });
  await listen(proxy);
  const reserved=createServer();await listen(reserved);closedPort=reserved.address().port;await close(reserved);
  const origin=`http://127.0.0.1:${proxy.address().port}`;
  const call=async(name,path,options={})=>{
    const response=await fetch(origin+path,{...options,signal:AbortSignal.timeout(3000),redirect:'manual'});
    const body=await response.text();
    // Raw responses stay exclusively in the native private FD capture for scanning.
    console.log(JSON.stringify({event:'task13_swagger_proxy_capture',part:name,status:response.status,body}));
    return {status:response.status,body};
  };
  const html=await call('swagger-html','/docs/');
  const init=await call('swagger-init','/docs/swagger-ui-init.js?marker='+input.marker);
  const validation=await call('proxy-malformed','/api/v1/servers',{method:'POST',headers:{authorization:'Bearer '+input.bad_assertion,'content-type':'application/json'},body:input.bad_json});
  const query=await call('proxy-query',input.query_target,{headers:{authorization:'Bearer '+input.query_assertion}});
  const auth=await call('proxy-auth','/api/v1/me',{headers:{authorization:'Bearer '+input.agent_key,'x-task13-sensitive':input.marker}});
  const agent=await call('proxy-agent','/api/v1/agent/provisioning',{headers:{authorization:'Bearer '+input.agent_key}});
  const fault=await call('proxy-transport','/__task13_fault?private='+input.marker,{headers:{authorization:'Bearer '+input.agent_key}});
  console.log(JSON.stringify({event:'task13_swagger_proxy_summary',swagger_html_status:html.status,swagger_init_status:init.status,swagger_operations_present:init.body.includes('/api/v1/servers')&&init.body.includes('SwaggerUIBundle'),proxy_validation_status:validation.status,proxy_query_status:query.status,proxy_auth_status:auth.status,proxy_agent_status:agent.status,proxy_transport_status:fault.status,proxy_events:proxyEvents}));
} catch {
  console.error('task13_swagger_proxy_failed');process.exitCode=1;
} finally {
  clearTimeout(deadline);
  if(proxy)await close(proxy);
  if(app)await app.close();
}
