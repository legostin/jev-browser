import test from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../src/projection.js';
import type { Snapshot,UINode } from '../src/schema.js';
test('large select options can all be discovered without overloading a single request',()=>{
  const node:UINode={id:'select',parent:null,frame:'f',tag:'select',role:'combobox',name:'Country',text:'',source:'semantic',states:{disabled:false,readonly:false},relations:{},bounds:{x:0,y:0,width:100,height:30},inViewport:true,obscured:false,capabilities:['select'],options:Array.from({length:301},(_,index)=>({index,label:`Option ${index}`,value:String(index),disabled:false,selected:index===0}))};
  const snapshot:Snapshot={version:'v',observedAt:'now',pageId:'p',url:'https://example.test',title:'Test',nodes:[node],frames:[],tabs:[],limitations:[]};
  const root=project(snapshot);assert.ok(root.actions.some(a=>a.op==='inspect'&&a.target==='select'));
  const first=project(snapshot,'select'),seen=new Set<string>();
  for(let i=0;i<first.coverage.pages;i++) {
    const p=project(snapshot,'select',i);assert.ok((p.nodes[0].options?.length??0)<=24);
    for(const a of p.actions.filter(a=>a.op==='select'))seen.add(a.argument!);
  }
  assert.equal(seen.size,300);assert.ok(seen.has('300'));
});

test('fill is the primary editable action; advanced focus and keys remain discoverable',()=>{
  const node:UINode={id:'query',parent:null,frame:'f',tag:'input',role:'searchbox',name:'Search',text:'',source:'semantic',value:'',states:{disabled:false,readonly:false},relations:{},bounds:{x:0,y:0,width:100,height:30},inViewport:true,obscured:false,capabilities:['click','hover','fill','press']};
  const snapshot:Snapshot={version:'v',observedAt:'now',pageId:'p',url:'https://example.test',title:'Test',nodes:[node],frames:[],tabs:[],limitations:[]};
  const primary=project(snapshot);assert.ok(primary.actions.some(a=>a.op==='fill'));
  assert.ok(!primary.actions.some(a=>['click','hover','press'].includes(a.op)));
  assert.ok(primary.actions.some(a=>a.op==='inspect_controls'));
  const advanced=project(snapshot,undefined,0,true);
  for(const op of ['click','hover','press'])assert.ok(advanced.actions.some(a=>a.op===op));
  node.value='Toyota Camry';assert.ok(project(snapshot).actions.some(a=>a.op==='press'&&a.argument==='Enter'));
});
