import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { atomicJSON, json, stage, activate, withLock, update } from '../scripts/manage.mjs';
const revA = 'a'.repeat(40), revB = 'b'.repeat(40);
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'jev-updater-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'releases', revA), { recursive: true });
  await activate(root, join(root, 'releases', revA), revA);
  await atomicJSON(join(root, 'settings.json'), { autoUpdate: true });
  await atomicJSON(join(root, 'update-status.json'), { checkedAt: 0 });
  return root;
}
test('failed build preserves the active release and removes staging files', async t => {
  const root = await fixture(t);
  const commands = [];
  await assert.rejects(stage(root, '/tmp', revB, {
    run(command, args, cwd) {
      commands.push([command, args]);
      if (command === 'git') execFileSync('touch', [args.find(a => a.startsWith('--output=')).slice(9)]);
      if (command === 'npm') throw new Error('network unavailable');
    }, smoke() { throw new Error('must not run'); },
  }), /network unavailable/);
  assert.equal(await realpath(join(root, 'current')), join(root, 'releases', revA));
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(join(root, 'releases')), [revA]);
  assert.ok(commands.some(([command, args]) => command === 'npm' && args.includes('--ignore-scripts')));
});
test('new release activates only after successful staging; old files remain readable', async t => {
  const root = await fixture(t);
  const original = await realpath(join(root, 'current'));
  await writeFile(join(original, 'running-task'), 'keep');
  await update(root, false, {
    run(command, args) { if (command === 'gh' && args[0] === 'auth') throw new Error('no gh'); return args[0] === 'rev-parse' ? revB : ''; },
    async stage() { assert.equal(await realpath(join(root, 'current')), original); const target = join(root, 'releases', revB); await mkdir(target); return target; },
  });
  assert.equal((await json(join(root, 'state.json'))).previous, revA);
  assert.equal(await realpath(join(root, 'current')), join(root, 'releases', revB));
  assert.equal(await readFile(join(original, 'running-task'), 'utf8'), 'keep');
  assert.equal((await json(join(root, 'update-status.json'))).outcome, 'updated');
});
test('offline update records failure, preserves current version and removes lock', async t => {
  const root = await fixture(t);
  await assert.rejects(update(root, false, { run() { throw new Error('private sensitive error'); }, stage() { throw new Error('unused'); } }), /Предыдущая версия сохранена/);
  assert.equal(await realpath(join(root, 'current')), join(root, 'releases', revA));
  const status = await readFile(join(root, 'update-status.json'), 'utf8');
  assert.ok(!status.includes('sensitive'));
  assert.equal(JSON.parse(status).outcome, 'failed');
  await assert.rejects(access(join(root, 'update.lock')));
});
test('automatic checks are throttled and honor settings; manual update bypasses throttle', async t => {
  const root = await fixture(t);
  let calls = 0;
  const dependencies = { run(command, args) { calls++; return args[0] === 'rev-parse' ? revA : ''; }, stage() { throw new Error('same version'); } };
  await atomicJSON(join(root, 'update-status.json'), { checkedAt: Date.now() });
  await update(root, true, dependencies);
  assert.equal(calls, 0);
  await update(root, false, dependencies);
  assert.ok(calls > 0);
  calls = 0;
  await atomicJSON(join(root, 'settings.json'), { autoUpdate: false });
  await atomicJSON(join(root, 'update-status.json'), { checkedAt: 0 });
  await update(root, true, dependencies);
  assert.equal(calls, 0);
});
test('concurrent updaters cannot enter the same installation', async t => {
  const root = await fixture(t);
  await withLock(root, async () => {
    await assert.rejects(withLock(root, () => assert.fail('concurrent mutation')), /Установка уже выполняется/);
    await access(join(root, 'update.lock/owner.json'));
  });
  await withLock(root, async () => {});
});
test('fresh launcher keeps stdout exclusively for MCP and pins one release', async t => {
  const root = await fixture(t);
  const { cp } = await import('node:fs/promises');
  await cp(resolve('scripts/runtime-launcher.mjs'), join(root, 'launcher.mjs'));
  const release = join(root, 'releases', revA);
  await mkdir(join(release, 'dist/src'), { recursive: true });
  await mkdir(join(release, 'scripts'), { recursive: true });
  await writeFile(join(release, 'package.json'), '{"type":"module"}');
  await writeFile(join(release, 'dist/src/mcp.js'), `process.stdout.write('MCP_ONLY');`);
  await writeFile(join(release, 'scripts/manage.mjs'), `export async function main(){ console.log('UPDATER_OUTPUT'); }`);
  const result = execFileSync(process.execPath, [join(root, 'launcher.mjs')], { encoding: 'utf8', env: { ...process.env, JEV_AUTO_UPDATE: '0' } });
  assert.equal(result, 'MCP_ONLY');
  const background = execFileSync(process.execPath, [join(root, 'launcher.mjs')], { encoding: 'utf8', env: { ...process.env, JEV_AUTO_UPDATE: '1' } });
  assert.equal(background, 'MCP_ONLY');
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { if ((await readFile(join(root, 'update.log'), 'utf8')).includes('UPDATER_OUTPUT')) return; } catch {}
    await new Promise(r => setTimeout(r,30));
  }
  assert.fail('Background updater did not start');
});
test('Git archive excludes an untracked API key before release validation', { timeout: 180000 }, async t => {
  const root = await fixture(t);
  const source = join(root, 'source');
  await mkdir(source);
  execFileSync('git', ['init', '-q', source]);
  await writeFile(join(source, 'tracked.txt'), 'yes');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: source });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], { cwd: source });
  await writeFile(join(source, '.env'), 'OPENROUTER_API_KEY=sentinel-must-stay-private');
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
  let observed = false;
  const release = await stage(root, source, revision, {
    run(command, args, cwd) { if (command !== 'npm') execFileSync(command, args, { cwd }); },
    async smoke(path) { observed = true; assert.equal(await readFile(join(path, 'tracked.txt'), 'utf8'), 'yes'); await assert.rejects(access(join(path, '.env'))); },
  });
  assert.ok(observed);
  assert.equal(await readFile(join(release, '.ready'), 'utf8'), revision);
});

