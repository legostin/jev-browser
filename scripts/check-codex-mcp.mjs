import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const child=spawn('codex',['app-server','--stdio'],{stdio:['pipe','pipe','pipe']});
const waiting=new Map();let seq=0;
const lines=createInterface({input:child.stdout});
lines.on('line',line=>{try{const m=JSON.parse(line);if(waiting.has(m.id)){const p=waiting.get(m.id);waiting.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}}catch{}});
child.stderr.resume();
const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;waiting.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
const timeout=setTimeout(()=>{console.error('Codex MCP inventory timed out');child.kill();process.exitCode=1;},60000);
try{
 await rpc('initialize',{clientInfo:{name:'jev-diagnostics',version:'1.0.0'},capabilities:{experimentalApi:true}});
 child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
 const list=await rpc('mcpServerStatus/list',{limit:100,detail:'toolsAndAuthOnly'});
 const matches=list.data.filter(s=>s.name.includes('jev'));
 console.log(JSON.stringify(matches.map(s=>({name:s.name,pluginId:s.pluginId,runtimeStatus:s.runtimeStatus,tools:Object.keys(s.tools)})),null,2));
 if(!matches.some(s=>Object.keys(s.tools).some(t=>t.includes('jev_run'))))process.exitCode=1;
}finally{clearTimeout(timeout);child.stdin.end();child.kill();lines.close();}
