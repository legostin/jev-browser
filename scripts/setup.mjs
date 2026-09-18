import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, lstat, readlink, symlink, cp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeRoot, withLock, run, stage, activate, atomicJSON, json, pointCurrent } from './manage.mjs';
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = runtimeRoot();
const bin = join(homedir(), '.local/bin/jev');
const skill = join(homedir(), '.agents/skills/jev-browser');
const skillTarget = join(root, 'current/skills/jev-browser');
const launcher = join(root, 'launcher.mjs');
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
async function assertManagedLink(path, target) {
  try {
    const info = await lstat(path);
    if (!info.isSymbolicLink() || await readlink(path) !== target) throw new Error(`Путь уже занят: ${path}. Существующие файлы сохранены.`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Требуется Node.js 22+.');
if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Поддерживаются macOS и Linux.');
for (const command of ['git', 'npm', 'codex']) run(command, ['--version'], source, true);
await assertManagedLink(bin, join(root, 'jev'));
await assertManagedLink(skill, skillTarget);
const revision = run('git', ['rev-parse', 'HEAD'], source, true).trim();
await withLock(root, async () => {
  const previous = await json(join(root, 'state.json'), null);
  const release = await stage(root, source, revision);
  let config = process.env.JEV_CONFIG_FILE || join(homedir(), '.config/jev-browser/.env');
  if (!existsSync(config)) {
    // Migration retains the existing key, but moves it outside disposable source checkouts.
    const old = await json(join(homedir(), 'plugins/jev-browser/.mcp.json'), {});
    const oldConfig = old.mcpServers?.['jev-browser']?.env?.JEV_CONFIG_FILE;
    const candidate = existsSync(join(source, '.env')) ? join(source, '.env') : oldConfig;
    if (candidate && existsSync(candidate)) {
      await mkdir(dirname(config), { recursive: true, mode: 0o700 });
      await writeFile(config, await readFile(candidate), { mode: 0o600, flag: 'wx' });
    }
  }
  // Keep stable entry points unchanged on reinstallation: old tasks may still be starting.
  if (!existsSync(launcher)) await cp(join(release, 'scripts/runtime-launcher.mjs'), launcher);
  await writeFile(join(root, 'jev'),
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(launcher)} "$@"\n`, { mode: 0o700 });
  await mkdir(dirname(bin), { recursive: true });
  await mkdir(dirname(skill), { recursive: true });
  const linksCreated = [];
  try {
    await activate(root, release, revision);
    for (const [path, target] of [[bin, join(root, 'jev')], [skill, skillTarget]]) {
      try { await symlink(target, path); linksCreated.push(path); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    await atomicJSON(join(root, 'settings.json'), await json(join(root, 'settings.json'), { autoUpdate: true }));
    await atomicJSON(join(root, 'update-status.json'), { checkedAt: Date.now(), outcome: 'installed', revision });
    run('codex', ['mcp', 'add', 'jev-browser', '--env', `JEV_CONFIG_FILE=${config}`, '--', process.execPath, launcher], source);
  } catch (error) {
    if (previous) { await pointCurrent(root, join(root, 'releases', previous.revision)); await atomicJSON(join(root, 'state.json'), previous); }
    else { await rm(join(root, 'current'), { force: true }); await rm(join(root, 'state.json'), { force: true }); }
    for (const link of linksCreated) await rm(link, { force: true });
    throw error;
  }
  console.log(`\nJEV установлен: MCP + навык Codex.\nАвтообновление: ${(await json(join(root, 'settings.json'))).autoUpdate ? 'включено' : 'выключено'}.\nКоманды: ${bin} status | update | configure\nChrome: ${join(root, 'current/chrome-extension')}\nНачните новую задачу Codex / перезапустите MCP.`);
  if (!existsSync(config) && !process.env.OPENROUTER_API_KEY) console.log(`\nДобавьте ключ с помощью ${bin} configure (скрытый ввод).`);
});
