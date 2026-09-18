import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { BrowserAdapter, StaleObservation } from '../src/browser.js';
import { project } from '../src/projection.js';

const html=`<!doctype html><html><body><header><h1>Universal interface fixture</h1></header><main>
<form id="search"><label for="query">Search catalogue</label><input id="query" aria-describedby="hint" placeholder="Search"><span id="hint">Enter a model</span><button>Search</button></form>
<section aria-label="Results"><article><h2>Toyota Camry 2026</h2><p>19 500 000 KZT</p><a href="/car" target="_blank">Open listing</a></article><article><h2>Honda Accord 2025</h2><p>18 000 000 KZT</p></article></section>
<label><input type="checkbox" id="new">New only</label><label>City<select id="city"><option value="">Choose</option><option value="ala">Almaty</option><option disabled>Unavailable</option></select></label>
<input type="password" value="DO_NOT_SEND_THIS"><button disabled>Unavailable action</button>
<div id="scroller" style="height:60px;overflow:auto"><div style="height:600px"><button id="nested">Inside scroll area</button><p>Nested content</p></div></div>
<div id="shadow"></div><iframe title="Address" src="/frame"></iframe><canvas width="30" height="30"></canvas>
<table><caption>Specifications</caption><tr><th>Year</th><td>2026</td></tr></table>
<div id="result" role="status"></div></main><script>
document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button aria-label="Shadow action">Inside shadow</button>';
document.querySelector('#search').onsubmit=e=>{e.preventDefault();document.querySelector('#result').textContent='Results for '+document.querySelector('#query').value;};
document.querySelector('#new').onchange=()=>document.querySelector('#result').textContent='New filter applied';
</script></body></html>`;
let url:string,server:ReturnType<typeof createServer>;
test.before(async()=>{
  server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(req.url==='/frame'?'<html><body><label>Email<input type="email"></label><button>Frame action</button></body></html>':req.url==='/car'?'<h1>Toyota Camry 2026</h1><p>Listing details</p>':html);});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const a=server.address() as any;url=`http://127.0.0.1:${a.port}`;
});
test.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));});

