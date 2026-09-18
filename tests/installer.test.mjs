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
