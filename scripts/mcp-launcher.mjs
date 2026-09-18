import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Direct MCP registration may start in any project. Resolve assets/config from this package.
process.chdir(resolve(dirname(fileURLToPath(import.meta.url)),'..'));
await import('../dist/src/mcp.js');
