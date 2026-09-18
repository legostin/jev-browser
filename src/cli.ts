import { readFile } from 'node:fs/promises';
import { defaultConfidence } from './schema.js';
import { loadConfig } from './config.js';
import { ensureService, existingService, readService, serviceCall, serviceDirectory } from './service-client.js';

loadConfig();
const command=process.argv[2]||'serve';
async function stopService() {
  const service=await existingService();if(!service)return;
  await serviceCall(service,'shutdown');
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){if((await readService())?.instance!==service.instance)return;await new Promise(r=>setTimeout(r,100));}
  throw new Error('Service is still stopping. Inspect status before restarting.');
}
try {
  if(command==='doctor') {
    const service=await existingService();
    console.log(JSON.stringify({node:process.versions.node,configured:!!process.env.OPENROUTER_API_KEY,
      minConfidence:defaultConfidence(),model:process.env.JEV_MODEL||'typesafe/jev-1.13',service:service?{pid:service.pid,release:service.release}:null,data:serviceDirectory()},null,2));
  } else if(command==='service') {
    const action=process.argv[3]||'status';
    if(!['status','start','stop','restart'].includes(action))throw new Error('Usage: jev service start|status|stop|restart');
    if(action==='stop'||action==='restart')await stopService();
    const service=action==='start'||action==='restart'?await ensureService():await existingService();
    console.log(JSON.stringify(service?{running:true,pid:service.pid,release:service.release,dashboard:service.url}:{running:false},null,2));
  } else if(command==='serve'||command==='run') {
    if(command==='run'&&!process.argv[3])throw new Error('Usage: jev run task.json');
    const service=await ensureService();
    console.log(`JEV Browser: ${service.url}`);
    if(command==='run')console.log(JSON.stringify(await serviceCall(service,'run',JSON.parse(await readFile(process.argv[3],'utf8')),process.env.JEV_SESSION_ID||'cli'),null,2));
  } else throw new Error('Usage: jev [serve | doctor | run task.json | service start|status|stop|restart]');
} catch(error){console.error(error instanceof Error?error.message:'JEV command failed.');process.exitCode=1;}
