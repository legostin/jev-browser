// This small entry point stays outside releases. Resolve once: running tasks retain their version.
import { realpathSync, readFileSync, openSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
const root = dirname(fileURLToPath(import.meta.url));
const release = realpathSync(join(root, 'current'));
const command = process.argv[2] || 'mcp';
process.env.JEV_RUNTIME_ROOT = root;
if (command !== 'mcp') {
  const { main } = await import(pathToFileURL(join(release, 'scripts/manage.mjs')).href);
  await main(root, process.argv.slice(2));
} else {
  // No network wait and no updater output on the MCP protocol stream.
  try {
    const settings = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'));
    const attempt = JSON.parse(readFileSync(join(root, 'update-status.json'), 'utf8'));
    if (settings.autoUpdate && process.env.JEV_AUTO_UPDATE !== '0' && Date.now() - attempt.checkedAt > 86400000) {
      const log = openSync(join(root, 'update.log'), 'a', 0o600);
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'update', '--auto'], {
        detached: true, stdio: ['ignore', log, log], env: process.env,
      });
      child.on('error', () => {});
      child.unref();
      closeSync(log);
    }
  } catch { /* A failed background check must never prevent the installed MCP from starting. */ }
  process.chdir(release);
  await import(pathToFileURL(join(release, 'dist/src/mcp.js')).href);
}
