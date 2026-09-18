import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { TaskManager } from './engine.js';
import { TaskRequest, defaultConfidence } from './schema.js';

async function body(request:IncomingMessage) {
  const parts:Buffer[]=[];let size=0;
  for await(const part of request) {size+=part.length;if(size>100000) throw new Error('Request too large.');parts.push(part);}
  return JSON.parse(Buffer.concat(parts).toString('utf8')||'{}');
}
export async function dashboard(manager:TaskManager,port=0) {
  const token=randomBytes(24).toString('hex');
  let origin='';
  const server=createServer(async(request,response)=>{
    response.setHeader('Cache-Control','no-store');response.setHeader('X-Content-Type-Options','nosniff');
    response.setHeader('Referrer-Policy','no-referrer');response.setHeader('X-Frame-Options','DENY');
    response.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const reply=(status:number,value:unknown)=>{response.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});response.end(JSON.stringify(value));};
    if(request.headers.host!==new URL(origin).host) return reply(403,{error:'Invalid host.'});
    if(request.headers.origin && request.headers.origin!==origin) return reply(403,{error:'Invalid origin.'});
    const url=new URL(request.url||'/',origin);
    try {
      const assets:Record<string,[string,string]>={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css']};
      if(request.method==='GET'&&assets[url.pathname]) {
        const [file,mime]=assets[url.pathname];
        const data=await readFile(fileURLToPath(new URL(`../../public/${file}`,import.meta.url)));
        response.writeHead(200,{'Content-Type':`${mime}; charset=utf-8`});response.end(data);return;
      }
      const supplied=Buffer.from(String(request.headers['x-jev-token']||''));const expected=Buffer.from(token);
      if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected)) return reply(401,{error:'Open the dashboard using its private launch link.'});
      if(request.method==='GET'&&url.pathname==='/api/status') return reply(200,{configured:!!process.env.OPENROUTER_API_KEY,model:process.env.JEV_MODEL||'typesafe/jev-1.13',tasks:manager.list(),defaults:{browser:"extension",minConfidence:defaultConfidence()},extension:manager.extension.status()});
      if(request.method==='POST'&&url.pathname==='/api/tasks') return reply(201,await manager.start(await body(request)));
      const match=url.pathname.match(/^\/api\/tasks\/([a-f0-9-]{36})(?:\/(pause|resume|cancel|secret))?$/);
      if(match) {
        const [,id,action]=match;
        if(request.method==='GET'&&!action) return reply(200,manager.get(id));
        if(request.method==='POST') {
          if(action==='secret') {
            const data=z.object({target:z.string().min(1).max(200),secret:z.string().min(1).max(4000)}).strict().parse(await body(request));
            try { return reply(200,await manager.fillSecret(id,data.target,data.secret)); }
            finally { data.secret=''; }
          }
          if(action==='pause') return reply(200,await manager.pause(id));
          if(action==='cancel') return reply(200,await manager.cancel(id));
          if(action==='resume') return reply(200,await manager.resume(id,TaskRequest.partial().parse(await body(request))));
        }
      }
      reply(404,{error:'Not found.'});
    } catch(error) {reply(400,{error:error instanceof z.ZodError?'Invalid request fields.':error instanceof Error?error.message:'Request failed.'});}
  });
  const closeExtension=manager.extension.bind(server,()=>origin,token);
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  const address=server.address();if(!address||typeof address==='string') throw new Error('Dashboard did not bind.');
  origin=`http://127.0.0.1:${address.port}`;
  return {url:`${origin}/#${token}`,server,close:()=>{closeExtension();return new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}};
}
