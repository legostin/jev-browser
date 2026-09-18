import { readFile } from 'node:fs/promises';
import { TaskManager } from './engine.js';
import { dashboard } from './http.js';
import { loadConfig } from './config.js';

loadConfig();
const manager=new TaskManager();await manager.init();
const command=process.argv[2]||'serve';
if(command==='doctor') {
  console.log(JSON.stringify({node:process.versions.node,configured:!!process.env.OPENROUTER_API_KEY,
    model:process.env.JEV_MODEL||'typesafe/jev-1.13',browser:process.env.JEV_CDP_URL?'local CDP':process.env.JEV_BROWSER_CHANNEL||'chrome',data:manager.store.directory},null,2));
} else if(command==='serve'||command==='run') {
  const panel=await dashboard(manager,Number(process.env.JEV_PORT||0));
  console.log(`JEV Browser: ${panel.url}`);
  if(command==='run') {
    if(!process.argv[3]) throw new Error('Usage: npm start -- run task.json');
    const task=await manager.start(JSON.parse(await readFile(process.argv[3],'utf8')));
    console.log(`Task: ${task.id}`);
  }
  let last='';manager.on('change',id=>{const t=manager.get(id),line=`${t.id.slice(0,8)} · ${t.status} · ${t.message}`;if(line!==last){console.log(line);last=line;}});
  let stopping=false;
  const stop=async()=>{if(stopping)return;stopping=true;await manager.shutdown();await panel.close();process.exit(0);};
  process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
} else {console.error('Usage: npm start -- [serve | doctor | run task.json]');process.exitCode=1;}
