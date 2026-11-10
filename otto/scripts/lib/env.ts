// Loads .env.local from the skill's directory, then the current directory. Values already set in the environment win.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const toolkitDir = resolve(fileURLToPath(new URL('../..', import.meta.url)));

export function loadEnv() {
  for (const f of [join(toolkitDir, '.env.local'), resolve('.env.local')]) if (existsSync(f)) process.loadEnvFile(f);
}
