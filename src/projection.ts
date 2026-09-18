import type { Snapshot, Projection, Action, UINode, TaskInput, SecretDescriptor } from './schema.js';

import { regionPages, interfaceChanges } from './regions.js';
export function descendants(nodes: UINode[], root: string): UINode[] {
  const ids = new Set([root]);
  // Collector order is parent-first, including attached frame roots.
  for (const n of nodes) if (n.parent && ids.has(n.parent)) ids.add(n.id);
  return nodes.filter(n => ids.has(n.id));
}
export function project(snapshot: Snapshot, focus?: string, index = 0, advanced = false, secrets: SecretDescriptor[] = [], previous?:Snapshot): Projection {
  const scope = focus ? descendants(snapshot.nodes, focus) : snapshot.nodes;
  // Keep layout wrappers as ancestor context, without spending a decision on each empty wrapper.
  const all = scope.filter(n=>n.source!=='layout'||n.capabilities.length||n.name||n.text||n.id===focus);
  const focusedSelect = snapshot.nodes.find(n=>n.id===focus && n.options);
  const grouped=regionPages(all,24,64,scope);
  const pageSize = 24, pages = focusedSelect?Math.max(1,Math.ceil(focusedSelect.options!.length/pageSize)):grouped.pages.length;
  index = Math.max(0, Math.min(index, pages - 1));
  const selected = focusedSelect ? [focusedSelect] : grouped.pages[index];
  const lookup = new Map(snapshot.nodes.map(n => [n.id,n]));
  const included = new Set(selected.map(n => n.id));
  for (const node of selected) {
    let parent = node.parent;
    while (parent && !included.has(parent)) { included.add(parent); parent = lookup.get(parent)?.parent ?? null; }
    for (const id of Object.values(node.relations).flat()) if (lookup.has(id)) included.add(id);
  }
  const actions: Action[] = [];
  const add = (op: string, label: string, target?: string, argument?: string) => actions.push({ id:`a${actions.length+1}`,op,label,target,argument });
  for (const n of selected) {
    const label = `${n.role} ${n.name || n.text || (n.href ? `→ ${n.href}` : '(unnamed)')}`.slice(0,240);
    if (!n.inViewport && n.capabilities.length) { add('reveal',`Scroll to ${label}`,n.id); continue; }
    if (n.obscured && n.capabilities.length) continue;
    for (const op of n.capabilities) {
      if (op === 'fill_secret' && (!n.states.filled || advanced)) {
        let origin='';try{origin=new URL(snapshot.frames.find(f=>f.id===n.frame)?.url||snapshot.url).origin;}catch{}
        const available=secrets.filter(secret=>secret.origin===origin);
        if(available.length) for(const secret of available) add('fill_secret',`Fill ${label} using supplied secret: ${secret.label}`,n.id,secret.id);
        else add('request_secret', `Request private local input for ${label}; never use ordinary field values`, n.id);
      }
      if (op === 'select') {
        if (focusedSelect?.id === n.id) {
          for (const o of (n.options ?? []).slice(index*pageSize,(index+1)*pageSize))
            if (!o.disabled && !o.selected) add('select',`Select ${o.label} in ${label}`,n.id,String(o.index));
        } else add('inspect',`Read available options in ${label}`,n.id);
      }
      if (op === 'fill' || (op === 'click' && (advanced || !n.capabilities.some(c=>['fill','select','set_checked'].includes(c))))) add(op,`${op}: ${label}`,n.id);
      if (op === 'hover' && advanced) add(op,`${op}: ${label}`,n.id);
      if (op === 'set_checked') add(op,`${n.states.checked === true ? 'Uncheck' : 'Check'} ${label}`,n.id,String(n.states.checked !== true));
      if (op === 'press') for (const key of advanced ? ['Enter','Escape','ArrowDown','ArrowUp','Tab'] : ((n.capabilities.includes('fill') && n.value) || (n.states.sensitive && n.states.filled)) ? ['Enter'] : []) add(op,`Press ${key} on ${label}`,n.id,key);
      if (op === 'scroll' && n.scroll) {
        const s = n.scroll;
        for (const [d,possible] of [['down',s.y<s.maxY-2],['up',s.y>0],['right',s.x<s.maxX-2],['left',s.x>0]] as const)
          if (possible) add('scroll',`Scroll ${d} in ${label}`,n.id,d);
      }
    }
    if (['article','listitem','row','group','region','main','table','list','dialog','alertdialog','form'].includes(n.role)) {
      add('inspect',`Read inside ${label}`,n.id);
      add('collect',`Save observed content and links from ${label}`,n.id);
    }
  }
  if (!advanced) add('inspect_controls','Show advanced controls for this slice: hover, focus/click and keyboard navigation');
  if (index + 1 < pages) add('inspect_next','Read the next slice of this interface');
  if (index > 0) add('inspect_previous','Read the previous slice of this interface');
  if (focus) add('inspect_root','Return to the page overview');
  for (const tab of snapshot.tabs) if (!tab.active) add('switch_tab',`Switch to ${tab.title || tab.url}`,undefined,tab.id);
  add('back','Go back in this tab');
  add('wait','Wait briefly for the interface to change');
  add('done','Goal appears satisfied; request independent outcome verification');
  add('blocked','Cannot progress with the available information or operations; request Codex assistance');
  const regions = snapshot.nodes.filter(n => ['main','navigation','banner','contentinfo','dialog','form','region','table','list'].includes(n.role));
  const limitations = [...snapshot.limitations];
  if(scope.length>all.length) limitations.push(`${scope.length-all.length} empty layout wrappers are skipped as primary candidates; ancestor context is retained.`);
  if([...grouped.groups.values()].some(nodes=>nodes.length>64)) limitations.push('Large semantic regions exceed 64 primary nodes and are split; parent context and coverage are retained.');
  if (regions.length > 60) limitations.push('Region overview shows the first 60 regions; remaining content is accessible through slices.');
  return { version:snapshot.version, page:{url:snapshot.url,title:snapshot.title},tabs:snapshot.tabs,
    regions:regions.slice(0,60).map(n => ({id:n.id,role:n.role,name:n.name,nodes:descendants(snapshot.nodes,n.id).length})),
    changes:interfaceChanges(previous,snapshot),
    groups:[...grouped.groups].filter(([,nodes])=>nodes.some(n=>selected.some(s=>s.id===n.id))).map(([id,nodes])=>({id,role:lookup.get(id)!.role,name:lookup.get(id)!.name,total:nodes.length,included:nodes.filter(n=>included.has(n.id)).length,complete:nodes.every(n=>included.has(n.id))})),
    nodes:snapshot.nodes.filter(n => included.has(n.id)).map(n=>({...n,
      options:n.options?.slice(n.id===focusedSelect?.id?index*pageSize:0,n.id===focusedSelect?.id?(index+1)*pageSize:3)})), actions,
    coverage:{total:focusedSelect?.options?.length??all.length,included:focusedSelect?Math.min(pageSize,focusedSelect.options!.length-index*pageSize):selected.length,page:index+1,pages,limitations} };
}
export function verify(snapshot: Snapshot, input: TaskInput, evidenceCount: number) {
  const text = snapshot.nodes.map(n => `${n.name} ${n.text}`).join('\n').toLocaleLowerCase();
  const checks = input.checks.map(c => {
    let passed = false;
    if (c.kind === 'url_contains') passed = snapshot.url.includes(c.value);
    if (c.kind === 'text_contains') passed = text.includes(c.value.toLocaleLowerCase());
    if (c.kind === 'field_equals') passed = snapshot.nodes.some(n => n.name === c.name && n.value === c.value);
    if (c.kind === 'collected_count') passed = /^\d+$/.test(c.value) && evidenceCount >= Number(c.value);
    return {check:`${c.kind}: ${c.name ? `${c.name} = ` : ''}${c.value}`,passed};
  });
  return {passed:checks.length>0 && checks.every(c=>c.passed),checks};
}
