import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { TaskManager } from '../src/engine.js';
import { TaskStore } from '../src/store.js';
import { BrowserAdapter } from '../src/browser.js';
import { dashboard } from '../src/http.js';

const quote=(s:string)=>`'${s.replaceAll("'","'\\''")}'`;
async function until(check:()=>boolean,timeout=12000){const deadline=Date.now()+timeout;while(!check()&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));assert.ok(check(),'condition reached before timeout');}
test('native discovery selects an existing task tab, survives endpoint rotation and cancels a stalled read', {timeout:60000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'jev-native-')),profile=join(dir,'profile'),data=join(dir,'data');
  const fixture=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<h1>${req.url==='/wanted'?'Wanted page':'Unrelated page'}</h1>`);});
  await new Promise<void>(r=>fixture.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${(fixture.address() as any).port}`;
  let manager=new TaskManager(new TaskStore(join(dir,'tasks'))),panel:Awaited<ReturnType<typeof dashboard>>;
  const identity={pid:process.pid,instance:randomUUID(),protocol:1,release:resolve('.')};
  async function endpoint(){
    panel=await dashboard(manager,0,{token:'b'.repeat(48),serial:fn=>fn(),call:async()=>({service:identity})});
    await writeFile(join(data,'service/endpoint.json'),JSON.stringify({...identity,url:panel.url,rpcToken:'b'.repeat(48)}),{mode:0o600});
  }
  await mkdir(join(data,'service'),{recursive:true});await endpoint();
  const manifest=JSON.parse(await readFile('chrome-extension/manifest.json','utf8'));
  const id=createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
  const host=join(dir,'host');await writeFile(host,`#!/bin/sh\ncd ${quote(dir)}\nexport JEV_DATA_DIR=${quote(data)}\nexport JEV_CONFIG_FILE=${quote(join(dir,'none'))}\nexec ${quote(process.execPath)} ${quote(resolve('dist/src/native-host.js'))} "$@"\n`,{mode:0o700});
  await mkdir(join(profile,'NativeMessagingHosts'),{recursive:true});
  await writeFile(join(profile,'NativeMessagingHosts/in.legost.jev_browser.json'),JSON.stringify({name:'in.legost.jev_browser',description:'Test',path:host,type:'stdio',allowed_origins:[`chrome-extension://${id}/`]}));
  const extension=resolve('chrome-extension');let ctx:Awaited<ReturnType<typeof chromium.launchPersistentContext>>|undefined,adapter:BrowserAdapter|undefined;
  try{
    ctx=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
    const selected=await ctx.newPage();await selected.goto(base+'/wanted');
    const other=await ctx.newPage();await other.goto(base+'/private');const count=ctx.pages().length;
    const worker=ctx.serviceWorkers()[0]||await ctx.waitForEvent('serviceworker');
    assert.equal(new URL(worker.url()).host,id);
    await until(()=>manager.extension.status().connected);
    assert.equal(manager.extension.status().tabs.length,0,'no tab access before a task');
    await manager.extension.selectTab(base+'/wanted');
    assert.equal(ctx.pages().length,count,'reuse an existing matching tab');
    assert.equal(manager.extension.status().tabs[0].url,base+'/wanted');
    adapter=new BrowserAdapter(manager.extension);await adapter.open(base+'/wanted',true);
    assert.equal((await adapter.observe()).url,base+'/wanted');
    assert.equal(other.url(),base+'/private');
    const prior=panel!.url;await panel!.close();await adapter.close();adapter=undefined;
    manager=new TaskManager(new TaskStore(join(dir,'tasks')));await endpoint();assert.notEqual(panel!.url,prior);
    await until(()=>manager.extension.status().connected);
    assert.equal(manager.extension.status().tabs[0].url,base+'/wanted','reconnected to the same tab without pasting a new link');
    assert.equal(ctx.pages().length,count);
    adapter=new BrowserAdapter(manager.extension);await adapter.open(base+'/wanted',true);
    await worker.evaluate(()=>{const api=(globalThis as any).chrome.debugger,send=api.sendCommand.bind(api);api.sendCommand=(...args:any[])=>args[1]==='Runtime.callFunctionOn'?new Promise(()=>{}):send(...args);});
    const controller=new AbortController();const observed=adapter.observe(controller.signal);observed.catch(()=>{});
    await until(()=>manager.extension.status().pending.some(p=>p.method==='Runtime.callFunctionOn'));
    const started=Date.now();controller.abort();await assert.rejects(observed,/cancelled/);assert.ok(Date.now()-started<1000);
    assert.equal(selected.isClosed(),false,'cancellation preserves the user tab');
    const ui=await ctx.newPage();await ui.goto(`chrome-extension://${id}/panel.html`);
    await ui.locator('#disconnect').click();await new Promise(r=>setTimeout(r,2000));
    assert.equal(manager.extension.status().connected,false,'manual disconnect prevents automatic reconnection');
    assert.equal(await worker.evaluate(async()=>(await (globalThis as any).chrome.storage.local.get('enabled')).enabled),false);
  }finally{await ctx?.close();await adapter?.close();await manager.shutdown();await panel!.close();await new Promise<void>(r=>fixture.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});
