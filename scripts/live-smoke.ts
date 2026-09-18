import { createServer } from 'node:http';
import { mkdir,writeFile } from 'node:fs/promises';
import { TaskManager } from '../src/engine.js';
import { TaskStore } from '../src/store.js';
import { loadConfig } from '../src/config.js';

loadConfig();
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<!doctype html><html lang="en"><head><title>JEV local smoke test</title></head><body><main><h1>Product search</h1><form><label>Product name <input id="q"></label><label><input id="available" type="checkbox">Only available</label><button>Search</button></form><section id="result" aria-label="Search results"></section></main><script>document.querySelector('form').onsubmit=e=>{e.preventDefault();const q=document.querySelector('#q').value;if(q==='Orion'&&document.querySelector('#available').checked)document.querySelector('#result').innerHTML='<article><h2>Orion</h2><p>Available. Price: 42.</p><a href="/orion">Product details</a></article><p role="status">Search applied: Orion, available only</p>';else document.querySelector('#result').textContent='No matching result. Enter Orion and enable Only available.';};</script></body></html>`);});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${(server.address() as any).port}`;
const manager=new TaskManager(new TaskStore('artifacts/live-tasks'));
let last='';manager.on('change',id=>{const t=manager.get(id);const line=`${t.status}: ${t.message}`;if(line!==last){console.log(line);last=line;}});
try{
  const task=await manager.start({goal:'Search for the product Orion, enable Only available, and submit the search. Save the matching product card as evidence. Finish once the applied search and saved card are confirmed. Do not open the product detail link.',url,headless:true,
    values:[{label:'Product name',text:'Orion'}],checks:[{kind:'text_contains',value:'Search applied: Orion, available only'},{kind:'collected_count',value:'1'}],maxSteps:14,maxSeconds:120});
  while(manager.get(task.id).status==='running') await new Promise(r=>setTimeout(r,200));
  const result=manager.get(task.id);
  const report={id:result.id,status:result.status,message:result.message,steps:result.steps,requests:result.requests,elapsedMs:result.elapsedMs,reportedCost:result.cost,inputTokens:result.inputTokens,verification:result.verification,history:result.history,evidence:result.evidence};
  await mkdir('artifacts',{recursive:true});await writeFile('artifacts/live-smoke.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify({status:result.status,steps:result.steps,requests:result.requests,elapsedMs:result.elapsedMs,reportedCost:result.cost,verification:result.verification},null,2));
  if(result.status!=='completed') process.exitCode=1;
}finally{await manager.shutdown();await new Promise<void>(r=>server.close(()=>r()));}
