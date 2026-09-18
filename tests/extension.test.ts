import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp,rm,mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import { TaskManager } from '../src/engine.js';
import { TaskStore } from '../src/store.js';
import { dashboard } from '../src/http.js';
import type { DecisionProvider } from '../src/model.js';
import type { Action } from '../src/schema.js';

test('extension bridge rejects website origins and incorrect pairing tokens',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'jev-pair-'));const m=new TaskManager(new TaskStore(dir));const panel=await dashboard(m);
  const endpoint=panel.url.replace('http:','ws:').split('/#')[0]+'/extension';
  try{
    await new Promise<void>((resolve,reject)=>{const ws=new WebSocket(endpoint,{origin:'https://untrusted.test'});ws.on('unexpected-response',(_,res)=>{assert.equal(res.statusCode,403);res.resume();ws.terminate();resolve();});ws.on('error',()=>{});ws.on('open',()=>{ws.close();reject(new Error('Untrusted origin connected'));});});
    await new Promise<void>((resolve,reject)=>{const ws=new WebSocket(endpoint,{origin:'chrome-extension://'+'a'.repeat(32)});ws.on('open',()=>ws.send(JSON.stringify({type:'hello',token:'wrong'})));ws.on('close',code=>{assert.equal(code,1008);resolve();});ws.on('error',reject);});
    assert.equal(m.extension.status().connected,false);
  }finally{await panel.close();await m.shutdown();await rm(dir,{recursive:true,force:true});}
});

test('real Chrome extension shares a selected tab, executes across navigation and preserves the user tab', {timeout:90000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'jev-extension-'));
  const fixture=createServer((req,res)=>{
    res.setHeader('Content-Type','text/html');
    res.end(req.url?.startsWith('/detail')?'<html><head><title>Camry detail</title></head><body><h1>Toyota Camry detail</h1></body></html>':req.url?.startsWith('/result')?'<html><head><title>Camry result</title></head><body><h1>Toyota Camry found</h1><p>Search applied</p><iframe srcdoc="<label>Note<input></label>"></iframe><a target="_blank" href="/detail">Open details</a></body></html>':'<html><head><title>Extension test search</title></head><body><main><h1>Car search</h1><form action="/result"><label>Search<input name="q"></label><button>Find</button></form></main></body></html>');
  });
  await new Promise<void>(r=>fixture.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(fixture.address() as any).port}`;
  const usage={inputTokens:0,cost:0};
  const provider:DecisionProvider={async choose(p){
    let a:Action|undefined;
    if(p.page.url.includes('/detail'))a=p.actions.find(a=>a.op==='done');
    else if(p.tabs.length>1)a=p.actions.find(a=>a.op==='switch_tab');
    else if(p.page.url.includes('/result')){const note=p.nodes.find(n=>n.name==='Note'&&n.role==='textbox');a=note&&!note.value?p.actions.find(a=>a.op==='fill'&&a.target===note.id):p.actions.find(a=>a.op==='click'&&a.label.includes('Open details'));}
    else if(!p.nodes.some(n=>n.value==='Toyota Camry'))a=p.actions.find(a=>a.op==='fill');
    else a=p.actions.find(a=>a.op==='click'&&a.label.includes('Find'));
    assert.ok(a,JSON.stringify(p.actions));return {action:a,confidence:.99,probabilities:{[a.id]:1},latencyMs:0,usage};
  },async text(){return {text:'Toyota Camry',usage};}};
  const m=new TaskManager(new TaskStore(join(dir,'tasks')),provider);const panel=await dashboard(m);
  const extension=resolve('chrome-extension');
  let ctx:Awaited<ReturnType<typeof chromium.launchPersistentContext>>|undefined;
  try{
    ctx=await chromium.launchPersistentContext(join(dir,'profile'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
    const worker=ctx.serviceWorkers()[0]||await ctx.waitForEvent('serviceworker');
    const selected=await ctx.newPage();await selected.goto(url);
    const unrelated=await ctx.newPage();await unrelated.goto(url+'/private');
    const extensionId=new URL(worker.url()).host;
    const ui=await ctx.newPage();await ui.goto(`chrome-extension://${extensionId}/panel.html`);
    await ui.locator('#link').fill(panel.url);
    const tab=await worker.evaluate(async()=>{const tabs=await (globalThis as any).chrome.tabs.query({});return tabs.find((t:any)=>t.url?.endsWith('/')&&t.title==='Extension test search');});
    assert.ok(tab?.id,'fixture tab exists');
    await ui.locator('#tab').selectOption(String(tab.id));await ui.locator('#submit').click();
    await ui.locator('#status').filter({hasText:'Подключено к Codex'}).waitFor({timeout:10000}).catch(async error=>{throw new Error(`${error.message} UI: ${await ui.locator('body').innerText()} bridge: ${JSON.stringify(m.extension.status())}`);});
    assert.equal(m.extension.status().tabs.length,1);assert.equal(m.extension.status().tabs[0].id,tab.id);
    const task=await m.start({goal:'Find Toyota Camry',url,browser:'extension',values:[{label:'Search',text:'Toyota Camry'}],checks:[{kind:'url_contains',value:'/detail'},{kind:'text_contains',value:'Toyota Camry detail'}]});
    const end=Date.now()+40000;while(m.get(task.id).status==='running'&&Date.now()<end)await new Promise(r=>setTimeout(r,100));
    const result=m.get(task.id);assert.equal(result.status,'completed',`${result.message} ${JSON.stringify(result.history)} tabs=${JSON.stringify(m.extension.status())}`);
    assert.ok(result.history.some(h=>h.op==='fill'&&h.outcome==='executed'));
    assert.equal(m.extension.status().tabs.length,2);assert.equal(unrelated.url(),url+'/private');
    const switchStep=result.history.find(h=>h.op==='switch_tab')!;assert.ok(switchStep);
    assert.notEqual(switchStep.context?.from.tab,switchStep.context?.to?.tab);assert.equal(result.browserMemory?.tabs.filter(t=>t.visited).length,2);
    assert.ok(result.history.find(h=>h.label.includes('Open details'))?.context?.observed?.openedTabs.length);
    assert.ok(result.history.some(h=>h.op==='fill'&&h.label.includes('Note')&&h.outcome==='executed'));
    await ui.locator('#title').filter({hasText:'Camry result'}).waitFor();await ui.setViewportSize({width:380,height:820});await mkdir('artifacts',{recursive:true});await ui.screenshot({path:'artifacts/chrome-extension.png',fullPage:true});
    await m.cancel(task.id);assert.equal(selected.isClosed(),false);assert.ok(selected.url().includes('/result'));assert.equal(ctx.pages().some(p=>p.url().endsWith('/detail')),false);
  }finally{await m.shutdown();await panel.close();await ctx?.close();await new Promise<void>(r=>fixture.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});
