import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskManager } from '../src/engine.js';
import { TaskStore } from '../src/store.js';
import { TaskInput, type Snapshot } from '../src/schema.js';
import { BrowserAdapter } from '../src/browser.js';
const snapshot:Snapshot={version:'v1',observedAt:'now',pageId:'p',url:'https://example.test',title:'Test',tabs:[],frames:[],nodes:[],limitations:[]};
class BrowserFixture extends BrowserAdapter {opens=0;async open(){this.opens++;}async observe(){return snapshot;}async close(){}}
function decision(p:any,op:string,confidence=1){const action=p.actions.find((a:any)=>a.op===op);return {action,confidence,probabilities:{},latencyMs:0,usage:{inputTokens:0,cost:0}};}

test('unavailable Chrome fails before creating a task or browser; separate mode is explicit',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'jev-default-'));let browsers=0;
  const m=new TaskManager(new TaskStore(dir),undefined,()=>{browsers++;return new BrowserFixture();});
  try {
    assert.equal(TaskInput.parse({goal:'Work',url:snapshot.url}).browser,'extension');
    for(let i=0;i<5;i++) await assert.rejects(m.runOrResume({goal:'Work',url:snapshot.url}),/Companion is not connected/);
    assert.equal(browsers,0);assert.equal(m.tasks.size,0);
  }finally{await m.shutdown();await rm(dir,{recursive:true,force:true});}
});

test('repeated run and clarification resume keep one task and browser; wait returns on input event',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'jev-reuse-'));const browser=new BrowserFixture();let browsers=0,release!:()=>void;
  const gate=new Promise<void>(r=>release=r);let calls=0;
  const m=new TaskManager(new TaskStore(dir),{async choose(p){calls++;if(calls===1)await gate;return decision(p,'blocked');},async text(){throw new Error('unused');}},()=>{browsers++;return browser;});
  const input={goal:'Continue this workflow',url:snapshot.url,browser:'isolated' as const};
  try {
    const t=await m.runOrResume(input);
    for(let i=0;i<5;i++)assert.equal((await m.runOrResume(input)).id,t.id);
    const waiting=m.wait(t.id,45000);release();
    assert.equal((await waiting).status,'needs_input');assert.equal(m.listenerCount('change'),0);
    const resumed=await m.runOrResume({...input,goal:'Clarified goal',values:[{label:'Query',text:'Camry'}]});
    assert.equal(resumed.id,t.id);await m.wait(t.id,45000);
    assert.equal(browsers,1);assert.equal(browser.opens,1);assert.equal(m.tasks.size,1);
    assert.equal(m.get(t.id).input.goal,'Clarified goal');assert.ok(m.get(t.id).history.length>=2);
  }finally{release();await m.shutdown();await rm(dir,{recursive:true,force:true});}
});

test('waiting handles timeout and cancellation without leaking listeners or cancelling task',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'jev-wait-'));let release!:()=>void;
  const gate=new Promise<void>(r=>release=r);
  const m=new TaskManager(new TaskStore(dir),{async choose(p){await gate;return decision(p,'blocked');},async text(){throw new Error('unused');}},()=>new BrowserFixture());
  try {
    const t=await m.start({goal:'Wait',url:snapshot.url,browser:'isolated'});
    assert.equal((await m.wait(t.id,10)).status,'running');assert.equal(m.listenerCount('change'),0);
    const controller=new AbortController(), waiting=m.wait(t.id,45000,controller.signal);controller.abort();
    await assert.rejects(waiting,/Wait cancelled/);assert.equal(m.listenerCount('change'),0);assert.equal(m.get(t.id).status,'running');
    release();await m.wait(t.id,45000);
  }finally{release();await m.shutdown();await rm(dir,{recursive:true,force:true});}
});

test('confidence default is configurable and an explicit task threshold controls the gate',async()=>{
  const old=process.env.JEV_MIN_CONFIDENCE;const dir=await mkdtemp(join(tmpdir(),'jev-threshold-'));
  const m=new TaskManager(new TaskStore(dir),{async choose(p){return decision(p,'blocked',0.6);},async text(){throw new Error('unused');}},()=>new BrowserFixture());
  try {
    process.env.JEV_MIN_CONFIDENCE='0.7';assert.equal(TaskInput.parse({goal:'x',url:snapshot.url}).minConfidence,0.7);
    const t=await m.start({goal:'Threshold',url:snapshot.url,browser:'isolated'});await m.wait(t.id,45000);
    assert.equal(t.status,'needs_review');assert.equal(t.steps,0);
    await m.resume(t.id,{minConfidence:0.5});await m.wait(t.id,45000);
    assert.equal(t.status,'needs_input');assert.equal(t.steps,1);
    process.env.JEV_MIN_CONFIDENCE='2';assert.throws(()=>TaskInput.parse({goal:'x',url:snapshot.url}),/between 0 and 1/);
  }finally{if(old===undefined)delete process.env.JEV_MIN_CONFIDENCE;else process.env.JEV_MIN_CONFIDENCE=old;await m.shutdown();await rm(dir,{recursive:true,force:true});}
});
