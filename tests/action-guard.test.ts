import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAction, StaleObservation } from '../src/action-guard.js';
import type { Snapshot,UINode } from '../src/schema.js';
function node(id:string,role:string,parent:string|null=null):UINode{return {id,role,parent,frame:'f',tag:role,name:id,text:'',source:'semantic',states:{disabled:false,readonly:false},relations:{},bounds:{x:0,y:0,width:10,height:10},inViewport:true,obscured:false,capabilities:role==='button'?['click']:[]};}
function fixture():Snapshot {return {version:'v',observedAt:'now',pageId:'p',url:'https://example.test',title:'Page',tabs:[],frames:[{id:'f',parent:null,url:'https://example.test',title:'Page',document:'doc',nodes:[],limitations:[],scanned:0,truncated:false}],nodes:[node('form','form'),node('field','textbox','form'),node('submit','button','form'),node('clock','status')],limitations:[]};}
const action={id:'a',op:'click',target:'submit',label:'Submit'};
test('unrelated page changes do not invalidate a stable target',()=>{const before=fixture(),after=structuredClone(before);after.version='new';after.nodes[3].text='12:15';assert.equal(validateAction(action,before,after)?.id,'submit');});
test('target semantics, form values, descriptions, document and modal changes invalidate actions',()=>{
  const before=fixture();
  for(const mutate of [(s:Snapshot)=>{s.nodes[2].name='Delete';},(s:Snapshot)=>{s.nodes[1].value='Different';},(s:Snapshot)=>{s.frames[0].document='new-document';},(s:Snapshot)=>{s.nodes.push(node('modal','dialog'));},(s:Snapshot)=>{s.nodes[2].obscured=true;}]){const after=structuredClone(before);mutate(after);assert.throws(()=>validateAction(action,before,after),StaleObservation);}
  before.nodes[2].relations.describedBy=['clock'];const after=structuredClone(before);after.nodes[3].text='Fee changed';assert.throws(()=>validateAction(action,before,after),StaleObservation);
});
test('only a unique equivalent replacement in the same context can be rebound',()=>{
  const before=fixture(),after=structuredClone(before);after.nodes[2].id='replacement';assert.equal(validateAction(action,before,after)?.id,'replacement');
  after.nodes.push({...after.nodes[2],id:'duplicate'});assert.throws(()=>validateAction(action,before,after),StaleObservation);
  const other=structuredClone(before);other.nodes[2].id='new';other.nodes[2].parent=null;assert.throws(()=>validateAction(action,before,other),StaleObservation);
});
