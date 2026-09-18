import type { Action, Snapshot, UINode } from './schema.js';
export class StaleObservation extends Error {}
const semantic = (n:UINode) => ({role:n.role,tag:n.tag,name:n.name,text:n.text,href:n.href,inputType:n.inputType,
  autocomplete:n.autocomplete,value:n.value,states:n.states,options:n.options});
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const containers=new Set(['form','dialog','alertdialog','article','listitem','row','region','main']);
function contextReader(s:Snapshot) {
  const lookup=new Map(s.nodes.map(n=>[n.id,n])),cache=new Map<string,UINode[]>();
  const ancestors=(n:UINode):UINode[]=>{
    const cached=cache.get(n.id);if(cached)return cached;
    const result:UINode[]=[];let parent=n.parent;const seen=new Set([n.id]);
    while(parent&&!seen.has(parent)){seen.add(parent);const p=lookup.get(parent);if(!p)break;result.push(p);parent=p.parent;}
    cache.set(n.id,result);return result;
  };
  return (n:UINode)=>{
    const parents=ancestors(n),local=parents.find(p=>containers.has(p.role));
    const related=Object.entries(n.relations).sort(([a],[b])=>a.localeCompare(b)).map(([kind,ids])=>({kind,nodes:ids.map(id=>lookup.get(id)).filter((x):x is UINode=>!!x).map(semantic)}));
    // Form state and card content carry intent; unrelated page widgets do not.
    const peers=local&&['form','dialog','alertdialog','article','listitem','row'].includes(local.role)
      ?s.nodes.filter(p=>p.id!==n.id&&(p.capabilities.length||p.text||p.name)&&ancestors(p).some(a=>a.id===local.id)).map(semantic):[];
    return {parents:parents.filter(p=>containers.has(p.role)).map(p=>({role:p.role,name:p.name,text:p.text})),related,peers};
  };
}
function sameDocument(before:Snapshot,after:Snapshot,frame?:string) {
  if(before.pageId!==after.pageId||before.url!==after.url)throw new StaleObservation('The active page changed before execution.');
  if(frame){const old=before.frames.find(f=>f.id===frame),fresh=after.frames.find(f=>f.id===frame);
    if(!old||!fresh||old.document!==fresh.document||old.url!==fresh.url)throw new StaleObservation('The target document changed before execution.');}
}
/** Return a validated live target. No browser mutation or model-generated selector. */
export function validateAction(action:Action,before:Snapshot,after:Snapshot):UINode|undefined {
  if(action.op==='wait')return;
  sameDocument(before,after);
  if(action.op==='switch_tab') {
    const old=before.tabs.find(t=>t.id===action.argument),fresh=after.tabs.find(t=>t.id===action.argument);
    if(!old||!fresh||old.url!==fresh.url||old.title!==fresh.title)throw new StaleObservation('The selected tab changed.');return;
  }
  if(action.op==='back') {
    const old=before.frames.find(f=>!f.parent),fresh=after.frames.find(f=>!f.parent);
    if(!old||!fresh||old.document!==fresh.document)throw new StaleObservation('The current document changed.');return;
  }
  const old=before.nodes.find(n=>n.id===action.target);
  if(!old)throw new StaleObservation('The action has no observed target.');
  sameDocument(before,after,old.frame);
  const oldContext=contextReader(before)(old),freshContext=contextReader(after);
  let target=after.nodes.find(n=>n.id===old.id);
  if(!target) {
    // Only a unique equivalent control in equivalent context may replace a detached node.
    const candidates=after.nodes.filter(n=>n.frame===old.frame&&equal(semantic(n),semantic(old))&&equal(freshContext(n),oldContext));
    if(candidates.length!==1)throw new StaleObservation('Target replacement is absent or ambiguous. Observe and choose again.');
    target=candidates[0];
  }
  const modal=(s:Snapshot)=>s.nodes.filter(n=>['dialog','alertdialog'].includes(n.role)).map(n=>({role:n.role,name:n.name,text:n.text}));
  if(!equal(modal(before),modal(after))||!equal(semantic(old),semantic(target))||!equal(oldContext,freshContext(target)))
    throw new StaleObservation('The target, its related content or form state changed.');
  if(action.op!=='reveal'&&(!target.inViewport||target.obscured))throw new StaleObservation('The target is no longer reachable.');
  const capability=action.op==='reveal'?undefined:action.op;
  if(capability&&!target.capabilities.includes(capability))throw new StaleObservation('The target no longer supports the action.');
  return target;
}
