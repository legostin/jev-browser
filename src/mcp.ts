import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TaskRequest } from './schema.js';
import { loadConfig } from './config.js';
import { ensureService, serviceCall } from './service-client.js';
import { ServiceAPI, sessionSchema } from './service-api.js';
import { TaskManager } from './engine.js';
import { dashboard } from './http.js';
loadConfig();
const defaultSession=sessionSchema.parse(process.env.JEV_SESSION_ID||process.env.CODEX_THREAD_ID||randomUUID());
const server=new McpServer({name:'jev-browser',version:'0.1.0'});
let cleanup=async()=>{};
let invoke:(method:string,args:unknown,sessionId:string,signal?:AbortSignal)=>Promise<any>;
if(process.env.JEV_EPHEMERAL==='1') {
  // Disposable health checks/tests must not leave a daemon behind.
  const manager=new TaskManager();await manager.init();const panel=await dashboard(manager);const api=new ServiceAPI(manager,panel.url);
  invoke=(...args)=>api.call(...args);cleanup=async()=>{await manager.shutdown();await panel.close();};
} else {
  // Start lazily, after the MCP handshake: browser ownership belongs to the daemon.
  invoke=async(method,args,sessionId,signal)=>serviceCall(await ensureService(),method,args,sessionId,signal);
}
const result=(value:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(value)}]});
server.registerTool('jev_status',{description:'Check JEV configuration, connected Chrome extension tab and browser tasks. No model call. The private dashboard link also pairs the Chrome companion extension. The daemon persists across MCP reconnects. Keep the returned sessionId when reconnecting if CODEX_THREAD_ID is unavailable.',inputSchema:{sessionId:sessionSchema.optional()}},async({sessionId,...args},extra)=>result(await invoke('status',args,sessionId||defaultSession,extra.signal)));
server.registerTool('jev_run',{description:'Run or continue the current browser workflow. Default browser=extension uses your explicitly shared Chrome tab; missing connection is an error, never a fallback browser. Use isolated ONLY if the user explicitly requests a separate browser. Reuses currentTaskId by default; taskId selects an existing task. newTask=true explicitly starts a separate record, reusing the connected Chrome session after the previous task completed. Prefer jev_resume for clarifications, never create another task to supply a field value. secrets [{label,text,origin}] hold explicitly supplied credentials in memory only, never sent to JEV or persisted. Waits for an input/review/completion event up to waitMs; while running, continue with jev_wait.',inputSchema:{...TaskRequest.shape,minConfidence:z.number().min(0).max(1).optional(),taskId:z.string().uuid().optional(),newTask:z.boolean().default(false),waitMs:z.number().int().min(0).max(45000).default(25000),sessionId:sessionSchema.optional()}},async({sessionId,...args},extra)=>result(await invoke('run',args,sessionId||defaultSession,extra.signal)));
server.registerTool('jev_wait',{description:'Wait for immediate delivery of a clarification, review request, completion or pause from an existing task. Event driven; no repeated polling or new browser. If still running at timeout, call jev_wait again; if input/review is needed, resolve it and use jev_resume with the SAME id. Cancelling the wait does not cancel browser execution.',inputSchema:{id:z.string().uuid(),timeoutMs:z.number().int().min(0).max(45000).default(45000),sessionId:sessionSchema.optional()}},async({sessionId,...args},extra)=>result(await invoke('wait',args,sessionId||defaultSession,extra.signal)));
server.registerTool('jev_task',{description:'Read progress, observed evidence, recent actions and any input/review request. Completion only means supplied checks passed; assess whether they cover the whole user goal.',inputSchema:{id:z.string().uuid(),sessionId:sessionSchema.optional()}},async({sessionId,...args},extra)=>result(await invoke('task',args,sessionId||defaultSession,extra.signal)));
server.registerTool('jev_inspect',{description:'Read a deterministic structured page slice without an LLM. Includes hierarchy, roles, states, relations and allowed actions. Use region and index for progressive inspection. Refreshes the browser when paused; running tasks return the latest saved observation.',inputSchema:{id:z.string().uuid(),region:z.string().optional(),index:z.number().int().min(0).default(0),sessionId:sessionSchema.optional()}},async({sessionId,...args},extra)=>result(await invoke('inspect',args,sessionId||defaultSession,extra.signal)));
server.registerTool('jev_pause',{description:'Pause task execution. An already-started browser interaction may finish. Waits for the running step to settle.',inputSchema:{id:z.string().uuid(),sessionId:sessionSchema.optional()}},async({sessionId,...args},extra)=>result(await invoke('pause',args,sessionId||defaultSession,extra.signal)));
server.registerTool('jev_resume',{description:'Resume a paused task; optionally update its goal, exact text candidates, outcome checks or execution limits. Values replace the existing candidate list, so include previous values that are still needed. secrets may supply known passwords/codes for automatic filling; they replace the in-memory secret list and require an exact origin. No re-confirmation needed for already-authorized work.',inputSchema:{id:z.string().uuid(),patch:TaskRequest.partial().default({}),waitMs:z.number().int().min(0).max(45000).default(25000),sessionId:sessionSchema.optional()}},async({sessionId,...args},extra)=>result(await invoke('resume',args,sessionId||defaultSession,extra.signal)));
server.registerTool('jev_cancel',{description:'Stop a task and close only task-owned browser tabs. Saved evidence remains available.',inputSchema:{id:z.string().uuid(),sessionId:sessionSchema.optional()}},async({sessionId,...args},extra)=>result(await invoke('cancel',args,sessionId||defaultSession,extra.signal)));
await server.connect(new StdioServerTransport());
let exiting=false;
async function shutdown(){if(exiting)return;exiting=true;await cleanup();await server.close();process.exit(0);}
process.on('SIGINT',()=>void shutdown());process.on('SIGTERM',()=>void shutdown());process.stdin.on('end',()=>void shutdown());
