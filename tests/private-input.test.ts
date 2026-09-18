import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskManager } from '../src/engine.js';
import { TaskStore } from '../src/store.js';
import { BrowserAdapter } from '../src/browser.js';
import { dashboard } from '../src/http.js';
import { project } from '../src/projection.js';
import { modelView } from '../src/model.js';
const secret='fixture-password-do-not-persist-7582';
async function settled(manager:TaskManager,id:string) {
  const until=Date.now()+15000;
  while(manager.get(id).status==='running') {if(Date.now()>until)throw new Error('Timed out');await new Promise(r=>setTimeout(r,30));}
  return manager.get(id);
}
test('password uses private dashboard input, remains masked after reveal, then resumes the chain',async()=>{
  const data=await mkdtemp(join(tmpdir(),'jev-private-'));
  const site=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<form><label>Password<input id="password" type="password" autocomplete="section-login current-password"></label><button id="show" type="button" onclick="document.querySelector('input').type='text'">Show</button><button>Sign in</button></form><p id="status"></p><script>document.querySelector('form').onsubmit=e=>{e.preventDefault();document.querySelector('#status').textContent='Fixture signed in';}</script>`);});
  await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${(site.address() as any).port}`;
  const browser=new BrowserAdapter();
  const manager=new TaskManager(new TaskStore(data),{
    async choose(p,t){
      assert.ok(!JSON.stringify(modelView(p)).includes(secret));
      assert.ok(!JSON.stringify(t).includes(secret));
      const field=p.nodes.find(n=>n.inputType==='password'||n.autocomplete?.includes('current-password'))!;
      const action=t.snapshot?.nodes.some(n=>n.text==='Fixture signed in')?p.actions.find(a=>a.op==='done'):
        field.states.filled?p.actions.find(a=>a.op==='click'&&p.nodes.find(n=>n.id===a.target)?.name==='Sign in'):
        p.actions.find(a=>a.op==='request_secret');
      assert.ok(action);
      return {action,confidence:1,probabilities:{[action.id]:1},latencyMs:0,usage:{inputTokens:0,cost:0}};
    },async text(){throw new Error('Secret must never go through model text selection');}
  },()=>browser);
  const ui=await dashboard(manager);
  const link=new URL(ui.url),token=link.hash.slice(1);
  try {
    const t=await manager.start({goal:'Sign into fixture',url,headless:true,checks:[{kind:'text_contains',value:'Fixture signed in'}]});
    const pending=await settled(manager,t.id);
    assert.equal(pending.pending?.kind,'secret');
    const target=pending.pending!.target!;
    const field=pending.snapshot!.nodes.find(n=>n.id===target)!;
    assert.equal(field.role,'textbox');assert.equal(field.states.sensitive,true);assert.equal(field.states.filled,false);
    assert.ok(!project(pending.snapshot!).actions.some(a=>a.op==='fill'&&a.target===target));
    const endpoint=`${link.origin}/api/tasks/${t.id}/secret`;
    assert.equal((await fetch(endpoint,{method:'POST',body:JSON.stringify({target,secret})})).status,401);
    const response=await fetch(endpoint,{method:'POST',headers:{'X-Jev-Token':token,'Content-Type':'application/json'},body:JSON.stringify({target,secret})});
    assert.equal(response.status,200);assert.ok(!(await response.text()).includes(secret));
    assert.equal(await (browser as any).page.locator('#password').inputValue(),secret);
    await (browser as any).page.locator('#show').click();
    const observed=await manager.inspect(t.id);
    assert.ok(!JSON.stringify(observed).includes(secret));
    assert.equal(observed.nodes.find(n=>n.id===target)?.states.filled,true);
    assert.equal((await fetch(endpoint,{method:'POST',headers:{'X-Jev-Token':token},body:JSON.stringify({target,secret})})).status,400);
    await manager.resume(t.id);
    const done=await settled(manager,t.id);
    assert.equal(done.status,'completed',done.message);
    assert.ok(!JSON.stringify(done).includes(secret));
    const stored=await new TaskStore(data).load();
    assert.ok(!JSON.stringify(stored).includes(secret));
  } finally {await manager.shutdown();await ui.close();await new Promise<void>(r=>site.close(()=>r()));await rm(data,{recursive:true,force:true});}
});

