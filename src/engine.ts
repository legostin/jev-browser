import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { BrowserAdapter, StaleObservation, digest, httpUrl } from './browser.js';
import { project, descendants, verify } from './projection.js';
import { JevProvider, type DecisionProvider } from './model.js';
import { TaskStore } from './store.js';
import { TaskInput, TaskRequest, type SecretDescriptor, type TaskRecord, type Action, type Snapshot } from './schema.js';
import { ExtensionBridge } from './extension.js';
import { actionContext, beginBrowserSession, rememberActionResult, rememberObservation } from './journey.js';

interface Live { browser:BrowserAdapter; controller:AbortController; promise?:Promise<void>; focus?:string; index:number; opened?:boolean; advanced?:boolean; secretBusy?:boolean }
export class TaskManager extends EventEmitter {
  readonly tasks = new Map<string,TaskRecord>();
  readonly extension = new ExtensionBridge();
  private live = new Map<string,Live>();
  private secrets = new Map<string,(SecretDescriptor & {text:string})[]>();
  constructor(readonly store = new TaskStore(), private provider:DecisionProvider = new JevProvider(), private browserFactory?: (input:TaskInput)=>BrowserAdapter) { super(); }
  async init() { for (const record of await this.store.load()) this.tasks.set(record.id,record); }
  get(id:string) { const t=this.tasks.get(id); if(!t) throw new Error('Task not found.'); return t; }
  list() { return [...this.tasks.values()].map(t=>({id:t.id,goal:t.input.goal,status:t.status,steps:t.steps,message:t.message,updatedAt:t.updatedAt,evidenceCount:t.evidence.length})).reverse(); }
  private async save(task:TaskRecord) { task.updatedAt=new Date().toISOString(); await this.store.save(task); this.emit('change',task.id); }
  async start(raw:unknown) {
    const {secrets,...input}=TaskRequest.parse(raw); httpUrl(input.url);
    if ([...this.tasks.values()].filter(t=>t.status==='running').length>=3) throw new Error('Three tasks are already running. Pause one first.');
    const now=new Date().toISOString();
    const task:TaskRecord={id:randomUUID(),input,status:'running',createdAt:now,updatedAt:now,steps:0,requests:0,elapsedMs:0,cost:0,inputTokens:0,history:[],evidence:[],message:'Opening browser…'};
    if(secrets) this.secrets.set(task.id,secrets.map((s,i)=>({...s,id:`s${i+1}`,origin:new URL(s.origin).origin})));
    this.tasks.set(task.id,task); await this.save(task); this.launch(task); return task;
  }
  private launch(task:TaskRecord) {
    const old=this.live.get(task.id);
    const live:Live=old?{...old,controller:new AbortController()}:{browser:this.browserFactory?.(task.input)??new BrowserAdapter(task.input.browser==='extension'?this.extension:undefined),controller:new AbortController(),index:0};
    this.live.set(task.id,live);
    live.promise=this.run(task,live).finally(()=>{live.promise=undefined;});
  }
  private account(task:TaskRecord,usage:{inputTokens:number;cost:number|null}) {task.inputTokens+=usage.inputTokens;task.cost+=usage.cost??0;}
  private log(task:TaskRecord,a:Action,s:Snapshot,outcome:string,confidence?:number|null,text?:string) {
    const entry={step:task.steps,op:a.op,target:a.target,label:a.label,url:s.url,version:s.version,outcome,confidence,at:new Date().toISOString(),context:actionContext(task,a,s,text)};
    task.history.push(entry);return entry;
  }
  private async run(task:TaskRecord,live:Live) {
    const started=Date.now(), previousElapsed=task.elapsedMs;
    const signal=live.controller.signal;
    let noProgress=0;
    try {
      if (!live.opened) {await live.browser.open(task.snapshot?.url || task.input.url,task.input.headless);beginBrowserSession(task);live.opened=true;}
      while (!signal.aborted && task.status==='running') {
        task.elapsedMs=previousElapsed+Date.now()-started;
        if (task.steps>=task.input.maxSteps || task.requests>=task.input.maxSteps*3 || task.elapsedMs>=task.input.maxSeconds*1000) {
          task.status='paused';task.message='Execution budget reached. Review progress or resume with larger limits.';break;
        }
        const snapshot=await live.browser.observe();
        rememberObservation(task,snapshot,'before_decision');
        task.snapshot=snapshot;
        if(live.focus&&!snapshot.nodes.some(n=>n.id===live.focus)) {live.focus=undefined;live.index=0;}
        task.projection=project(snapshot,live.focus,live.index,live.advanced,this.secrets.get(task.id)?.map(({id,label,origin})=>({id,label,origin})));
        task.message=`Choosing next step · ${snapshot.title || snapshot.url}`;
        await this.save(task);
        const decision=await this.provider.choose(task.projection,task,signal);
        task.requests++;this.account(task,decision.usage);
        if(signal.aborted||task.status!=='running') break;
        const a=decision.action;
        if(!task.projection.actions.some(x=>JSON.stringify(x)===JSON.stringify(a))) throw new Error('Provider returned an action outside the observed action space.');
        task.lastDecision={action:a,confidence:decision.confidence,threshold:task.input.minConfidence,
          alternatives:Object.entries(decision.probabilities).sort((a,b)=>b[1]-a[1]).slice(0,5)
            .map(([id,probability])=>({action:task.projection!.actions.find(x=>x.id===id)!,probability})).filter(x=>x.action)};
        if(decision.confidence===null || decision.confidence<task.input.minConfidence) {
          task.status='needs_review';task.pending={kind:'review',context:`Confidence ${decision.confidence ?? 'missing'} below ${task.input.minConfidence} for ${a.label}. Inspect lastDecision alternatives and the page; refine the plan or field values.`};
          task.message=task.pending.context;break;
        }
        task.steps++;
        if(a.op==='request_secret') {
          task.status='needs_input';task.pending={kind:'secret',target:a.target,version:snapshot.version,context:`Private input needed for ${a.label}. Supply secrets in jev_resume if already provided by the user, or use the local dashboard/browser. Keep secret text out of ordinary values.`};
          task.message=task.pending.context;this.log(task,a,snapshot,'waiting for private input',decision.confidence);break;
        }
        if(a.op==='blocked') {task.status='needs_input';task.pending={kind:'blocked',context:'JEV cannot progress. Refine the goal, supply missing values, or inspect unsupported content.'};task.message=task.pending.context;this.log(task,a,snapshot,'blocked',decision.confidence);break;}
        if(a.op==='done') {
          // Re-observe: a model completion signal is never accepted on stale evidence.
          const fresh=await live.browser.observe();task.snapshot=fresh;
          rememberObservation(task,fresh,'verification');
          if(fresh.version!==snapshot.version) {this.log(task,a,snapshot,'stale; completion not accepted');continue;}
          task.verification=verify(fresh,task.input,task.evidence.length);
          task.status=task.verification.passed?'completed':'needs_review';
          task.message=task.verification.passed?'All configured outcome checks passed.':'JEV proposed completion. Codex must review the evidence; configured checks are absent or did not pass.';
          if(!task.verification.passed) task.pending={kind:'review',context:task.message};
          this.log(task,a,snapshot,task.message,decision.confidence);break;
        }
        if(a.op.startsWith('inspect')) {
          live.advanced=a.op==='inspect_controls';
          if(a.op==='inspect') {live.focus=a.target;live.index=0;}
          if(a.op==='inspect_next') live.index++;
          if(a.op==='inspect_previous') live.index=Math.max(0,live.index-1);
          if(a.op==='inspect_root') {live.focus=undefined;live.index=0;}
          this.log(task,a,snapshot,'expanded observation',decision.confidence); await this.save(task);continue;
        }
        live.advanced=false;
        if(a.op==='collect') {
          const selected=descendants(snapshot.nodes,a.target!).map(({id,parent,role,name,text,value,href})=>({id,parent,role,name,text,value,href}));
          const evidenceId=digest({url:snapshot.url,nodes:selected.map(({id,parent,...n})=>n)});
          if(!task.evidence.some(e=>e.id===evidenceId)) task.evidence.push({id:evidenceId,url:snapshot.url,title:snapshot.title,observedAt:snapshot.observedAt,snapshot:snapshot.version,nodes:selected});
          this.log(task,a,snapshot,'observed content saved',decision.confidence);await this.save(task);continue;
        }
        let text:string|undefined;
        if(a.op==='fill_secret') {
          const secret=this.secrets.get(task.id)?.find(s=>s.id===a.argument);
          const node=snapshot.nodes.find(n=>n.id===a.target);
          const origin=new URL(snapshot.frames.find(f=>f.id===node?.frame)?.url||snapshot.url).origin;
          if(!secret || secret.origin!==origin || !node?.states.sensitive) throw new Error('No supplied secret is authorized for this field origin.');
          text=secret.text;
        }
        if(a.op==='fill') {
          const chosen=await this.provider.text(task.projection,task,a,signal); task.requests++;this.account(task,chosen.usage);
          if(signal.aborted||task.status!=='running') break;
          if(chosen.text===null) {
            this.log(task,a,snapshot,'value missing; not executed',decision.confidence);
            task.status='needs_input';task.pending={kind:'text',target:a.target,context:`Supply a value for ${a.label}.`};task.message=task.pending.context;break;
          }
          text=chosen.text;
        }
        if(signal.aborted||task.status!=='running') break;
        task.message=a.label;
        // Persist intent first. A failure after browser input is uncertain and is never automatically retried.
        const entry=this.log(task,a,snapshot,'executing',decision.confidence,a.op==='fill_secret'?undefined:text);await this.save(task);
        if(signal.aborted||task.status!=='running') {task.history.at(-1)!.outcome='paused before execution';break;}
        try { await live.browser.act(a,snapshot,text); }
        catch(error) {
          if(error instanceof StaleObservation) {task.history.at(-1)!.outcome='stale; not executed';await this.save(task);continue;}
          task.history.at(-1)!.outcome='execution uncertain; inspect before resuming';if(a.op==='fill_secret')throw new Error('Private input result is uncertain. Inspect before resuming.');throw error;
        }
        entry.outcome='executed';entry.context.enteredText=entry.context.requestedText;await this.save(task);
        const after=await live.browser.observe();task.snapshot=after;
        rememberActionResult(task,a,snapshot,after,entry);
        noProgress=after.version===snapshot.version && a.op!=='wait'?noProgress+1:0;
        if(noProgress>=3) {task.status='needs_review';task.message='Three interactions did not change the observed interface. Review before continuing.';task.pending={kind:'review',context:task.message};}
        await this.save(task);
      }
    } catch(error) {
      if(!signal.aborted) {
        task.status='needs_review';
        task.message=error instanceof Error?error.message:'Execution stopped.';
        // HTTP errors never include credentials, provider bodies or request state.
        task.pending={kind:'review',context:task.message};
      }
    } finally {if(task.status==='completed'||task.status==='cancelled')this.secrets.delete(task.id);task.elapsedMs=previousElapsed+Date.now()-started;await this.save(task);}
  }
  async fillSecret(id:string, target:string, secret:string) {
    const task=this.get(id), live=this.live.get(id);
    if(live?.promise) await live.promise;
    if(!live?.opened || live.secretBusy || task.status!=='needs_input' || task.pending?.kind!=='secret'
      || task.pending.target!==target || !task.snapshot || task.pending.version!==task.snapshot.version)
      throw new Error('Private input request is no longer current. Inspect and resume the task.');
    if(typeof secret!=='string'||!secret.length||secret.length>4000) throw new Error('Invalid private input.');
    const snapshot=task.snapshot;
    const node=snapshot.nodes.find(n=>n.id===target);
    if(!node?.states.sensitive || !node.capabilities.includes('fill_secret')) throw new Error('This field does not accept private input.');
    live.secretBusy=true;
    const action={id:'private',op:'fill_secret',target,label:`Private input: ${node.name || node.role}`};
    try {
      const entry=this.log(task,action,snapshot,'executing private input');
      await this.save(task);
      try { await live.browser.act(action,snapshot,secret); }
      catch(error) {
        entry.outcome=error instanceof StaleObservation?'stale; not executed':'private input uncertain; inspect before continuing';
        task.status='needs_review';task.message=entry.outcome;task.pending={kind:'review',context:task.message};
        await this.save(task);
        throw new Error('Private input stopped. Inspect the browser before resuming.');
      }
      entry.outcome='private input delivered';
      task.status='paused';task.pending=undefined;task.message='Private input delivered. Resume when ready.';
      await this.save(task);
      return task;
    } finally { live.secretBusy=false; }
  }
  async pause(id:string) {
    const task=this.get(id), live=this.live.get(id);
    if(live?.secretBusy) throw new Error('Private input is in progress.');
    if(task.status!=='running') return task;
    task.status='paused';task.message='Paused. An interaction already in progress may finish.';live?.controller.abort();
    await live?.promise;await this.save(task);return task;
  }
  async resume(id:string, patch:Partial<TaskRequest>={}) {
    const task=this.get(id);
    if(this.live.get(id)?.secretBusy) throw new Error('Private input is in progress.');
    if(task.status==='running') throw new Error('Pause before updating a running task.');
    if(task.status==='cancelled') throw new Error('Cancelled tasks cannot be resumed; start a new task.');
    if(this.live.get(id)?.promise) await this.live.get(id)!.promise;
    if(patch.browser && patch.browser!==(task.input.browser||'isolated'))throw new Error('Start a new task to change browser connection mode.');
    const {secrets,...updates}=TaskRequest.partial().parse(patch);
    task.input=TaskInput.parse({...task.input,...updates});httpUrl(task.input.url);
    if(secrets) this.secrets.set(id,secrets.map((s,i)=>({...s,id:`s${i+1}`,origin:new URL(s.origin).origin})));
    task.pending=undefined;task.verification=undefined;task.status='running';task.message='Resuming…';
    await this.save(task);this.launch(task);return task;
  }
  async cancel(id:string) {
    await this.pause(id); const task=this.get(id),live=this.live.get(id);
    await live?.browser.close();this.live.delete(id);this.secrets.delete(id);
    task.status='cancelled';task.message='Cancelled. Task-owned browser tabs closed.';await this.save(task);return task;
  }
  async inspect(id:string, region?:string, index=0) {
    const task=this.get(id);
    const live=this.live.get(id);
    if(live?.secretBusy) throw new Error('Private input is in progress.');
    if(task.status!=='running'&&live?.opened) {task.snapshot=await live.browser.observe();rememberObservation(task,task.snapshot,'inspection');await this.save(task);}
    if(!task.snapshot) throw new Error('No observation yet.');
    return project(task.snapshot,region,index,false,this.secrets.get(id)?.map(({id,label,origin})=>({id,label,origin})));
  }
  async shutdown() {
    for (const id of this.live.keys()) {await this.pause(id);await this.live.get(id)?.browser.close();}
    this.live.clear();this.secrets.clear();
  }
}
