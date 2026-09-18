import type { Action, BrowserMemory, PageLocation, Snapshot, StepContext, TaskRecord } from './schema.js';

const clip=(value:string,max=240)=>value.length>max?`${value.slice(0,max)}…`:value;
function memory(task:TaskRecord):BrowserMemory {
  return task.browserMemory??={session:0,tabs:[],navigations:[],omittedNavigations:0};
}
export function beginBrowserSession(task:TaskRecord) {
  const m=memory(task);m.session++;m.current=undefined;
  for(const tab of m.tabs)tab.open=false;
}
function tabRef(task:TaskRecord,id:string) {
  const m=memory(task);
  return m.tabs.find(t=>t.session===m.session&&t.nativeId===id);
}
export function pageLocation(task:TaskRecord,s:Snapshot):PageLocation {
  return {tab:tabRef(task,s.pageId)?.id??'unrecorded',url:s.url,title:s.title};
}
/** Read-only observations update local memory; no model interpretation or causal guesses. */
export function rememberObservation(task:TaskRecord,s:Snapshot,source:string,observedAfterStep?:number) {
  const m=memory(task),previous=m.current;
  const currentTabs=new Set(s.tabs.map(t=>t.id));currentTabs.add(s.pageId);
  for(const t of m.tabs)if(t.session===m.session&&!currentTabs.has(t.nativeId))t.open=false;
  const tabs=s.tabs.some(t=>t.id===s.pageId)?s.tabs:[...s.tabs,{id:s.pageId,url:s.url,title:s.title,active:true}];
  for(const t of tabs){
    let saved=tabRef(task,t.id);
    if(!saved){saved={id:`t${m.tabs.length+1}`,session:m.session,nativeId:t.id,url:t.url,title:t.title,open:true,visited:false,
      firstSeen:s.observedAt,lastSeen:s.observedAt,recentUrls:[]};m.tabs.push(saved);}
    saved.url=t.id===s.pageId?s.url:t.url;saved.title=t.id===s.pageId?s.title:t.title;saved.open=true;saved.lastSeen=s.observedAt;
    if(t.id===s.pageId){saved.visited=true;saved.lastVisited=s.observedAt;}
    if(saved.recentUrls.at(-1)!==saved.url){saved.recentUrls.push(saved.url);saved.recentUrls=saved.recentUrls.slice(-12);}
  }
  const current=pageLocation(task,s);m.current=current;
  if(!previous||previous.tab!==current.tab||previous.url!==current.url){
    m.navigations.push({from:previous,to:current,at:s.observedAt,source,observedAfterStep});
    if(m.navigations.length>80){m.omittedNavigations+=m.navigations.length-80;m.navigations=m.navigations.slice(-80);}
  }
}
export function actionContext(task:TaskRecord,a:Action,s:Snapshot,text?:string):StepContext {
  const target=s.nodes.find(n=>n.id===a.target);
  const option=a.op==='select'?target?.options?.find(o=>String(o.index)===a.argument):undefined;
  return {from:pageLocation(task,s),target:target?{role:target.role,name:clip(target.name||target.text),href:target.href,
    frameUrl:s.frames.find(f=>f.id===target.frame)?.url}:undefined,
    parameter:a.op==='switch_tab'?tabRef(task,a.argument!)?.id:option?clip(option.label):a.argument,
    requestedText:text!==undefined&&!target?.states.sensitive?clip(text):undefined};
}
export function rememberActionResult(task:TaskRecord,a:Action,before:Snapshot,after:Snapshot,entry:TaskRecord['history'][number]) {
  rememberObservation(task,after,'after_action',entry.step);
  const from=before.nodes.find(n=>n.id===a.target),to=after.nodes.find(n=>n.id===a.target);
  const context=entry.context??actionContext(task,a,before);entry.context=context;context.to=pageLocation(task,after);
  if(entry.outcome==='executed')context.enteredText=context.requestedText;
  const oldTabs=new Set(before.tabs.map(t=>t.id)),newTabs=new Set(after.tabs.map(t=>t.id));
  context.observed={pageChanged:before.url!==after.url,tabChanged:before.pageId!==after.pageId,structureChanged:before.version!==after.version,
    openedTabs:after.tabs.filter(t=>!oldTabs.has(t.id)).map(t=>tabRef(task,t.id)!.id),
    closedTabs:before.tabs.filter(t=>!newTabs.has(t.id)).map(t=>tabRef(task,t.id)?.id??'unknown'),
    field:from&&!from.states.sensitive&&(from.value!==undefined||from.states.checked!==undefined)?{
      before:from.value===undefined?undefined:clip(from.value),after:!to||to.states.sensitive||to.value===undefined?undefined:clip(to.value),
      checkedBefore:from.states.checked,checkedAfter:to?.states.checked}:undefined};
  const touched=tabRef(task,before.pageId);if(touched)touched.lastAction={step:entry.step,op:a.op,label:clip(a.label)};
  if(a.op==='switch_tab'){const destination=tabRef(task,after.pageId);if(destination)destination.lastAction={step:entry.step,op:a.op,label:clip(a.label)};}
}
const compactPage=(p:PageLocation|undefined)=>p?{tab:p.tab,url:clip(p.url,500),title:clip(p.title,140)}:undefined;
/** Bound request size deterministically. Full task history stays on disk. */
export function journeyContext(task:TaskRecord,maxBytes=14000) {
  const m=task.browserMemory;
  const recentSteps=task.history.slice(-12).map(h=>({step:h.step,operation:h.op,label:clip(h.label),outcome:clip(h.outcome),
    from:h.context?compactPage(h.context.from):{tab:undefined,url:clip(h.url,500),title:undefined},to:compactPage(h.context?.to),
    target:h.context?.target?{...h.context.target,href:h.context.target.href?clip(h.context.target.href,500):undefined,
      frameUrl:h.context.target.frameUrl?clip(h.context.target.frameUrl,500):undefined}:undefined,
    parameter:h.context?.parameter,requestedText:h.context?.requestedText,enteredText:h.context?.enteredText,observed:h.context?.observed?{...h.context.observed,
      openedTabs:h.context.observed.openedTabs.slice(0,16),closedTabs:h.context.observed.closedTabs.slice(0,16),
      totalOpenedTabs:h.context.observed.openedTabs.length,totalClosedTabs:h.context.observed.closedTabs.length}:undefined}));
  const sorted=[...(m?.tabs??[])].sort((a,b)=>Number(b.id===m?.current?.tab)-Number(a.id===m?.current?.tab)||Number(b.visited)-Number(a.visited)||b.lastSeen.localeCompare(a.lastSeen));
  const tabs=sorted.slice(0,24).map(t=>({id:t.id,session:t.session,open:t.open,visited:t.visited,
    url:clip(t.url,500),title:clip(t.title,140),recentUrls:t.recentUrls.slice(-4).map(u=>clip(u,500)),lastAction:t.lastAction}));
  const navigations=(m?.navigations??[]).slice(-8).map(n=>({from:compactPage(n.from),to:compactPage(n.to),source:n.source,observedAfterStep:n.observedAfterStep}));
  const result={current:compactPage(m?.current),recentSteps,tabs,navigations,
    coverage:{totalSteps:task.history.length,includedSteps:recentSteps.length,totalTabs:m?.tabs.length??0,includedTabs:tabs.length,
      omittedNavigations:(m?.omittedNavigations??0)+(m?.navigations.length??0)-navigations.length}};
  while(Buffer.byteLength(JSON.stringify(result))>maxBytes){
    if(navigations.length)navigations.shift();
    else if(recentSteps.length>3)recentSteps.shift();
    else if(tabs.length)tabs.pop();
    else if(recentSteps.length)recentSteps.shift();
    else break;
    result.coverage.includedSteps=recentSteps.length;result.coverage.includedTabs=tabs.length;
    result.coverage.omittedNavigations=(m?.omittedNavigations??0)+(m?.navigations.length??0)-navigations.length;
  }
  return result;
}
