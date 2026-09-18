import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { JevProvider } from '../src/model.js';
import { project } from '../src/projection.js';
import { loadConfig } from '../src/config.js';
import type { TaskRecord } from '../src/schema.js';
loadConfig();
const file=process.argv[2];if(!file)throw new Error('Pass a saved task JSON path.');
const task=JSON.parse(await readFile(file,'utf8')) as TaskRecord;
task.input.goal='Найди и открой статью Toyota Camry в русской Википедии. Не редактируй страницы. Оставь статью открытой.';
task.history=[];task.evidence=[];
task.input.plan=['Найти поле поиска и ввести Toyota Camry','Выполнить поиск','Открыть статью Toyota Camry и проверить заголовок'];
const p=project(task.snapshot!);
const result=await new JevProvider().choose(p,task,new AbortController().signal);
const summary={choice:result.action.label,confidence:result.confidence,actions:p.actions.length,nodes:p.nodes.length,latencyMs:result.latencyMs,usage:result.usage,
  alternatives:Object.entries(result.probabilities).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([id,probability])=>({action:p.actions.find(a=>a.id===id)?.label,probability}))};
await mkdir('artifacts',{recursive:true});await writeFile(`artifacts/replay-${process.argv[3]||'latest'}.json`,JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));