test('private input rejects a changed page and sanitizes uncertain browser errors',async()=>{
  const data=await mkdtemp(join(tmpdir(),'jev-private-fail-'));
  let changed=false, fail=false, inputs=0;
  const field:any={id:'password',parent:null,frame:'f',role:'textbox',inputType:'password',tag:'input',name:'Password',text:'',source:'semantic',states:{disabled:false,readonly:false,sensitive:true,filled:false},relations:{},bounds:{x:0,y:0,width:50,height:20},inViewport:true,obscured:false,capabilities:['fill_secret']};
  const snapshot:any={version:'v1',observedAt:'now',pageId:'p',url:'https://example.test',title:'Login',tabs:[],frames:[],nodes:[field],limitations:[]};
  const browser=new BrowserAdapter();browser.open=async()=>{};browser.close=async()=>{};
  browser.observe=async()=>({...snapshot,version:changed?'v2':'v1'});
  browser.act=async(a,s)=>{if(changed){const {StaleObservation}=await import('../src/browser.js');throw new StaleObservation('changed');}inputs++;if(fail)throw new Error(`Browser internal call log ${secret}`);};
  const m=new TaskManager(new TaskStore(data),{async choose(p){const action=p.actions.find(a=>a.op==='request_secret')!;return {action,confidence:1,probabilities:{},latencyMs:0,usage:{inputTokens:0,cost:0}};},async text(){throw new Error('unused');}},()=>browser);
  try {
    const t=await m.start({goal:'Login',url:snapshot.url});await settled(m,t.id);changed=true;
    await assert.rejects(m.fillSecret(t.id,field.id,secret),/Private input stopped/);assert.equal(inputs,0);
    changed=false;await m.resume(t.id);await settled(m,t.id);fail=true;
    await assert.rejects(m.fillSecret(t.id,field.id,secret),/Private input stopped/);
    assert.equal(m.get(t.id).status,'needs_review');assert.ok(!JSON.stringify(m.get(t.id)).includes(secret));
    assert.ok(!JSON.stringify(await new TaskStore(data).load()).includes(secret));
  }finally{await m.shutdown();await rm(data,{recursive:true,force:true});}
});

test('explicitly supplied secret fills automatically; JEV sees only the label; another origin gets no secret action',async()=>{
  const data=await mkdtemp(join(tmpdir(),'jev-supplied-secret-'));
  const site=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<label>Account password<input type="password"></label><button onclick="document.querySelector(\'p\').textContent=\'Authenticated fixture\'">Login</button><p></p>');});
  await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${(site.address() as any).port}`;
  const browser=new BrowserAdapter();let fills=0;
  const m=new TaskManager(new TaskStore(data),{
    async choose(p,t){
      assert.ok(!JSON.stringify(p).includes(secret));assert.ok(!JSON.stringify(t).includes(secret));
      let action;
      if(p.nodes.some(n=>n.text==='Authenticated fixture'))action=p.actions.find(a=>a.op==='done');
      else if(p.nodes.some(n=>n.states.sensitive&&n.states.filled))action=p.actions.find(a=>a.op==='click'&&p.nodes.find(n=>n.id===a.target)?.name==='Login');
      else {action=p.actions.find(a=>a.op==='fill_secret');assert.ok(action);assert.match(action.label,/My login password/);fills++;}
      assert.ok(action);return {action,confidence:1,probabilities:{},latencyMs:0,usage:{inputTokens:0,cost:0}};
    },async text(){throw new Error('No LLM text selection for secrets');}
  },()=>browser);
  try {
    const t=await m.start({goal:'Login to fixture',url:origin,headless:true,secrets:[{label:'My login password',text:secret,origin}],checks:[{kind:'text_contains',value:'Authenticated fixture'}]});
    const done=await settled(m,t.id);
    assert.equal(done.status,'completed',done.message);assert.equal(fills,1);
    assert.equal(await (browser as any).page.locator('input').inputValue(),secret);
    assert.ok(!JSON.stringify(await new TaskStore(data).load()).includes(secret));
    assert.equal((m as any).secrets.has(t.id),false);
    const snapshot=await browser.observe();
    for(const n of snapshot.nodes)if(n.states.sensitive)n.states.filled=false;
    const foreign=project(snapshot,undefined,0,false,[{id:'s1',label:'Different site',origin:'https://another.example'}]);
    assert.ok(!foreign.actions.some(a=>a.op==='fill_secret'));
    assert.ok(foreign.actions.some(a=>a.op==='request_secret'));
  }finally{await m.shutdown();await new Promise<void>(r=>site.close(()=>r()));await rm(data,{recursive:true,force:true});}
});
