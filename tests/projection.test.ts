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

function groupNode(id:string,role:string,parent:string|null=null):UINode{return {id,role,parent,frame:'f',tag:role,name:id,text:'',source:'semantic',states:{disabled:false,readonly:false},relations:{},bounds:{x:0,y:0,width:10,height:10},inViewport:true,obscured:false,capabilities:role==='textbox'?['fill']:[]};}
function groupSnapshot(nodes:UINode[]):Snapshot{return {version:'v',observedAt:'now',pageId:'p',url:'https://example.test',title:'Test',nodes,frames:[],tabs:[],limitations:[]};}
test('forms stay whole beyond soft slice size through empty layout wrappers; dialogs take priority',()=>{
  const wrapper={...groupNode('wrapper','group','form'),name:'',source:'layout' as const};
  const nodes=[groupNode('form','form'),wrapper,...Array.from({length:30},(_,i)=>groupNode(`field${i}`,'textbox','wrapper')),groupNode('dialog','dialog'),groupNode('confirm','textbox','dialog')];
  const s=groupSnapshot(nodes),first=project(s),second=project(s,undefined,1);
  assert.ok(first.nodes.some(n=>n.id==='dialog'));assert.equal(first.coverage.pages,2);
  assert.equal(second.nodes.filter(n=>n.role==='textbox').length,30);assert.ok(second.nodes.some(n=>n.id==='wrapper'));
  assert.deepEqual(second.groups?.find(g=>g.id==='form'),{id:'form',role:'form',name:'form',total:31,included:31,complete:true});
});
test('oversized forms report partial coverage and remain completely discoverable',()=>{
  const s=groupSnapshot([groupNode('form','form'),...Array.from({length:90},(_,i)=>groupNode(`f${i}`,'textbox','form'))]);
  const first=project(s);assert.ok(first.groups?.some(g=>!g.complete));assert.ok(first.coverage.limitations.some(x=>x.includes('64')));
  const seen=new Set<string>();for(let i=0;i<first.coverage.pages;i++)for(const n of project(s,undefined,i).nodes)seen.add(n.id);
  assert.equal(seen.size,s.nodes.length);
});
test('change context reports bounded semantic differences and navigation',()=>{
  const before=groupSnapshot([groupNode('field','textbox')]),after=structuredClone(before);after.nodes[0].value='Camry';
  const p=project(after,undefined,0,false,[],before);assert.equal(p.changes?.kind,'update');if(p.changes?.kind==='update')assert.equal(p.changes.counts.changed,1);
  after.url+='/?search=Camry';assert.equal(project(after,undefined,0,false,[],before).changes?.kind,'navigation');assert.equal(project(before).changes?.kind,'initial');
});
