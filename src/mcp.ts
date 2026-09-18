import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { TaskManager } from './engine.js';
import { TaskInput } from './schema.js';
import { dashboard } from './http.js';
import { loadConfig } from './config.js';
import { journeyContext } from './journey.js';

loadConfig();
const manager=new TaskManager();await manager.init();
const panel=await dashboard(manager);
const server=new McpServer({name:'jev-browser',version:'0.1.0'});
const result=(value:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(value)}]});
const summary=(id:string)=>{const t=manager.get(id);return {id:t.id,status:t.status,message:t.message,steps:t.steps,requests:t.requests,
  elapsedMs:t.elapsedMs,reportedCost:t.cost,inputTokens:t.inputTokens,pending:t.pending,verification:t.verification,lastDecision:t.lastDecision,
  evidence:t.evidence,history:t.history.slice(-12),browserContext:journeyContext(t),page:t.snapshot?{url:t.snapshot.url,title:t.snapshot.title}:null,dashboard:panel.url};};
server.registerTool('jev_status',{description:'Check JEV configuration, connected Chrome extension tab and browser tasks. No model call. The private dashboard link also pairs the Chrome companion extension.',inputSchema:{}},async()=>result({configured:!!process.env.OPENROUTER_API_KEY,model:process.env.JEV_MODEL||'typesafe/jev-1.13',tasks:manager.list(),extension:manager.extension.status(),dashboard:panel.url}));
server.registerTool('jev_run',{description:'Start an autonomous browser task with a complete goal, adaptive plan, exact field values and outcome checks. browser=isolated opens url; browser=extension uses the explicitly shared Chrome tab at its current page (url is informational in that mode). Check jev_status first. Returns immediately; inspect with jev_task.',inputSchema:TaskInput.shape},async input=>{const t=await manager.start(input);return result(summary(t.id));});
server.registerTool('jev_task',{description:'Read progress, observed evidence, recent actions and any input/review request. Completion only means supplied checks passed; assess whether they cover the whole user goal.',inputSchema:{id:z.string().uuid()}},async({id})=>result(summary(id)));
server.registerTool('jev_inspect',{description:'Read a deterministic structured page slice without an LLM. Includes hierarchy, roles, states, relations and allowed actions. Use region and index for progressive inspection. Refreshes the browser when paused; running tasks return the latest saved observation.',inputSchema:{id:z.string().uuid(),region:z.string().optional(),index:z.number().int().min(0).default(0)}},async({id,region,index})=>result(await manager.inspect(id,region,index)));
server.registerTool('jev_pause',{description:'Pause task execution. An already-started browser interaction may finish. Waits for the running step to settle.',inputSchema:{id:z.string().uuid()}},async({id})=>{await manager.pause(id);return result(summary(id));});
server.registerTool('jev_resume',{description:'Resume a paused task; optionally update its goal, exact text candidates, outcome checks or execution limits. Values replace the existing candidate list, so include previous values that are still needed. No re-confirmation needed for already-authorized work.',inputSchema:{id:z.string().uuid(),patch:TaskInput.partial().default({})}},async({id,patch})=>{await manager.resume(id,patch);return result(summary(id));});
server.registerTool('jev_cancel',{description:'Stop a task and close only task-owned browser tabs. Saved evidence remains available.',inputSchema:{id:z.string().uuid()}},async({id})=>{await manager.cancel(id);return result(summary(id));});
await server.connect(new StdioServerTransport());
let exiting=false;
async function shutdown(){if(exiting)return;exiting=true;await manager.shutdown();await panel.close();await server.close();}
process.on('SIGINT',()=>void shutdown().then(()=>process.exit(0)));
process.on('SIGTERM',()=>void shutdown().then(()=>process.exit(0)));
process.stdin.on('end',()=>void shutdown().then(()=>process.exit(0)));
