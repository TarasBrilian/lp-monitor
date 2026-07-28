// Muat .env root monorepo sebelum modul lain — supaya `pnpm dev:api` jalan
// langsung tanpa perlu meng-export env manual.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT_ENV = join(dirname(fileURLToPath(import.meta.url)), '../../../.env');
try {
  if (existsSync(ROOT_ENV)) process.loadEnvFile(ROOT_ENV);
} catch { /* opsional */ }
