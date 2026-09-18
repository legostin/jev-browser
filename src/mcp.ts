import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { TaskManager } from './engine.js';
import { TaskRequest, defaultConfidence } from './schema.js';
import { dashboard } from './http.js';
import { loadConfig } from './config.js';
import { journeyContext } from './journey.js';

loadConfig();
const manager=new TaskManager();await manager.init();
const panel=await dashboard(manager);
const server=new McpServer({name:'jev-browser',version:'0.1.0'});
const result=(value:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(value)}]});
const summary=(id:string)=>{const t=manager.get(id);return {id:t.id,browser:t.input.browser,minConfidence:t.input.minConfidence,attentionRequired:['needs_input','needs_review'].includes(t.status),nextTool:t.status==='running'?'jev_wait':['needs_input','needs_review','paused'].includes(t.status)?'jev_resume':undefined,status:t.status,message:t.message,steps:t.steps,requests:t.requests,
  elapsedMs:t.elapsedMs,reportedCost:t.cost,inputTokens:t.inputTokens,pending:t.pending,verification:t.verification,lastDecision:t.lastDecision,
  evidence:t.evidence,history:t.history.slice(-12),browserContext:journeyContext(t),page:t.snapshot?{url:t.snapshot.url,title:t.snapshot.title}:null,dashboard:panel.url};};
server.registerTool('jev_status',{description:'Check JEV configuration, connected Chrome extension tab and browser tasks. No model call. The private dashboard link also pairs the Chrome companion extension.',inputSchema:{}},async()=>result({configured:!!process.env.OPENROUTER_API_KEY,model:process.env.JEV_MODEL||'typesafe/jev-1.13',tasks:manager.list(),currentTaskId:manager.currentTaskId,defaults:{browser:"extension",minConfidence:defaultConfidence()},extension:manager.extension.status(),dashboard:panel.url}));
async function waitForAgent(id:string, timeoutMs:number, extra:any) {
  let progress=0;
  const listener=(changedId:string)=>{
    if(changedId===id&&extra._meta?.progressToken!==undefined) void extra.sendNotification({method:'notifications/progress',params:{progressToken:extra._meta.progressToken,progress:++progress,message:manager.get(id).message}}).catch(()=>{});
  };
  manager.on('change',listener);
  try {await manager.wait(id,timeoutMs,extra.signal);return result(summary(id));}
  finally {manager.off('change',listener);}
}
server.registerTool('jev_run',{description:'Run or continue the current browser workflow. Default browser=extension uses your explicitly shared Chrome tab; missing connection is an error, never a fallback browser. Use isolated ONLY if the user explicitly requests a separate browser. Reuses currentTaskId by default; taskId selects an existing task. newTask=true explicitly starts a separate record, reusing the connected Chrome session after the previous task completed. Prefer jev_resume for clarifications, never create another task to supply a field value. secrets [{label,text,origin}] hold explicitly supplied credentials in memory only, never sent to JEV or persisted. Waits for an input/review/completion event up to waitMs; while running, continue with jev_wait.',inputSchema:{...TaskRequest.shape,taskId:z.string().uuid().optional(),newTask:z.boolean().default(false),waitMs:z.number().int().min(0).max(45000).default(25000)}},async({taskId,newTask,waitMs,...input},extra)=>{const t=await manager.runOrResume(input,{taskId,newTask});return waitForAgent(t.id,waitMs,extra);});
server.registerTool('jev_wait',{description:'Wait for immediate delivery of a clarification, review request, completion or pause from an existing task. Event driven; no repeated polling or new browser. If still running at timeout, call jev_wait again; if input/review is needed, resolve it and use jev_resume with the SAME id. Cancelling the wait does not cancel browser execution.',inputSchema:{id:z.string().uuid(),timeoutMs:z.number().int().min(0).max(45000).default(45000)}},async({id,timeoutMs},extra)=>waitForAgent(id,timeoutMs,extra));
server.registerTool('jev_task',{description:'Read progress, observed evidence, recent actions and any input/review request. Completion only means supplied checks passed; assess whether they cover the whole user goal.',inputSchema:{id:z.string().uuid()}},async({id})=>result(summary(id)));
server.registerTool('jev_inspect',{description:'Read a deterministic structured page slice without an LLM. Includes hierarchy, roles, states, relations and allowed actions. Use region and index for progressive inspection. Refreshes the browser when paused; running tasks return the latest saved observation.',inputSchema:{id:z.string().uuid(),region:z.string().optional(),index:z.number().int().min(0).default(0)}},async({id,region,index})=>result(await manager.inspect(id,region,index)));
server.registerTool('jev_pause',{description:'Pause task execution. An already-started browser interaction may finish. Waits for the running step to settle.',inputSchema:{id:z.string().uuid()}},async({id})=>{await manager.pause(id);return result(summary(id));});
server.registerTool('jev_resume',{description:'Resume a paused task; optionally update its goal, exact text candidates, outcome checks or execution limits. Values replace the existing candidate list, so include previous values that are still needed. secrets may supply known passwords/codes for automatic filling; they replace the in-memory secret list and require an exact origin. No re-confirmation needed for already-authorized work.',inputSchema:{id:z.string().uuid(),patch:TaskRequest.partial().default({}),waitMs:z.number().int().min(0).max(45000).default(25000)}},async({id,patch,waitMs},extra)=>{await manager.resume(id,patch);return waitForAgent(id,waitMs,extra);});
server.registerTool('jev_cancel',{description:'Stop a task and close only task-owned browser tabs. Saved evidence remains available.',inputSchema:{id:z.string().uuid()}},async({id})=>{await manager.cancel(id);return result(summary(id));});
await server.connect(new StdioServerTransport());
let exiting=false;
async function shutdown(){if(exiting)return;exiting=true;await manager.shutdown();await panel.close();await server.close();}
process.on('SIGINT',()=>void shutdown().then(()=>process.exit(0)));
process.on('SIGTERM',()=>void shutdown().then(()=>process.exit(0)));
process.stdin.on('end',()=>void shutdown().then(()=>process.exit(0)));
