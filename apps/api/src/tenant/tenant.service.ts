import { Injectable, OnModuleInit } from '@nestjs/common';
import { tenantSchema } from '@lpmon/shared';
import { sql } from '../db.js';

// Satu address = satu schema Postgres berisi data aplikasi miliknya.
// Idempoten: aman dipanggil setiap login.
@Injectable()
export class TenantService implements OnModuleInit {
  // Migrasi schema yang sudah ada dijalankan saat boot — perubahan DDL berlaku
  // tanpa menunggu user login ulang
  async onModuleInit() {
    try {
      const rows = await sql`
        SELECT schema_name FROM information_schema.schemata
        WHERE schema_name LIKE 'addr\\_%'`;
      for (const r of rows) await this.ensure(r.schema_name);
      if (rows.length) console.log(`[tenant] ${rows.length} schema dimigrasi saat boot`);
    } catch (err: any) {
      console.warn('[tenant] migrasi startup gagal:', err.message);
    }
  }

  async provision(address: string): Promise<string> {
    const schema = tenantSchema(address);
    await this.ensure(schema);
    return schema;
  }

  private async ensure(schema: string): Promise<void> {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schema}".journal (
        id          bigserial PRIMARY KEY,
        key         text NOT NULL,
        pair        text NOT NULL,
        version     text NOT NULL,
        open_ts     timestamptz,
        close_ts    timestamptz,
        initial_usd double precision,
        final_usd   double precision,
        fees_usd    double precision,
        pnl_usd     double precision,
        pnl_pct     double precision,
        close_side  text,
        source      text NOT NULL DEFAULT 'live',
        estimated   boolean NOT NULL DEFAULT false,
        collects_checked boolean NOT NULL DEFAULT false,
        created_at  timestamptz NOT NULL DEFAULT now()
      )`);
    // collects_checked = klaim fee di tengah episode sudah diperhitungkan; entri
    // lama (false) yang episodenya punya klaim akan di-backfill TrackingService
    await sql.unsafe(`
      ALTER TABLE "${schema}".journal
      ADD COLUMN IF NOT EXISTS collects_checked boolean NOT NULL DEFAULT false`);
    // Satu NFT bisa dipakai ulang (tutup lalu isi liquidity lagi) = beberapa
    // episode per key — karena itu PK bukan di key, tapi unik per (key, close_ts).
    // Migrasi idempoten untuk schema yang dibuat sebelum aturan ini:
    await sql.unsafe(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.table_constraints
                   WHERE table_schema = '${schema}' AND table_name = 'journal'
                     AND constraint_name = 'journal_pkey'
                     AND constraint_type = 'PRIMARY KEY')
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = '${schema}' AND table_name = 'journal'
                     AND column_name = 'id') THEN
          ALTER TABLE "${schema}".journal DROP CONSTRAINT journal_pkey;
          ALTER TABLE "${schema}".journal ADD COLUMN id bigserial PRIMARY KEY;
        END IF;
      END $$`);
    await sql.unsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS journal_key_close_ts
      ON "${schema}".journal (key, close_ts)`);
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schema}".position_track (
        key            text PRIMARY KEY,
        open_ts        timestamptz,
        initial_usd    double precision,
        initial_source text,
        baseline_vol24 double precision,
        data           jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at     timestamptz NOT NULL DEFAULT now()
      )`);
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schema}".alert_log (
        id       bigserial PRIMARY KEY,
        type     text NOT NULL,
        severity text NOT NULL,
        message  text NOT NULL,
        pos_key  text,
        ts       timestamptz NOT NULL DEFAULT now()
      )`);
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schema}".settings (
        key   text PRIMARY KEY,
        value jsonb NOT NULL
      )`);
  }
}
