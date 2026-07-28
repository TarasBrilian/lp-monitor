// Muat .env root monorepo sebelum modul lain — supaya `pnpm dev:api` jalan
// langsung tanpa export env manual. Diparse manual karena process.loadEnvFile
// adalah API Node yang tidak tersedia di Bun.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT_ENV = join(dirname(fileURLToPath(import.meta.url)), '../../../.env');

if (existsSync(ROOT_ENV)) {
  for (const line of readFileSync(ROOT_ENV, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const [, key, raw] = m;
    const value = raw.replace(/^["']|["']$/g, '');
    if (process.env[key] == null || process.env[key] === '') process.env[key] = value;
  }
}
