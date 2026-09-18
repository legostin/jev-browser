import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TaskManager } from '../src/engine.js';
import { TaskStore } from '../src/store.js';
import { BrowserAdapter } from '../src/browser.js';
import { ServiceAPI } from '../src/service-api.js';
import { serviceCall } from '../src/service-client.js';
import type { Snapshot } from '../src/schema.js';
const snapshot:Snapshot={version:'v',observedAt:'now',pageId:'p',url:'https://example.test',title:'Test',nodes:[],frames:[],tabs:[],limitations:[]};
class FakeBrowser extends BrowserAdapter {async open(){}async observe(){return snapshot;}async close(){}}
test('service isolates current tasks, denies cross-owner changes and serializes concurrent starts',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'jev-api-'));
  const manager=new TaskManager(new TaskStore(dir),{async choose(p){return {action:p.actions.find(a=>a.op==='blocked')!,confidence:1,probabilities:{},latencyMs:0,usage:{inputTokens:0,cost:0}};},async text(){throw new Error('unused');}},()=>new FakeBrowser());
  const api=new ServiceAPI(manager,'http://localhost/');const input={goal:'Test',url:snapshot.url,browser:'isolated',waitMs:0};
  try {
    const [a,b]=await Promise.all([api.call('run',input,'alpha'),api.call('run',input,'beta')]);assert.notEqual(a.id,b.id);
    await Promise.all([manager.wait(a.id,1000),manager.wait(b.id,1000)]);
    assert.equal((await api.call('status',{},'alpha')).currentTaskId,a.id);assert.equal((await api.call('status',{},'beta')).tasks.length,1);
    await assert.rejects(api.call('resume',{id:a.id,patch:{goal:'Hijack'}},'beta'),/another conversation/);
    assert.equal((await api.call('run',input,'alpha')).id,a.id);await manager.wait(a.id,1000);assert.equal(manager.tasks.size,2);
    await manager.shutdown();const restored=new TaskManager(new TaskStore(dir));await restored.init();assert.equal(restored.currentFor('alpha'),a.id);assert.equal(restored.currentFor('beta'),b.id);await restored.shutdown();
  }finally{await manager.shutdown();await rm(dir,{recursive:true,force:true});}
});

test('concurrent MCP clients share one daemon; reconnect preserves live page and task ownership', {timeout:60000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'jev-daemon-'));let visits=0,edit=false;
  const fixture=createServer((req,res)=>{if(req.url==='/state'){res.end(edit?'after reconnect':'initial');return;}if(req.url==='/favicon.ico'){res.writeHead(204);res.end();return;}visits++;res.setHeader('Content-Type','text/html');res.end('<label>Live value<input id="live"></label><script>setInterval(async()=>{document.querySelector("input").value=await (await fetch("/state")).text()},100)</script>');});
  await new Promise<void>(r=>fixture.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(fixture.address() as any).port}`;
  const clients:Client[]=[];let service:any;
  async function connect(session:string){const client=new Client({name:'daemon-test',version:'1.0.0'});clients.push(client);await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/mcp.js',import.meta.url))],env:{...Object.fromEntries(Object.entries(process.env).filter((x):x is [string,string]=>typeof x[1]==='string')),JEV_DATA_DIR:dir,JEV_EPHEMERAL:'0',JEV_SESSION_ID:session,JEV_CONFIG_FILE:join(dir,'no-config'),OPENROUTER_API_KEY:'',JEV_CDP_URL:'',JEV_AUTO_UPDATE:'0'}}));return client;}
  async function call(c:Client,name:string,args:any={}){const reply=await c.callTool({name,arguments:args});if(reply.isError)throw new Error((reply.content as any)[0].text);return JSON.parse((reply.content as any)[0].text);}
  try {
    const [a,b]=await Promise.all([connect('alpha'),connect('beta')]);
    const [sa,sb]=await Promise.all([call(a,'jev_status'),call(b,'jev_status')]);assert.equal(sa.service.pid,sb.service.pid);assert.equal(sa.dashboard,sb.dashboard);
    service=JSON.parse(await readFile(join(dir,'service/endpoint.json'),'utf8'));assert.equal((await stat(join(dir,'service/endpoint.json'))).mode&0o777,0o600);
    const rpcURL=new URL('/internal/rpc',service.url);assert.equal((await fetch(rpcURL,{method:'POST',headers:{'x-jev-token':new URL(service.url).hash.slice(1),'Content-Type':'application/json'},body:'{}'})).status,403);
    const task=await call(a,'jev_run',{goal:'Inspect form',url,browser:'isolated',headless:true,waitMs:25000});assert.equal(task.status,'needs_review');
    const before=await call(a,'jev_inspect',{id:task.id});assert.ok(before.nodes.some((n:any)=>n.name==='Live value'));
    await a.close();edit=true;
    const next=await connect('alpha');const reconnected=await call(next,'jev_status');assert.equal(reconnected.service.pid,sa.service.pid);assert.equal(reconnected.currentTaskId,task.id);
    let after:any;for(let i=0;i<15;i++){after=await call(next,'jev_inspect',{id:task.id});if(after.nodes.some((n:any)=>n.value==='after reconnect'))break;await new Promise(r=>setTimeout(r,100));}
    assert.ok(after.nodes.some((n:any)=>n.value==='after reconnect'));assert.equal(visits,1);assert.equal(after.nodes.find((n:any)=>n.name==='Live value').id,before.nodes.find((n:any)=>n.name==='Live value').id);
    await assert.rejects(call(b,'jev_task',{id:task.id}),/another conversation/);assert.equal((await call(b,'jev_status')).tasks.length,0);
    await call(next,'jev_cancel',{id:task.id});
    // A crashed daemon leaves its owner file; the next client must reclaim it safely.
    const previousInstance=service.instance;process.kill(service.pid,'SIGKILL');
    for(let i=0;i<100;i++){try{process.kill(service.pid,0);}catch{break;}await new Promise(r=>setTimeout(r,50));}
    const recovered=await call(next,'jev_status');assert.notEqual(recovered.service.instance,previousInstance);
    service=JSON.parse(await readFile(join(dir,'service/endpoint.json'),'utf8'));
    assert.equal(recovered.currentTaskId,task.id);assert.equal((await call(next,'jev_task',{id:task.id})).status,'cancelled');
  }finally{
    await Promise.all(clients.map(c=>c.close().catch(()=>{})));
    service??=JSON.parse(await readFile(join(dir,'service/endpoint.json'),'utf8').catch(()=> 'null'));
    if(service){await serviceCall(service,'shutdown').catch(()=>{});for(let i=0;i<100;i++){try{await stat(join(dir,'service/endpoint.json'));}catch{break;}await new Promise(r=>setTimeout(r,50));}await assert.rejects(stat(join(dir,'service/endpoint.json')));}
    await new Promise<void>(r=>fixture.close(()=>r()));await rm(dir,{recursive:true,force:true});
  }
});
