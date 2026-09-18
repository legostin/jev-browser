import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { endianness } from 'node:os';
import { loadConfig } from './config.js';
import { ensureService, existingService } from './service-client.js';

// Only this extension receives the private endpoint. Nothing is exposed over HTTP discovery.
const manifest=JSON.parse(await readFile(new URL('../../chrome-extension/manifest.json',import.meta.url),'utf8'));
const id=createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
if(process.argv[2]!==`chrome-extension://${id}/`)process.exit(1);
loadConfig();
const little=endianness()==='LE';
let buffer=Buffer.alloc(0),handled=false;
const timer=setTimeout(()=>process.exit(1),18000);
function reply(value:unknown){
  const body=Buffer.from(JSON.stringify(value)),header=Buffer.alloc(4);
  if(little)header.writeUInt32LE(body.length);else header.writeUInt32BE(body.length);
  clearTimeout(timer);process.stdout.write(Buffer.concat([header,body]),()=>process.exit(0));
}
process.stdin.on('data',chunk=>{
  if(handled)return;
  buffer=Buffer.concat([buffer,chunk]);if(buffer.length<4)return;
  const size=little?buffer.readUInt32LE():buffer.readUInt32BE();
  if(size>4096||size===0){handled=true;reply({error:'Invalid native request'});return;}
  if(buffer.length<4+size)return;
  handled=true;
  void(async()=>{
    const request=JSON.parse(buffer.subarray(4,4+size).toString('utf8'));
    if(request.type!=='endpoint'||(request.start!==undefined&&typeof request.start!=='boolean'))throw new Error('Invalid request');
    const info=request.start?await ensureService():await existingService();
    reply(info?{url:info.url}:{unavailable:true});
  })().catch(()=>reply({error:'Local JEV is unavailable. Run the installer again or check jev doctor.'}));
});
