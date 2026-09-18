import { existsSync } from 'node:fs';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const source=resolve(fileURLToPath(new URL('..',import.meta.url)));
const target=join(homedir(),'plugins','jev-browser');
const creator=join(homedir(),'.codex','skills','.system','plugin-creator','scripts','create_basic_plugin.py');
const marketplace=join(homedir(),'.agents','plugins','marketplace.json');
if(!existsSync(creator))throw new Error('The Codex plugin-creator skill is required for personal marketplace registration.');
if(!existsSync(join(source,'dist','src','mcp.js')))throw new Error('Build first: npm ci && npm run build');
if(existsSync(target))throw new Error('The personal source already exists. Use the documented update workflow; this installer never overwrites an existing plugin.');
execFileSync('python3',[creator,'jev-browser','--with-skills','--with-mcp','--with-marketplace'],{stdio:'inherit'});
await cp(source,target,{recursive:true,filter:path=>{
  const name=basename(path);
  if(['artifacts','.git'].includes(name))return false;
  return (name!=='.env'&&!name.startsWith('.env.'))||name==='.env.example';
}});
// Keep credentials in the original private project file, outside the plugin archive/cache.
const mcp=JSON.parse(await readFile(join(target,'.mcp.json'),'utf8'));
if(existsSync(join(source,'.env')))mcp.mcpServers['jev-browser'].env={JEV_CONFIG_FILE:join(source,'.env')};
await writeFile(join(target,'.mcp.json'),JSON.stringify(mcp,null,2)+'\n');
const market=JSON.parse(await readFile(marketplace,'utf8'));
if(!/^[A-Za-z0-9_-]+$/.test(market.name))throw new Error('Invalid marketplace name.');
execFileSync('codex',['plugin','add',`jev-browser@${market.name}`],{stdio:'inherit'});
console.log(`Installed source: ${target}\nMarketplace: ${marketplace}\nStart a new Codex task to load the plugin.`);
