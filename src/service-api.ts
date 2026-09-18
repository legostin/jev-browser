import { z } from 'zod';
import { TaskManager } from './engine.js';
import { TaskRequest, defaultConfidence } from './schema.js';
import { journeyContext } from './journey.js';
export const sessionSchema=z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
const idSchema=z.string().uuid();
/** One queue for external state-changing commands, including dashboard commands. Waiting never holds it. */
export class ServiceAPI {
  private tail:Promise<unknown>=Promise.resolve();
  private closed=false;
  stopAccepting(){this.closed=true;}
  constructor(readonly manager:TaskManager,readonly dashboardURL:string,readonly identity:Record<string,unknown>={}){}
  serial<T>(work:()=>Promise<T>):Promise<T>{const result=this.tail.then(()=>{if(this.closed)throw new Error('JEV service is stopping.');return work();});this.tail=result.catch(()=>{});return result;}
  summary(id:string){const t=this.manager.get(id);return {id:t.id,sessionId:t.sessionId,browser:t.input.browser,minConfidence:t.input.minConfidence,
    attentionRequired:['needs_input','needs_review'].includes(t.status),nextTool:t.status==='running'?'jev_wait':['needs_input','needs_review','paused'].includes(t.status)?'jev_resume':undefined,
    status:t.status,message:t.message,steps:t.steps,requests:t.requests,elapsedMs:t.elapsedMs,reportedCost:t.cost,inputTokens:t.inputTokens,
    pending:t.pending,verification:t.verification,lastDecision:t.lastDecision,evidence:t.evidence,history:t.history.slice(-12),browserContext:journeyContext(t),
    page:t.snapshot?{url:t.snapshot.url,title:t.snapshot.title}:null,dashboard:this.dashboardURL};}
  async call(method:string,args:unknown,sessionId:string,signal?:AbortSignal):Promise<any>{
    sessionSchema.parse(sessionId);
    if(method==='status')return {configured:!!process.env.OPENROUTER_API_KEY,model:process.env.JEV_MODEL||'typesafe/jev-1.13',
      tasks:this.manager.list().filter(t=>!this.manager.get(t.id).sessionId||this.manager.get(t.id).sessionId===sessionId),
      sessionId,currentTaskId:this.manager.currentFor(sessionId),defaults:{browser:'extension',minConfidence:defaultConfidence()},extension:this.manager.extension.status(),dashboard:this.dashboardURL,service:this.identity};
    if(method==='run'){
      const {taskId,newTask,waitMs,...input}=TaskRequest.extend({taskId:idSchema.optional(),newTask:z.boolean().default(false),waitMs:z.number().int().min(0).max(45000).default(25000)}).parse(args);
      const task=await this.serial(()=>this.manager.runOrResume(input,{taskId,newTask,sessionId}));
      await this.manager.wait(task.id,waitMs,signal);return this.summary(task.id);
    }
    const base=z.object({id:idSchema}).passthrough().parse(args);this.manager.assertOwner(base.id,sessionId);
    if(method==='task')return this.summary(base.id);
    if(method==='wait'){
      const {timeoutMs}=z.object({timeoutMs:z.number().int().min(0).max(45000).default(45000)}).parse(args);
      await this.manager.wait(base.id,timeoutMs,signal);return this.summary(base.id);
    }
    if(method==='inspect'){
      const {region,index}=z.object({region:z.string().optional(),index:z.number().int().min(0).default(0)}).parse(args);
      return this.serial(async()=>{this.manager.assertOwner(base.id,sessionId);return this.manager.inspect(base.id,region,index);});
    }
    if(method==='resume'){
      const {patch,waitMs}=z.object({patch:TaskRequest.partial().default({}),waitMs:z.number().int().min(0).max(45000).default(25000)}).parse(args);
      await this.serial(async()=>{await this.manager.claim(base.id,sessionId);await this.manager.resume(base.id,patch);});
      await this.manager.wait(base.id,waitMs,signal);return this.summary(base.id);
    }
    if(method==='pause'||method==='cancel'){
      await this.serial(async()=>{this.manager.assertOwner(base.id,sessionId);await this.manager[method](base.id);});return this.summary(base.id);
    }
    throw new Error('Unknown service operation.');
  }
}
