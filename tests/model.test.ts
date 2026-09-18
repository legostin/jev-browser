import test from 'node:test';
import assert from 'node:assert/strict';
import { JevProvider, modelView } from '../src/model.js';
import { TaskInput, type TaskRecord, type Projection } from '../src/schema.js';
const action={id:'a1',op:'click',target:'n1',label:'Open result'};
const projection={version:'v1',page:{url:'https://example.test',title:'Test'},tabs:[],regions:[],nodes:[],actions:[action],coverage:{total:0,included:0,page:1,pages:1,limitations:[]}} as Projection;
const task={id:'test',input:TaskInput.parse({goal:'Open result',url:'https://example.test'}),history:[],evidence:[]} as unknown as TaskRecord;
test('OpenRouter adapter uses Decisions API, typed choices and does not leak secrets',async()=>{
  process.env.OPENROUTER_API_KEY='test-only-secret';
  let calls=0;
  const provider=new JevProvider(async(url,options)=>{
    calls++;assert.equal(url,'https://openrouter.ai/api/alpha/decisions');
    const body=JSON.parse(options!.body as string);assert.equal(body.model,'typesafe/jev-1.13');assert.equal(body.questions.decision.type,'choice');assert.ok(!('messages'in body));
    return new Response(JSON.stringify({answers:{decision:{type:'choice',choice:'a1',confidence:.93,probabilities:{a1:1}}},usage:{input_tokens:40,cost:.00001}}));
  });
  const result=await provider.choose(projection,task,new AbortController().signal);
  assert.equal(result.action,action);assert.equal(result.confidence,.93);assert.equal(calls,1);assert.ok(!JSON.stringify(result).includes('test-only-secret'));
});
test('invalid choices and invalid confidence never reach execution',async()=>{
  process.env.OPENROUTER_API_KEY='test';
  for(const answer of [{type:'choice',choice:'invented',confidence:.9},{type:'choice',choice:'a1',confidence:2},{type:'choice',choice:'a1',confidence:.9,probabilities:{unknown:1}}]) {
    const p=new JevProvider(async()=>new Response(JSON.stringify({answers:{decision:answer}})));
    await assert.rejects(()=>p.choose(projection,task,new AbortController().signal));
  }
});
test('provider errors exclude upstream response body and do not silently retry',async()=>{
  process.env.OPENROUTER_API_KEY='test';let calls=0;
  const p=new JevProvider(async()=>{calls++;return new Response('secret page data',{status:429});});
  await assert.rejects(()=>p.choose(projection,task,new AbortController().signal),e=>String(e).includes('429')&&!String(e).includes('secret page data'));
  assert.equal(calls,1);
});

test('decision receives prepared field values and plan without duplicate actions or geometry',async()=>{
  process.env.OPENROUTER_API_KEY='test';
  const input=TaskInput.parse({goal:'Search for Camry',url:'https://example.test',plan:['Fill the site search','Submit and open the matching article'],values:[{label:'Site search query',text:'Toyota Camry'}]});
  const p=new JevProvider(async(_,options)=>{
    const body=JSON.parse(options!.body as string);
    assert.deepEqual(body.state.availableFieldValues,input.values);
    assert.deepEqual(body.state.suggestedPlan,input.plan);
    assert.equal(body.state.interface.actions,undefined);
    return new Response(JSON.stringify({answers:{decision:{type:'choice',choice:'a1',confidence:.9}}}));
  });
  await p.choose(projection,{...task,input},new AbortController().signal);
});
test('compact references preserve target, parent, relationships and false toggle states',()=>{
  const node:any={id:'long-original-id',parent:'parent-id',frame:'frame-id',role:'checkbox',name:'Available',text:'Available',states:{disabled:false,readonly:false,checked:false,expanded:false},relations:{labelledby:['label-id']},bounds:{x:1,y:1,width:10,height:10},inViewport:true,obscured:false};
  const p={...projection,nodes:[node],actions:[{...action,target:node.id}]};
  const view=modelView(p),n=view.interface.nodes[0];
  assert.equal(view.criteria.a1.target,n.id);assert.equal(n.states.checked,false);assert.equal(n.states.expanded,false);
  assert.ok(n.parent);assert.ok(n.relations.labelledby[0]);assert.ok(!JSON.stringify(view).includes('long-original-id'));
  assert.ok(!('bounds' in n));
});

test('plugin browser context is sent for both action selection and exact text selection',async()=>{
  process.env.OPENROUTER_API_KEY='test';const requests:any[]=[];
  const t={...task,history:[{step:1,op:'click',label:'Open search',url:'https://example.test/home',outcome:'executed',version:'v',at:'now',context:{from:{tab:'t1',url:'https://example.test/home',title:'Home'},to:{tab:'t1',url:'https://example.test/search',title:'Search'}}}]};
  const p=new JevProvider(async(_,options)=>{const body=JSON.parse(options!.body as string);requests.push(body);return new Response(JSON.stringify({answers:{decision:{type:'choice',choice:requests.length===1?'a1':'v0',confidence:.99}}}));});
  await p.choose(projection,t,new AbortController().signal);await p.text(projection,t,action,new AbortController().signal);
  for(const r of requests){assert.equal(r.state.browserContext.recentSteps[0].from.url,'https://example.test/home');assert.equal(r.state.browserContext.recentSteps[0].to.url,'https://example.test/search');assert.equal(r.state.browserContext.recentSteps[0].operation,'click');}
});
