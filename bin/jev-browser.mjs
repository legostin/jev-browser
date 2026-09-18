#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repository='https://github.com/legostin/jev-browser.git';
const help=`JEV Browser — установка и запуск через npx

  install [--client codex|claude|both]  Подключить MCP и навык
  start                Запустить общий сервис и показать ссылку на панель
  mcp                  Подключить MCP через установленный runtime
  status | doctor      Проверить установленную версию и настройки
  configure            Сохранить ключ OpenRouter (скрытый ввод)
  update               Установить обновление
  service status|stop|restart
  confidence 0..1 | auto-update on|off | rollback | run task.json

Без аргументов: start. После установки перезапустите подключение MCP.
Chrome Companion подключается вручную через chrome://extensions.
`;
export function execute(command,args,{capture=false}={}) {
  const result=spawnSync(command,args,{encoding:'utf8',stdio:capture?['ignore','pipe','pipe']:'inherit',
    env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never'}});
  if(result.error||result.status!==0)throw new Error(`Не удалось выполнить ${command}. Проверьте установку инструментов и доступ к репозиторию.`);
  return result.stdout||'';
}
export function installClients(args=[]) {
  if(!args.length)return ['codex'];
  if(args.length!==2||args[0]!=='--client'||!['codex','claude','both'].includes(args[1]))throw new Error('install принимает только --client codex|claude|both.');
  return args[1]==='both'?['codex','claude']:[args[1]];
}
export async function install({run=execute,temporary=tmpdir(),args=[]}={}) {
  const clients=installClients(args);
  if(Number(process.versions.node.split('.')[0])<22)throw new Error('Требуется Node.js 22+.');
  if(!['darwin','linux'].includes(process.platform))throw new Error('Поддерживаются macOS и Linux.');
  for(const command of ['git','npm',...clients])run(command,['--version'],{capture:true});
  const stage=await mkdtemp(join(temporary,'jev-npx-'));
  try {
    let gh=false;try{run('gh',['auth','status'],{capture:true});gh=true;}catch{}
    const source=join(stage,'source');
    if(gh)run('gh',['repo','clone','legostin/jev-browser',source,'--','--depth','1','--branch','main']);
    else run('git',['clone','--depth','1','--branch','main',repository,source]);
    run(process.execPath,[join(source,'scripts/setup.mjs'),...args]);
  }finally{await rm(stage,{recursive:true,force:true});}
}
export async function main(args,dependencies={}) {
  const {root=join(homedir(),'.local/share/jev-browser/runtime'),run=execute,installRuntime=install,output=console.log}=dependencies;
  const command=args[0]||'start';
  if(['help','--help','-h'].includes(command)){output(help);return;}
  const commands=new Set(['install','start','serve','mcp','status','doctor','configure','update','service','confidence','auto-update','rollback','run']);
  if(!commands.has(command))throw new Error(`Неизвестная команда: ${command}. Используйте --help.`);
  if(command==='install'){installClients(args.slice(1));await installRuntime({args:args.slice(1)});return;}
  const launcher=join(root,'launcher.mjs');
  if(!existsSync(launcher)||!existsSync(join(root,'current')))throw new Error('JEV ещё не установлен. Сначала выполните эту же команду npx с аргументом install.');
  // Always use the durable installation, never the disposable npx cache as an MCP path.
  const forwarded=args.length?[...args]:['start'];if(command==='start')forwarded[0]='serve';
  run(process.execPath,[launcher,...forwarded]);
}
if(process.argv[1]&&realpathSync(resolve(process.argv[1]))===fileURLToPath(import.meta.url)) {
  try{await main(process.argv.slice(2));}catch(error){console.error(error instanceof Error?error.message:'JEV command failed.');process.exitCode=1;}
}
