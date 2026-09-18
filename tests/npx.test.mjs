import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main, install } from '../bin/jev-browser.mjs';
async function temporary(t){const dir=await mkdtemp(join(tmpdir(),'jev-npx-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
test('help and invalid commands do not install or start anything',async()=>{
  let output='';const deps={output:x=>output=x,run:()=>assert.fail('No process expected'),installRuntime:()=>assert.fail('No installation expected')};
  await main(['--help'],deps);assert.match(output,/install/);await assert.rejects(main(['unknown'],deps),/Неизвестная/);
});
test('start requires explicit installation and routes to durable launcher without changing cwd',async t=>{
  const root=await temporary(t),calls=[];const deps={root,run:(...a)=>calls.push(a)};
  await assert.rejects(main(['start'],deps),/ещё не установлен/);assert.equal(calls.length,0);
  await writeFile(join(root,'launcher.mjs'),'');await mkdir(join(root,'current'));
  await main([],deps);await main(['mcp'],deps);await main(['service','status'],deps);await main(['run','relative.json'],deps);
  assert.deepEqual(calls.map(c=>c[1]),[['launcher.mjs','serve'],['launcher.mjs','mcp'],['launcher.mjs','service','status'],['launcher.mjs','run','relative.json']].map(a=>[join(root,a[0]),...a.slice(1)]));
});
test('install is explicit; setup uses a temporary Git checkout and cleans it after failure',async t=>{
  const root=await temporary(t);let installed=0;await main(['install'],{installRuntime:async()=>installed++});assert.equal(installed,1);
  await assert.rejects(main(['install','extra'],{installRuntime:async()=>assert.fail()}),/не принимает/);
  const calls=[];await assert.rejects(install({temporary:root,run:(cmd,args)=>{calls.push([cmd,args]);if(cmd==='gh')throw new Error('no gh');if(args[0]?.endsWith('setup.mjs'))throw new Error('setup failed');}}),/setup failed/);
  assert.ok(calls.some(([c,a])=>c==='git'&&a[0]==='clone'));assert.ok(calls.some(([,a])=>a[0]?.endsWith('source/scripts/setup.mjs')));assert.deepEqual(await readdir(root),[]);
});
test('authenticated gh clone uses the existing installer and is cleaned after success',async t=>{
  const root=await temporary(t),calls=[];await install({temporary:root,run:(...args)=>calls.push(args)});
  assert.ok(calls.some(([cmd,args])=>cmd==='gh'&&args[0]==='repo'));assert.ok(!calls.some(([cmd,args])=>cmd==='git'&&args[0]==='clone'));assert.deepEqual(await readdir(root),[]);
});