test('deterministic collector preserves groups, labels, state, frames and open shadow DOM',async()=>{
  const b=new BrowserAdapter();try{
    await b.open(url,true);const s=await b.observe();
    assert.equal(s.frames.length,2);
    const query=s.nodes.find(n=>n.role==='textbox'&&n.name==='Search catalogue')!;
    assert.ok(query);assert.ok(query.relations.labelledBy.length);assert.ok(query.relations.describedBy.length);
    assert.ok(s.nodes.some(n=>n.name==='Shadow action'));
    assert.ok(s.nodes.some(n=>n.name==='Frame action'));
    assert.ok(s.nodes.some(n=>n.role==='table'));
    assert.ok(s.nodes.some(n=>n.scroll&&n.scroll.maxY>0&&n.tag==='div'));
    assert.ok(s.limitations.some(x=>x.includes('Canvas')));
    assert.ok(!JSON.stringify(s).includes('DO_NOT_SEND_THIS'));
    assert.deepEqual(s.nodes.find(n=>n.name==='Unavailable action')?.capabilities,[]);
    const articles=s.nodes.filter(n=>n.role==='article');assert.equal(articles.length,2);
    const first=s.nodes.find(n=>n.text==='19 500 000 KZT')!;assert.equal(first.parent,articles[0].id);
    const again=await b.observe();assert.equal(again.version,s.version);assert.equal(again.nodes.find(n=>n.name==='Search catalogue')?.id,query.id);
  }finally{await b.close();}
});
test('executor fills, submits, selects, toggles, scrolls and rejects stale decisions',async()=>{
  const b=new BrowserAdapter();try{
    await b.open(url,true);let s=await b.observe();
    const query=s.nodes.find(n=>n.name==='Search catalogue'&&n.role==='textbox')!;
    await b.act({id:'test',op:'fill',target:query.id,label:'Search'},s,'Toyota Camry 2026');
    await assert.rejects(()=>b.act({id:'old',op:'click',target:query.id,label:'stale'},s),StaleObservation);
    s=await b.observe();assert.equal(s.nodes.find(n=>n.id===query.id)?.value,'Toyota Camry 2026');
    await b.act({id:'test',op:'press',target:query.id,label:'submit',argument:'Enter'},s);
    s=await b.observe();assert.ok(s.nodes.some(n=>n.text==='Results for Toyota Camry 2026'));
    const city=s.nodes.find(n=>n.tag==='select')!;
    assert.deepEqual(city.options?.map(o=>o.value),['','ala','Unavailable']);
    await b.act({id:'test',op:'select',target:city.id,label:'city',argument:'1'},s);
    s=await b.observe();assert.equal(s.nodes.find(n=>n.id===city.id)?.value,'ala');
    const checkbox=s.nodes.find(n=>n.role==='checkbox')!;await b.act({id:'test',op:'set_checked',target:checkbox.id,label:'new',argument:'true'},s);
    s=await b.observe();assert.equal(s.nodes.find(n=>n.id===checkbox.id)?.states.checked,true);
    const scroll=s.nodes.find(n=>n.tag==='div'&&n.scroll&&n.scroll.maxY>0)!;
    await b.act({id:'test',op:'scroll',target:scroll.id,label:'scroll',argument:'down'},s);
    s=await b.observe();assert.ok(s.nodes.find(n=>n.id===scroll.id)!.scroll!.y>0);
  }finally{await b.close();}
});
test('owned popup tabs and frame targets remain addressable',async()=>{
  const b=new BrowserAdapter();try{
    await b.open(url,true);let s=await b.observe();
    const frameField=s.nodes.find(n=>n.role==='textbox'&&n.name==='Email')!;
    await b.act({id:'x',op:'fill',target:frameField.id,label:'frame'},s,'demo@example.test');
    s=await b.observe();assert.equal(s.nodes.find(n=>n.id===frameField.id)?.value,'demo@example.test');
    const link=s.nodes.find(n=>n.name==='Open listing')!;
    await b.act({id:'x',op:'click',target:link.id,label:'open'},s);
    s=await b.observe();assert.equal(s.tabs.length,2);
    const popup=s.tabs.find(t=>!t.active)!;
    await b.act({id:'x',op:'switch_tab',argument:popup.id,label:'switch'},s);
    s=await b.observe();assert.ok(s.url.endsWith('/car'));
  }finally{await b.close();}
});
test('all observation slices are reachable without silent node truncation',async()=>{
  const b=new BrowserAdapter();try{await b.open(url,true);const s=await b.observe();const first=project(s);const ids=new Set<string>();for(let i=0;i<first.coverage.pages;i++)for(const n of project(s,undefined,i).nodes)ids.add(n.id);for(const n of s.nodes)if(!ids.has(n.id)){assert.equal(n.source,'layout');assert.equal(n.capabilities.length,0);assert.equal(n.name,'');assert.equal(n.text,'');}assert.ok(first.coverage.pages>1);}finally{await b.close();}
});

test('navigation interruption retries observation, while unrelated collector errors surface',async()=>{
  const b=new BrowserAdapter();try{
    await b.open(url,true);
    const frame=(b as any).page.mainFrame(),evaluate=frame.evaluate.bind(frame);let reads=0;
    frame.evaluate=async(...args:unknown[])=>{reads++;if(reads===1)throw new Error('Execution context was destroyed, most likely because of a navigation');return evaluate(...args);};
    const s=await b.observe();assert.ok(s.nodes.length>0);assert.ok(reads>1);
    reads=0;frame.evaluate=async()=>{reads++;throw new Error('Unexpected collector failure');};
    await assert.rejects(()=>b.observe(),/Unexpected collector failure/);assert.equal(reads,1);
    frame.evaluate=evaluate;
  }finally{await b.close();}
});

test('executor tolerates unrelated updates and rebinds a replaced live control',async()=>{
  const b=new BrowserAdapter();try {
    await b.open(url,true);const page=(b as any).page;
    let s=await b.observe();const input=s.nodes.find(n=>n.role==='textbox'&&n.name==='Search catalogue')!;
    await page.evaluate(()=>{document.querySelector('#result')!.textContent='Unrelated update';const el=document.querySelector('#query')!;el.replaceWith(el.cloneNode(true));});
    const result=await b.act({id:'fill',op:'fill',target:input.id,label:'Search'},s,'Camry');
    assert.ok(result?.rebound);assert.notEqual(result?.target,input.id);assert.equal(await page.locator('#query').inputValue(),'Camry');
    s=await b.observe();const link=s.nodes.find(n=>n.name==='Open listing')!;
    await page.evaluate(()=>{document.querySelector('article p')!.textContent='Price changed';});
    await assert.rejects(b.act({id:'click',op:'click',target:link.id,label:'Open'},s),StaleObservation);
    assert.equal((await b.observe()).tabs.length,1);
  }finally{await b.close();}
});
