import { readFile,mkdtemp,rm } from 'node:fs/promises';
import { homedir,tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const version=JSON.parse(await readFile(join(homedir(),'plugins','jev-browser','.codex-plugin','plugin.json'),'utf8')).version;
const root=join(homedir(),'.codex','plugins','cache','personal','jev-browser',version);
const config=JSON.parse(await readFile(join(root,'.mcp.json'),'utf8')).mcpServers['jev-browser'];
const data=await mkdtemp(join(tmpdir(),'jev-installed-'));
const client=new Client({name:'jev-install-check',version:'1.0.0'});
const transport=new StdioClientTransport({command:config.command,args:config.args.map(a=>a==='scripts/mcp-launcher.mjs'?join(root,a):a),cwd:tmpdir(),env:{...process.env,...config.env,JEV_DATA_DIR:data,JEV_EPHEMERAL:'1'}});
try{await client.connect(transport);const tools=await client.listTools();const response=await client.callTool({name:'jev_status',arguments:{}});const status=JSON.parse(response.content[0].text);console.log(JSON.stringify({installedTools:tools.tools.length,configured:status.configured,model:status.model}));if(!status.configured)process.exitCode=1;}finally{await client.close();await rm(data,{recursive:true,force:true});}
