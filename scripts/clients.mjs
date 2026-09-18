import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
export async function registerClaude({run,node=process.execPath,launcher,config,home=homedir()}) {
  const server={type:'stdio',command:node,args:[launcher],env:{JEV_CONFIG_FILE:config}};
  let previous;
  try{previous=JSON.parse(await readFile(join(home,'.claude.json'),'utf8')).mcpServers?.['jev-browser'];}
  catch(error){if(error.code!=='ENOENT')throw error;}
  if(previous&&JSON.stringify(previous)===JSON.stringify(server))return;
  if(previous&&(previous.args?.[0]!==launcher||previous.command!==node))throw new Error('Claude Code already has a different jev-browser server. Existing registration was preserved.');
  if(previous)run('claude',['mcp','remove','--scope','user','jev-browser']);
  try{run('claude',['mcp','add-json','--scope','user','jev-browser',JSON.stringify(server)]);}
  catch(error){if(previous)run('claude',['mcp','add-json','--scope','user','jev-browser',JSON.stringify(previous)]);throw error;}
}
