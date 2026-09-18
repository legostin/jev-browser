import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { TaskManager } from '../src/engine.js';
import { TaskStore } from '../src/store.js';
import { BrowserAdapter } from '../src/browser.js';
import type { DecisionProvider } from '../src/model.js';
import type { Projection, TaskRecord, Action, Snapshot } from '../src/schema.js';
const usage={inputTokens:10,cost:null};
const controller=new AbortController();
async function stopped(m:TaskManager,id:string){const end=Date.now()+20000;while(m.get(id).status==='running'){if(Date.now()>end)throw new Error('Task timed out in test');await new Promise(r=>setTimeout(r,40));}return m.get(id);}
function choice(p:Projection,a:Action){return {action:a,confidence:.98,probabilities:{[a.id]:1},latencyMs:1,usage};}

test('a complete autonomous chain fills, searches, collects and independently verifies in a real browser',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'jev-engine-'));
  const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<html><body><main><form><label>Search<input id="q"></label><button>Find</button></form><div id="results"></div></main><script>document.querySelector('form').onsubmit=e=>{e.preventDefault();document.querySelector('#results').innerHTML='<article><h2>'+document.querySelector('#q').value+'</h2><p>Verified fixture result</p><a href="/listing">Details</a></article>';}</script></body></html>`);});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(server.address() as any).port}`;
  const provider:DecisionProvider={
    async choose(p,t){
      const field=p.nodes.find(n=>n.role==='textbox');
      const article=p.nodes.find(n=>n.role==='article');
      let action:Action|undefined;
      if(field&&!field.value)action=p.actions.find(a=>a.op==='fill'&&a.target===field.id);
      else if(!t.snapshot!.nodes.some(n=>n.text==='Verified fixture result'))action=p.actions.find(a=>a.op==='click'&&p.nodes.find(n=>n.id===a.target)?.name==='Find');
      else if(!t.evidence.length&&article)action=p.actions.find(a=>a.op==='collect'&&a.target===article.id);
      else if(t.evidence.length)action=p.actions.find(a=>a.op==='done');
      action??=p.actions.find(a=>a.op==='inspect_next');assert.ok(action,'Fixture action must be discoverable');return choice(p,action);
    },
    async text(){return {text:'Toyota Camry 2026',usage};}
  };
  const m=new TaskManager(new TaskStore(dir),provider);await m.init();
  try{
    const task=await m.start({browser:'isolated',goal:'Find and save Toyota Camry 2026',url,headless:true,checks:[{kind:'text_contains',value:'Verified fixture result'},{kind:'collected_count',value:'1'}]});
    const done=await stopped(m,task.id);assert.equal(done.status,'completed',done.message);assert.equal(done.evidence.length,1);
    assert.ok(done.history.some(h=>h.op==='fill'&&h.outcome==='executed'));assert.ok(done.history.some(h=>h.op==='click'&&h.outcome==='executed'));assert.ok(done.verification?.passed);
    await m.shutdown();const loaded=await new TaskStore(dir).load();assert.equal(loaded[0].evidence.length,1);assert.deepEqual(loaded[0].browserMemory,JSON.parse(JSON.stringify(done.browserMemory)));
    const fill=done.history.find(h=>h.op==='fill'&&h.outcome==='executed')!;assert.equal(fill.context?.enteredText,'Toyota Camry 2026');assert.equal(fill.context?.observed?.field?.after,'Toyota Camry 2026');
  }finally{await m.shutdown();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});

const blank:Snapshot={version:'v1',observedAt:new Date().toISOString(),pageId:'p',url:'https://example.test',title:'Test',tabs:[],frames:[],nodes:[],limitations:[]};
class FakeBrowser extends BrowserAdapter {actions=0;async open(){}async observe(){return blank;}async act(){this.actions++;}async close(){}}
test('DONE without independent checks is a review request, not success',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'jev-done-'));
  const provider:DecisionProvider={async choose(p){return choice(p,p.actions.find(a=>a.op==='done')!);},async text(){return {text:null,usage};}};
  const m=new TaskManager(new TaskStore(dir),provider,()=>new FakeBrowser());
  try{const t=await m.start({browser:'isolated',goal:'Do something',url:blank.url});const result=await stopped(m,t.id);assert.equal(result.status,'needs_review');assert.equal(result.verification?.passed,false);}finally{await m.shutdown();await rm(dir,{recursive:true,force:true});}
});
test('pause during a model request prevents a late decision from executing',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'jev-pause-'));let release!:()=>void,entered!:()=>void;
  const ready=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);
  const browser=new FakeBrowser();
  const provider:DecisionProvider={async choose(p){entered();await wait;return choice(p,p.actions.find(a=>a.op==='wait')!);},async text(){return {text:null,usage};}};
  const m=new TaskManager(new TaskStore(dir),provider,()=>browser);
  try{const t=await m.start({browser:'isolated',goal:'Wait for results',url:blank.url});await ready;const paused=m.pause(t.id);release();await paused;assert.equal(m.get(t.id).status,'paused');assert.equal(browser.actions,0);assert.equal(m.get(t.id).steps,0);}finally{release?.();await m.shutdown();await rm(dir,{recursive:true,force:true});}
});
test('missing text creates a resumable input request and no browser mutation',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'jev-input-'));const browser=new FakeBrowser();
  const field:any={id:'n',parent:null,frame:'f',role:'textbox',name:'Query',text:'',tag:'input',source:'semantic',value:'',states:{disabled:false,readonly:false},relations:{},bounds:{x:0,y:0,width:50,height:20},inViewport:true,obscured:false,capabilities:['fill']};
  browser.observe=async()=>({...blank,nodes:[field]});
  const provider:DecisionProvider={async choose(p){return choice(p,p.actions.find(a=>a.op==='fill')!);},async text(){return {text:null,usage};}};
  const m=new TaskManager(new TaskStore(dir),provider,()=>browser);
  try{const t=await m.start({browser:'isolated',goal:'Search',url:blank.url});const r=await stopped(m,t.id);assert.equal(r.status,'needs_input');assert.equal(r.pending?.kind,'text');assert.equal(browser.actions,0);}finally{await m.shutdown();await rm(dir,{recursive:true,force:true});}
});

test('low confidence retains alternatives for review without executing',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'jev-confidence-'));const browser=new FakeBrowser();
  const provider:DecisionProvider={async choose(p){return {...choice(p,p.actions.find(a=>a.op==='wait')!),confidence:.51};},async text(){return {text:null,usage};}};
  const m=new TaskManager(new TaskStore(dir),provider,()=>browser);
  try{const t=await m.start({browser:'isolated',goal:'Wait',url:blank.url});const r=await stopped(m,t.id);assert.equal(r.status,'needs_review');assert.equal(r.steps,0);assert.equal(browser.actions,0);assert.equal(r.lastDecision?.confidence,.51);assert.equal(r.lastDecision?.alternatives[0].action.op,'wait');assert.match(r.message,/0.51 below 0.55/);}finally{await m.shutdown();await rm(dir,{recursive:true,force:true});}
});
