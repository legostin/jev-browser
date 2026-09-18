import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TaskManager } from '../src/engine.js';
import { TaskStore } from '../src/store.js';
import { dashboard } from '../src/http.js';

test('dashboard protects task data and renders on desktop and mobile',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'jev-ui-'));const m=new TaskManager(new TaskStore(dir));const panel=await dashboard(m);
  const url=new URL(panel.url),token=url.hash.slice(1);url.hash='';
  const b=await chromium.launch({headless:true,channel:'chrome'});
  try{
    assert.equal((await fetch(new URL('/api/status',url))).status,401);
    assert.equal((await fetch(new URL('/api/status',url),{headers:{'x-jev-token':token,Origin:'https://evil.test'}})).status,403);
    assert.equal((await fetch(new URL('/api/status',url),{headers:{'x-jev-token':token}})).status,200);
    const page=await b.newPage({viewport:{width:1440,height:1000}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(panel.url);await page.getByRole('heading',{name:'Задайте цель. Следите за результатом.'}).waitFor();
    await page.waitForTimeout(300);assert.deepEqual(errors,[]);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/dashboard-desktop.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:'artifacts/dashboard-mobile.png',fullPage:true});
  }finally{await b.close();await panel.close();await rm(dir,{recursive:true,force:true});}
});
test('MCP initializes, lists all tools and returns configuration without credentials',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'jev-mcp-'));
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/mcp.js',import.meta.url))],env:{...Object.fromEntries(Object.entries(process.env).filter((x):x is [string,string]=>typeof x[1]==='string')),JEV_DATA_DIR:dir,OPENROUTER_API_KEY:''}});
  const client=new Client({name:'integration-test',version:'1.0.0'});
  try{await client.connect(transport);const list=await client.listTools();assert.equal(list.tools.length,7);assert.ok(list.tools.some(t=>t.name==='jev_run'));const status=await client.callTool({name:'jev_status',arguments:{}});const payload=JSON.parse((status.content as any)[0].text);assert.equal(payload.configured,false);assert.ok(payload.dashboard.startsWith('http://127.0.0.1:'));}finally{await client.close();await rm(dir,{recursive:true,force:true});}
});