test('confidence command preserves credentials and rejects out-of-range thresholds',async t=>{
  const root=await fixture(t),config=join(root,'private.env');
  const old=process.env.JEV_CONFIG_FILE;
  t.after(()=>{if(old===undefined)delete process.env.JEV_CONFIG_FILE;else process.env.JEV_CONFIG_FILE=old;});
  process.env.JEV_CONFIG_FILE=config;
  await writeFile(config,'OPENROUTER_API_KEY=private-sentinel\nJEV_MIN_CONFIDENCE=0.55\n',{mode:0o600});
  const {main}=await import('../scripts/manage.mjs');
  await main(root,['confidence','0.65']);
  const changed=await readFile(config,'utf8');
  assert.ok(changed.includes('OPENROUTER_API_KEY=private-sentinel'));assert.ok(changed.includes('JEV_MIN_CONFIDENCE=0.65'));
  await assert.rejects(main(root,['confidence','1.2']),/от 0 до 1/);
  assert.equal(await readFile(config,'utf8'),changed);
});

test('Claude registration is user-scoped, repeatable and preserves unrelated servers',async t=>{
  const home=await fixture(t),calls=[],launcher=join(home,'launcher.mjs'),config=join(home,'private.env');
  const {registerClaude}=await import('../scripts/clients.mjs');
  const run=(c,a)=>calls.push([c,a]);
  await registerClaude({home,launcher,config,run});
  assert.deepEqual(calls[0].slice(0,1),['claude']);assert.deepEqual(calls[0][1].slice(0,5),['mcp','add-json','--scope','user','jev-browser']);
  const server=JSON.parse(calls[0][1][5]);await writeFile(join(home,'.claude.json'),JSON.stringify({mcpServers:{'jev-browser':server,other:{command:'keep'}}}));
  calls.length=0;await registerClaude({home,launcher,config,run});assert.equal(calls.length,0);
  await writeFile(join(home,'.claude.json'),JSON.stringify({mcpServers:{'jev-browser':{command:'other',args:[]}}}));
  await assert.rejects(registerClaude({home,launcher,config,run}),/preserved/);assert.equal(calls.length,0);
});
test('native host installer uses a stable executable and allows only the bundled extension',async t=>{
  const home=await fixture(t),root=join(home,'runtime');await mkdir(root);
  const {installNativeHost,extensionId}=await import('../scripts/native-host.mjs');
  const result=await installNativeHost(root,resolve('.'),{home,platform:'darwin'});
  const manifest=JSON.parse(await readFile(join(home,'Library/Application Support/Google/Chrome/NativeMessagingHosts/in.legost.jev_browser.json'),'utf8'));
  assert.deepEqual(manifest.allowed_origins,[result.origin]);assert.equal(manifest.path,join(root,'native-host'));
  assert.match(await readFile(result.executable,'utf8'),/current\/dist\/src\/native-host.js/);
  const key=JSON.parse(await readFile('chrome-extension/manifest.json','utf8')).key;
  assert.equal(result.origin,`chrome-extension://${extensionId(key)}/`);
});
