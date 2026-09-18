import { readFile, mkdir, writeFile, rename, link, unlink, rm } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
export const serviceDirectory=()=>join(resolve(process.env.JEV_DATA_DIR||join(homedir(),'.local/share/jev-browser')),'service');
const infoSchema=z.object({pid:z.number().int().positive(),instance:z.string().uuid(),protocol:z.literal(1),url:z.string().regex(/^http:\/\/127\.0\.0\.1:\d+\/#([a-f0-9]{48})$/),rpcToken:z.string().regex(/^[a-f0-9]{48}$/),release:z.string()});
export type ServiceInfo=z.infer<typeof infoSchema>;
export async function readService():Promise<ServiceInfo|undefined>{try{return infoSchema.parse(JSON.parse(await readFile(join(serviceDirectory(),'endpoint.json'),'utf8')));}catch{return;}}
export async function atomic(path:string,value:unknown){const tmp=`${path}.${randomUUID()}.tmp`;await writeFile(tmp,JSON.stringify(value),{mode:0o600});await rename(tmp,path);}
function alive(pid:number){try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}}
export async function claimService(instance:string):Promise<boolean>{
  const dir=serviceDirectory();await mkdir(dir,{recursive:true,mode:0o700});const lock=join(dir,'owner.json'),tmp=join(dir,`owner-${instance}`);
  const acquire=async()=>{try{await link(tmp,lock);return true;}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;return false;}};
  await writeFile(tmp,JSON.stringify({pid:process.pid,instance}),{mode:0o600});
  try {
    if(await acquire())return true;
    const recovery=join(dir,'recover');try{await mkdir(recovery);}catch{return false;}
    try {
      const owner=JSON.parse(await readFile(lock,'utf8'));
      if(!Number.isInteger(owner.pid)||alive(owner.pid))return false;
      await unlink(lock);return await acquire();
    }finally{await rm(recovery,{recursive:true,force:true});}
  }finally{await rm(tmp,{force:true});}
}
export async function releaseService(instance:string){const dir=serviceDirectory();try{const owner=JSON.parse(await readFile(join(dir,'owner.json'),'utf8'));if(owner.instance===instance){await rm(join(dir,'endpoint.json'),{force:true});await rm(join(dir,'owner.json'),{force:true});}}catch{}}
export async function serviceCall(info:ServiceInfo,method:string,args:unknown={},sessionId='cli',signal?:AbortSignal):Promise<any>{
  const url=new URL(info.url),token=url.hash.slice(1);url.hash='';url.pathname='/internal/rpc';
  let response:Response;
  try {response=await fetch(url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','X-Jev-Token':token,'X-Jev-Rpc-Token':info.rpcToken},
    body:JSON.stringify({method,args,sessionId}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(55000)]):AbortSignal.timeout(55000)});}
  catch {throw new Error('JEV service connection interrupted. Do not repeat a mutation blindly; inspect the existing task after reconnecting.');}
  const payload=await response.json() as any;if(!response.ok)throw new Error(payload.error||'JEV service request failed.');return payload.result;
}
export async function existingService():Promise<ServiceInfo|undefined>{
  const info=await readService();if(!info)return;
  try {const status=await serviceCall(info,'status',{},'probe',AbortSignal.timeout(1200));if(status.service?.instance===info.instance)return info;}catch{}
}
export async function ensureService():Promise<ServiceInfo>{
  const existing=await existingService();if(existing)return existing;
  const dir=serviceDirectory();await mkdir(dir,{recursive:true,mode:0o700});
  const log=openSync(join(dir,'service.log'),'a',0o600);
  const child=spawn(process.execPath,[fileURLToPath(new URL('./service-main.js',import.meta.url))],{cwd:process.cwd(),detached:true,stdio:['ignore',log,log],env:process.env});
  child.on('error',()=>{});child.unref();closeSync(log);
  const deadline=Date.now()+12000;
  while(Date.now()<deadline){const ready=await existingService();if(ready)return ready;await new Promise(r=>setTimeout(r,100));}
  throw new Error('JEV service did not start. Inspect the private service/service.log in the task data directory.');
}
