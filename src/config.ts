import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
export function loadConfig() {
  // A private local .env is optional. Existing environment variables take precedence.
  if(existsSync('.env')) process.loadEnvFile('.env');
  const config = process.env.JEV_CONFIG_FILE || join(homedir(),'.config','jev-browser','.env');
  if(existsSync(config)) process.loadEnvFile(config);
}
