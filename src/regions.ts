import type { Snapshot, UINode } from './schema.js';
const strong=new Set(['form','dialog','alertdialog','article','listitem','row']);
export function regionPages(nodes:UINode[],softSize=24,maxGroup=64, hierarchy:UINode[]=nodes) {
  const lookup=new Map(hierarchy.map(n=>[n.id,n]));
  const members=new Map<string,UINode[]>();
  for(const n of nodes) {
    let at:UINode|undefined=n;
    while(at){if(strong.has(at.role)){const list=members.get(at.id)||[];list.push(n);members.set(at.id,list);}at=at.parent?lookup.get(at.parent):undefined;}
  }
  const units=new Map<string,UINode[]>();
  for(const n of nodes) {
    let at:UINode|undefined=n,root=n.id;
    while(at){if(strong.has(at.role)&&(members.get(at.id)?.length||0)<=maxGroup)root=at.id;at=at.parent?lookup.get(at.parent):undefined;}
    const list=units.get(root)||[];list.push(n);units.set(root,list);
  }
  const ranked=[...units].map(([root,items],order)=>({root,items,order,priority:
    items.some(n=>['dialog','alertdialog'].includes(n.role))?0:items.some(n=>n.states.focused)?1:items.some(n=>n.inViewport&&!n.obscured&&n.capabilities.length)?2:3}));
  ranked.sort((a,b)=>a.priority-b.priority||a.order-b.order);
  const pages:UINode[][]=[];let page:UINode[]=[];
  for(const unit of ranked){if(page.length&&page.length+unit.items.length>softSize){pages.push(page);page=[];}page.push(...unit.items);}
  if(page.length)pages.push(page);
  return {pages:pages.length?pages:[[]],groups:members};
}
export function interfaceChanges(previous:Snapshot|undefined,current:Snapshot) {
  if(!previous)return {kind:'initial' as const};
  if(previous.pageId!==current.pageId||previous.url!==current.url||previous.frames[0]?.document!==current.frames[0]?.document)
    return {kind:'navigation' as const,from:{url:previous.url,title:previous.title},to:{url:current.url,title:current.title}};
  const before=new Map(previous.nodes.map(n=>[n.id,n])),after=new Map(current.nodes.map(n=>[n.id,n]));
  const fact=(n:UINode)=>JSON.stringify({role:n.role,name:n.name,text:n.text,value:n.value,states:n.states,href:n.href,options:n.options});
  const label=(n:UINode)=>({role:n.role,name:(n.name||n.text).slice(0,160)});
  const added=current.nodes.filter(n=>!before.has(n.id)),removed=previous.nodes.filter(n=>!after.has(n.id));
  const changed=current.nodes.filter(n=>before.has(n.id)&&fact(n)!==fact(before.get(n.id)!));
  return {kind:'update' as const,added:added.slice(0,12).map(label),removed:removed.slice(0,12).map(label),changed:changed.slice(0,12).map(label),
    counts:{added:added.length,removed:removed.length,changed:changed.length}};
}
