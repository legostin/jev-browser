import { mkdir,writeFile } from 'node:fs/promises';
import { TaskManager } from '../src/engine.js';
import { TaskStore } from '../src/store.js';
import { loadConfig } from '../src/config.js';
loadConfig();
const manager=new TaskManager(new TaskStore('artifacts/wikipedia-tasks'));
let last='';manager.on('change',id=>{const t=manager.get(id);const line=`${t.status}: ${t.message}`;if(line!==last){console.log(line);last=line;}});
try {
  const t=await manager.start({goal:'Найди и открой статью Toyota Camry в русской Википедии. Не редактируй страницы.',
    url:'https://ru.wikipedia.org/wiki/Заглавная_страница',headless:true,
    plan:['Найти поле поиска и ввести Toyota Camry','Выполнить поиск','Открыть статью Toyota Camry и проверить заголовок'],
    values:[{label:'Поисковый запрос для поля «Искать в Википедии»',text:'Toyota Camry'}],
    checks:[{kind:'url_contains',value:'ru.wikipedia.org/wiki/Toyota_Camry'},{kind:'text_contains',value:'Toyota Camry'}],maxSteps:20,maxSeconds:180});
  while(manager.get(t.id).status==='running')await new Promise(r=>setTimeout(r,200));
  const r=manager.get(t.id);
  const report={status:r.status,message:r.message,steps:r.steps,requests:r.requests,elapsedMs:r.elapsedMs,reportedCost:r.cost,inputTokens:r.inputTokens,
    page:r.snapshot?.url,verification:r.verification,lastDecision:r.lastDecision,history:r.history};
  await mkdir('artifacts',{recursive:true});await writeFile('artifacts/live-wikipedia.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));if(r.status!=='completed')process.exitCode=1;
} finally {await manager.shutdown();}
