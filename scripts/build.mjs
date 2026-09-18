import { build } from 'esbuild';
import { mkdir, readdir } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/collector.ts'], outfile: 'dist/collector.js', bundle: true,
  format: 'iife', globalName: '__jevCollector', platform: 'browser', target: 'es2022',
  footer: { js: 'window.__jevCollector = __jevCollector;' } });
const tests = (await readdir('tests')).filter(f => f.endsWith('.test.ts')).map(f => `tests/${f}`);
await build({ entryPoints: ['src/cli.ts', 'src/mcp.ts', 'src/service-main.ts', 'src/native-host.ts', 'scripts/live-smoke.ts', 'scripts/live-wikipedia.ts', 'scripts/replay-decision.ts', ...tests], outbase: '.', outdir: 'dist',
  bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22', sourcemap: true });
