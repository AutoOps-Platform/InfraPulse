// Preload for an actual default E2E command. Vitest's file/worker machinery is
// allowed; all network and Docker lifecycle are forbidden before suite opt-in.
import net from 'node:net';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
let networkCalls=0,composeChanges=0;
net.Socket.prototype.connect=function(){networkCalls++;throw new Error('Offline E2E attempted network I/O.');};
globalThis.fetch=async()=>{networkCalls++;throw new Error('Offline E2E attempted fetch.');};
for(const method of ['spawn','spawnSync','execFile','execFileSync']){
  const original=childProcess[method];
  childProcess[method]=function(command,...args){
    if(String(command).toLowerCase().includes('docker')){composeChanges++;throw new Error('Offline E2E attempted Docker.');}
    return original.call(this,command,...args);
  };
}
syncBuiltinESMExports();
process.on('exit',()=>{
  console.log(JSON.stringify({event:'task13_offline_probe',networkCalls,composeChanges}));
  if(networkCalls||composeChanges)process.exitCode=1;
});
