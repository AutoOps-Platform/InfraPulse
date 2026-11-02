// Runtime-only Ed25519 vector: no private constants, files or emitted assertions.
import {generateKeyPairSync,createHash,randomUUID} from 'node:crypto';
import {SignJWT,jwtVerify} from 'jose';
const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const method='POST', target='/api/v1/servers?name=a%2Fb', body=Buffer.from('{"sample":1e0}');
const now=Math.floor(Date.now()/1000), hash=createHash('sha256').update(body).digest('base64url');
const claims={iss:'task13-vector',aud:'task13-vector-receiver',sub:randomUUID(),kind:'user',ctx:'isolated-vector',grafana_role:'Admin',iat:now,nbf:now,exp:now+60,jti:randomUUID(),m:method,t:target,b:hash};
const assertion=await new SignJWT(claims).setProtectedHeader({alg:'EdDSA',kid:'generated-vector'}).sign(privateKey);
const verified=await jwtVerify(assertion,publicKey,{algorithms:['EdDSA'],issuer:claims.iss,audience:claims.aud});
const normalized=createHash('sha256').update('{"sample":1}').digest('base64url');
if(verified.payload.b!==hash || hash===normalized || verified.payload.t!==target) throw new Error('Runtime vector failed.');
console.log(JSON.stringify({event:'task13_runtime_vector',verified:true,raw_target_preserved:true,raw_body_sha256_base64url:hash,normalized_body_rejected:hash!==normalized,private_material_emitted:false}));
