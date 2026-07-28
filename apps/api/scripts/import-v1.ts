// Impor riwayat LP Monitor v1 (data/journal.json + data/history.json) ke tabel
// journal di schema milik sebuah address.
// Pakai:  bun run scripts/import-v1.ts <address> <path-folder-data-v1>
import '../src/env.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tenantSchema } from '@lpmon/shared';
import { sql } from '../src/db.js';

const [address, dataDir] = process.argv.slice(2);
if (!address || !dataDir) {
  console.error('Pakai: bun run scripts/import-v1.ts <address> <path-folder-data-v1>');
  process.exit(1);
}

const schema = tenantSchema(address);
const rows: any[] = [];

const journalPath = join(dataDir, 'journal.json');
if (existsSync(journalPath)) {
  for (const r of JSON.parse(readFileSync(journalPath, 'utf8'))) {
    rows.push({ ...r, source: 'v1', estimated: false });
  }
}
const historyPath = join(dataDir, 'history.json');
if (existsSync(historyPath)) {
  for (const r of Object.values(JSON.parse(readFileSync(historyPath, 'utf8'))) as any[]) {
    if (!r || r.skip) continue;
    rows.push({ ...r, source: 'rekonstruksi', estimated: !!r.estimated });
  }
}

let inserted = 0;
for (const r of rows) {
  if (!r.key || !r.pair) continue;
  const res = await sql.unsafe(
    `INSERT INTO "${schema}".journal
       (key, pair, version, open_ts, close_ts, initial_usd, final_usd, fees_usd,
        pnl_usd, pnl_pct, close_side, source, estimated)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (key, close_ts) DO NOTHING`,
    [r.key, r.pair, r.version ?? 'v4',
      r.openTs ? new Date(r.openTs) : null,
      r.closeTs ? new Date(r.closeTs) : null,
      r.initialUsd ?? null, r.finalValueUsd ?? null, r.feesUsd ?? null,
      r.pnlUsd ?? null, r.pnlPct ?? null, r.closeSide ?? null,
      r.source, r.estimated],
  );
  inserted += (res as any).count ?? 0;
}

console.log(`selesai: ${inserted} entri diimpor ke ${schema} (${rows.length - inserted} sudah ada/dilewati)`);
await sql.end();
