import { Injectable } from '@nestjs/common';
import { tenantSchema } from '@lpmon/shared';
import { sql } from '../db.js';

// Satu address = satu schema Postgres berisi data aplikasi miliknya.
// Idempoten: aman dipanggil setiap login.
@Injectable()
export class TenantService {
  async provision(address: string): Promise<string> {
    const schema = tenantSchema(address);
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schema}".journal (
        key         text PRIMARY KEY,
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
        created_at  timestamptz NOT NULL DEFAULT now()
      )`);
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
    return schema;
  }
}
