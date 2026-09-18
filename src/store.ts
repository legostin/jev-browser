import { mkdir, writeFile, rename, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { TaskRecord } from './schema.js';

export class TaskStore {
  constructor(readonly directory = process.env.JEV_DATA_DIR || join(homedir(),'.local','share','jev-browser')) {}
  async save(task: TaskRecord) {
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const path = join(this.directory,`${task.id}.json`), temporary = `${path}.tmp`;
    await writeFile(temporary,JSON.stringify(task),{mode:0o600});
    await rename(temporary,path);
  }
  async load(): Promise<TaskRecord[]> {
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const names = (await readdir(this.directory)).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n));
    const tasks:TaskRecord[]=[];
    for (const name of names) {
      try {
        const record = JSON.parse(await readFile(join(this.directory,name),'utf8')) as TaskRecord;
        if (!record.id || !record.input?.goal) continue;
        if (!['completed','cancelled'].includes(record.status)) {
          record.status='paused'; record.message='Service restarted. Resume opens the last URL in a new session; previous form state and login are not restored.';
        }
        tasks.push(record);
      } catch { /* A damaged record does not hide other tasks. */ }
    }
    return tasks;
  }
}
