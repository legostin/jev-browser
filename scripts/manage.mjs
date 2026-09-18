import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename, symlink, realpath, rm, mkdtemp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
const repository = 'https://github.com/legostin/jev-browser.git';
export const runtimeRoot = () => join(homedir(), '.local/share/jev-browser/runtime');
export async function json(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
export async function atomicJSON(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}
export async function pointCurrent(root, release) {
  const temp = join(root, `current-${randomUUID()}`);
  await symlink(release, temp);
  await rename(temp, join(root, 'current'));
}
export async function withLock(root, operation) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = join(root, 'update.lock');
  try { await mkdir(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Never steal a live lock, even if a slow download takes a long time.
    const recovery = join(root, 'lock-recovery');
    try { await mkdir(recovery); } catch { throw new Error('Установка уже выполняется (восстановление блокировки).'); }
    try {
    const owner = await json(join(lock, 'owner.json'), null);
    if (!owner) throw new Error('Установка уже выполняется (update.lock).');
    try { process.kill(owner.pid, 0); throw new Error('Установка уже выполняется.'); }
    catch (check) { if (check.code !== 'ESRCH') throw check; }
    await rm(lock, { recursive: true });
    await mkdir(lock); // Concurrent recovery loses safely rather than proceeding twice.
    } finally { await rm(recovery, { recursive: true, force: true }); }
  }
  await atomicJSON(join(lock, 'owner.json'), { pid: process.pid });
  try { return await operation(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}
export function run(command, args, cwd, capture = false) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeout: 600000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } });
}
export async function smoke(release) {
  // Exercise the real stdio handshake + tool inventory, without API calls or user task storage.
  const { Client } = await import(pathToFileURL(join(release, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')).href);
  const { StdioClientTransport } = await import(pathToFileURL(join(release, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js')).href);
  const data = await mkdtemp(join(tmpdir(), 'jev-install-check-'));
  const client = new Client({ name: 'jev-updater-check', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(release, 'scripts/mcp-launcher.mjs')],
    cwd: tmpdir(), env: { ...process.env, JEV_DATA_DIR: data, JEV_AUTO_UPDATE: '0' }, stderr: 'pipe' });
  // Drain, but never include server diagnostics (or credentials) in installer output.
  transport.stderr?.resume();
  let timer;
  try {
    await Promise.race([(async () => {
      await client.connect(transport);
      const tools = await client.listTools();
      for (const name of ['jev_status', 'jev_run', 'jev_task', 'jev_inspect', 'jev_pause', 'jev_resume', 'jev_cancel'])
        if (!tools.tools.some(tool => tool.name === name)) throw new Error(`MCP tool missing: ${name}`);
    })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MCP startup check timed out')), 20000); })]);
  } finally { clearTimeout(timer); await client.close(); await rm(data, { recursive: true, force: true }); }
}
export async function stage(root, source, revision, dependencies = { run, smoke }) {
  if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new Error('Invalid Git revision');
  const release = join(root, 'releases', revision);
  if (existsSync(join(release, '.ready'))) { await dependencies.smoke(release); return release; }
  await mkdir(join(root, 'releases'), { recursive: true });
  const pending = await mkdtemp(join(root, 'releases', '.staging-'));
  try {
    // Git exports tracked content only. No project .env, local logs, node_modules or credentials.
    const archive = join(pending, 'source.tar');
    dependencies.run('git', ['archive', '--format=tar', `--output=${archive}`, revision], source);
    dependencies.run('tar', ['-xf', archive, '-C', pending], source);
    await rm(archive);
    if (existsSync(join(pending, '.env'))) throw new Error('Release contains a private .env file');
    dependencies.run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], pending);
    dependencies.run('npm', ['run', 'check'], pending);
    dependencies.run('npm', ['run', 'build'], pending);
    await dependencies.smoke(pending);
    await writeFile(join(pending, '.ready'), revision);
    await rename(pending, release);
    return release;
  } catch (error) { await rm(pending, { recursive: true, force: true }); throw error; }
}
export async function activate(root, release, revision) {
  const state = await json(join(root, 'state.json'), {});
  await pointCurrent(root, release);
  await atomicJSON(join(root, 'state.json'), { revision, previous: state.revision === revision ? state.previous : state.revision, updatedAt: Date.now() });
}
export async function update(root, automatic = false, dependencies = { run, stage }) {
  return withLock(root, async () => {
    const settings = await json(join(root, 'settings.json'));
    const last = await json(join(root, 'update-status.json'), { checkedAt: 0 });
    if (automatic && (!settings.autoUpdate || process.env.JEV_AUTO_UPDATE === '0' || Date.now() - last.checkedAt < 86400000)) return;
    await atomicJSON(join(root, 'update-status.json'), { checkedAt: Date.now(), outcome: 'checking' });
    const temp = await mkdtemp(join(root, 'fetch-'));
    try {
      let hasGh = false;
      try { dependencies.run('gh', ['auth', 'status'], root, true); hasGh = true; } catch {}
      if (hasGh) dependencies.run('gh', ['repo', 'clone', 'legostin/jev-browser', join(temp, 'source'), '--', '--depth', '1', '--branch', 'main'], root);
      else dependencies.run('git', ['clone', '--depth', '1', '--branch', 'main', repository, join(temp, 'source')], root);
      const revision = dependencies.run('git', ['rev-parse', 'HEAD'], join(temp, 'source'), true).trim();
      const state = await json(join(root, 'state.json'));
      if (revision !== state.revision) {
        const release = await dependencies.stage(root, join(temp, 'source'), revision);
        await activate(root, release, revision);
      }
      await atomicJSON(join(root, 'update-status.json'), { checkedAt: Date.now(), outcome: revision === state.revision ? 'current' : 'updated', revision });
      console.log(revision === state.revision ? 'JEV уже обновлён.' : 'JEV обновлён. Новая версия включится при следующем запуске MCP. Расширение Chrome: нажмите Reload.');
    } catch (error) {
      // Never persist raw subprocess error output: it may include credential helper details.
      await atomicJSON(join(root, 'update-status.json'), { checkedAt: Date.now(), outcome: 'failed' });
      throw new Error('Обновление не установлено. Предыдущая версия сохранена. Проверьте доступ к GitHub, npm и повторите jev update.');
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
}
export async function configure() {
  const config = process.env.JEV_CONFIG_FILE || join(homedir(), '.config/jev-browser/.env');
  if (!process.stdin.isTTY) throw new Error('Для ввода ключа откройте терминал и выполните ~/.local/bin/jev configure');
  const { createInterface } = await import('node:readline/promises');
  const { Writable } = await import('node:stream');
  const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const input = createInterface({ input: process.stdin, output, terminal: true });
  process.stderr.write('OpenRouter API key (ввод скрыт): ');
  let key;
  try { key = (await input.question('')).trim(); } finally { input.close(); process.stderr.write('\n'); }
  if (!/^sk-or-[A-Za-z0-9-]+$/.test(key)) throw new Error('Некорректный формат ключа. Файл не изменён.');
  await mkdir(dirname(config), { recursive: true, mode: 0o700 });
  const prior = existsSync(config) ? await readFile(config, 'utf8') : '';
  const lines = prior.split('\n').filter(line => !/^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=/.test(line));
  const temp = `${config}.${randomUUID()}.tmp`;
  await writeFile(temp, `${lines.join('\n').trim()}\nOPENROUTER_API_KEY=${key}\n`, { mode: 0o600 });
  await rename(temp, config);
  console.log('Ключ сохранён. Перезапустите MCP / начните новую задачу Codex.');
}
export async function main(root, args) {
  const [command, value] = args;
  if (command === 'update') return update(root, value === '--auto');
  if (command === 'configure') return configure();
  if (command === 'confidence') {
    const threshold=Number(value);
    if(value===undefined||value.trim()===''||!Number.isFinite(threshold)||threshold<0||threshold>1) throw new Error('Укажите порог от 0 до 1: jev confidence 0.55');
    const config=process.env.JEV_CONFIG_FILE||join(homedir(),'.config/jev-browser/.env');
    await mkdir(dirname(config),{recursive:true,mode:0o700});
    const prior=existsSync(config)?await readFile(config,'utf8'):'';
    const lines=prior.split('\n').filter(line=>!/^\s*(?:export\s+)?JEV_MIN_CONFIDENCE\s*=/.test(line));
    const temporary=`${config}.${randomUUID()}.tmp`;
    await writeFile(temporary,`${lines.join('\n').trim()}\nJEV_MIN_CONFIDENCE=${threshold}\n`,{mode:0o600});
    await rename(temporary,config);
    console.log(`Порог новых задач: ${threshold}. Перезапустите MCP. Текущие задачи сохраняют свой порог.`);return;
  }
  if (command === 'status') {
    console.log(JSON.stringify({ ...await json(join(root, 'state.json')), ...await json(join(root, 'settings.json')),
      update: await json(join(root, 'update-status.json')), chromeExtension: join(root, 'current/chrome-extension') }, null, 2)); return;
  }
  if (command === 'auto-update' && ['on', 'off'].includes(value)) {
    await withLock(root, async () => {
      const settings = await json(join(root, 'settings.json'));
      await atomicJSON(join(root, 'settings.json'), { ...settings, autoUpdate: value === 'on' });
    }); console.log(`Автообновление: ${value}`); return;
  }
  if (command === 'rollback') return withLock(root, async () => {
    const state = await json(join(root, 'state.json'));
    if (!state.previous || !/^[a-f0-9]{40,64}$/.test(state.previous)) throw new Error('Предыдущая версия отсутствует.');
    const release = join(root, 'releases', state.previous);
    await smoke(release);
    await activate(root, release, state.previous);
    const settings = await json(join(root, 'settings.json'));
    await atomicJSON(join(root, 'settings.json'), { ...settings, autoUpdate: false });
    console.log('Предыдущая версия выбрана. Автообновление выключено. Перезапустите MCP.');
  });
  if (['doctor', 'serve'].includes(command)) {
    const release = await realpath(join(root, 'current'));
    execFileSync(process.execPath, [join(release, 'dist/src/cli.js'), command], {cwd:release,stdio:'inherit'}); return;
  }
  throw new Error('Команды: status, configure, confidence 0..1, update, auto-update on|off, rollback, doctor, serve');
}
