import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { TaskManager } from './engine.js';
import { dashboard } from './http.js';
import { ServiceAPI } from './service-api.js';
import { loadConfig } from './config.js';
import { atomic, claimService, releaseService, serviceDirectory } from './service-client.js';
loadConfig();
const instance=randomUUID();
if(!await claimService(instance))process.exit(0);
const manager=new TaskManager();
let panel:Awaited<ReturnType<typeof dashboard>>|undefined,api:ServiceAPI,stopping=false,accepting=true;
async function shutdown(){if(stopping)return;stopping=true;await manager.shutdown();await panel?.close();await releaseService(instance);process.exit(0);}
try {
  await manager.init();
  const identity={pid:process.pid,instance,protocol:1 as const,release:fileURLToPath(new URL('../../',import.meta.url))};
  const rpcToken=randomBytes(24).toString('hex');
  panel=await dashboard(manager,0,{token:rpcToken,serial:work=>api.serial(async()=>{if(!accepting)throw new Error('JEV service is stopping.');return work();}),call:async(method,args,sessionId,signal)=>{
    if(!accepting)throw new Error('JEV service is stopping.');
    if(method==='shutdown'){
      return api.serial(async()=>{
        if(manager.list().some(t=>t.status==='running'))throw new Error('Pause running tasks before stopping the service.');
        accepting=false;api.stopAccepting();setTimeout(()=>void shutdown(),100);return {stopping:true};
      });
    }
    return api.call(method,args,sessionId,signal);
  }});
  api=new ServiceAPI(manager,panel.url,identity);
  await atomic(join(serviceDirectory(),'endpoint.json'),{...identity,url:panel.url,rpcToken});
  process.on('SIGTERM',()=>void shutdown());process.on('SIGINT',()=>void shutdown());
} catch {await panel?.close();await releaseService(instance);console.error('JEV service startup failed. Verify configuration and local runtime permissions.');process.exit(1);}
