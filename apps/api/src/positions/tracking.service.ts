import { Injectable } from '@nestjs/common';
import { pad, toHex } from 'viem';
import { CONTRACTS, EXPLORER, TOKENS, tenantSchema } from '@lpmon/shared';
import { sql } from '../db.js';
import { client, isSameAddr } from '../chain/client.js';
import { modifyLiquidityEvent, v4StateViewAbi } from '../chain/abi.js';
import { sqrtPriceX96ToSqrtPrice, priceFromSqrt } from '../chain/math.js';
import { ethUsd, usdPerToken } from '../chain/prices.js';

// Melacak modal awal per posisi di schema milik address (position_track),
// menghitung P&L, dan memindahkan posisi yang ditutup ke tabel journal.
@Injectable()
export class TrackingService {
  // Aliran token dari/ke wallet dalam satu tx (untuk nilai deposit asli)
  private async walletFlows(txHash: string, wallet: string): Promise<Map<string, number>> {
    const flows = new Map<string, number>();
    const res = await fetch(`${EXPLORER}/api/v2/transactions/${txHash}/token-transfers?type=ERC-20`, {
      headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`blockscout ${res.status}`);
    const json: any = await res.json();
    const w = wallet.toLowerCase();
    for (const it of json?.items ?? []) {
      const addr = ((it.token ?? {}).address_hash ?? (it.token ?? {}).address)?.toLowerCase();
      if (!addr) continue;
      const dec = Number(it.total?.decimals ?? it.token?.decimals ?? 18);
      const amt = Number(it.total?.value ?? 0) / Math.pow(10, dec);
      const from = (it.from?.hash ?? '').toLowerCase();
      const to = (it.to?.hash ?? '').toLowerCase();
      if (to === w) flows.set(addr, (flows.get(addr) ?? 0) + amt);
      else if (from === w) flows.set(addr, (flows.get(addr) ?? 0) - amt);
    }
    return flows;
  }

  // Fallback saat indeks belum mencakup blok pembukaan: cari event tambah-liquidity
  // langsung di chain, terfilter poolId (cepat), jendela ~1,5 hari terakhir
  private async chainAdds(pos: any, salt: `0x${string}`) {
    const head = await client.getBlockNumber();
    const CHUNK = 150_000n;
    const start = head > 600_000n ? head - 600_000n : 0n;
    const logs: any[] = [];
    for (let from = start; from <= head; from += CHUNK) {
      const to = from + CHUNK - 1n > head ? head : from + CHUNK - 1n;
      try {
        logs.push(...await client.getLogs({
          address: CONTRACTS.v4PoolManager as `0x${string}`,
          event: modifyLiquidityEvent,
          args: { id: pos.pool as `0x${string}` },
          fromBlock: from, toBlock: to,
        }));
      } catch { /* potongan gagal, lanjut */ }
    }
    const mine = logs.filter((l) => l.args.salt === salt && l.args.liquidityDelta > 0n);
    return Promise.all(mine.map(async (l) => ({
      tx_hash: l.transactionHash,
      block_number: l.blockNumber,
      timestamp: Number((await client.getBlock({ blockNumber: l.blockNumber })).timestamp),
    })));
  }

  // Harga USD kedua token pool pada blok tertentu (archive call).
  // null kalau RPC tidak melayani state historis.
  private async usdAtBlock(pos: any, blockNumber: bigint) {
    try {
      const slot0 = await client.readContract({
        address: CONTRACTS.v4StateView as `0x${string}`, abi: v4StateViewAbi,
        functionName: 'getSlot0', args: [pos.pool], blockNumber,
      });
      const price = priceFromSqrt(
        sqrtPriceX96ToSqrtPrice(slot0[0]), pos.meta0.decimals, pos.meta1.decimals,
      );
      const eth = await ethUsd(); // anchor ETH memakai harga sekarang (ditandai estimasi)
      const { usd0, usd1 } = usdPerToken({ meta0: pos.meta0, meta1: pos.meta1, priceT1PerT0: price, eth });
      if (usd0 == null || usd1 == null) return null;
      const usesEthAnchor =
        pos.meta0.native || pos.meta1.native ||
        isSameAddr(pos.meta0.address, TOKENS.WETH) || isSameAddr(pos.meta1.address, TOKENS.WETH);
      return { usd0, usd1, estimated: usesEthAnchor };
    } catch {
      return null;
    }
  }

  // Modal awal posisi v4: event tambah-liquidity (indeks Ponder, fallback chain) -> tx -> aliran token
  private async reconstructEntry(pos: any, wallet: string): Promise<{ initialUsd: number; openTs: number; source: string } | null> {
    if (pos.version !== 'v4') return null;
    try {
      const salt = pad(toHex(BigInt(pos.tokenId)), { size: 32 });
      let adds: { tx_hash: string; block_number: bigint | string; timestamp: number }[] = await sql`
        SELECT tx_hash, block_number, timestamp FROM ponder.liquidity_event
        WHERE salt = ${salt} AND liquidity_delta > 0 ORDER BY block_number` as any;
      if (adds.length === 0) adds = await this.chainAdds(pos, salt);
      if (adds.length === 0) return null;

      let initialUsd = 0;
      let estimated = false;
      for (const add of adds) {
        // Nilai token pada harga pool di blok deposit — bukan harga sekarang
        const hist = await this.usdAtBlock(pos, BigInt(add.block_number));
        const usd0 = hist?.usd0 ?? pos.usd0;
        const usd1 = hist?.usd1 ?? pos.usd1;
        if (!hist) estimated = true;
        else if (hist.estimated) estimated = true;

        const flows = await this.walletFlows(add.tx_hash, wallet);
        for (const [addr, amt] of flows) {
          let price: number | null = null;
          if (isSameAddr(addr, TOKENS.USDG)) price = 1;
          else if (isSameAddr(addr, pos.meta0.address)) price = usd0;
          else if (isSameAddr(addr, pos.meta1.address)) price = usd1;
          else continue;
          initialUsd += Math.abs(amt) * (price ?? 0);
        }
      }
      if (!(initialUsd > 0)) return null;
      return {
        initialUsd,
        openTs: Number(adds[0].timestamp) * 1000,
        source: estimated ? 'index-estimasi' : 'index',
      };
    } catch {
      return null;
    }
  }

  async enrich(address: string, positions: any[]) {
    const schema = tenantSchema(address);
    const activeKeys = positions.map((p) => p.key);

    const tracks = await sql.unsafe(`SELECT * FROM "${schema}".position_track`);
    const byKey = new Map(tracks.map((t: any) => [t.key, t]));

    for (const pos of positions) {
      let track: any = byKey.get(pos.key);

      // Self-healing: modal "first-seen" atau "estimasi" di-upgrade ke nilai
      // eksak (harga blok pembukaan) begitu datanya bisa direkonstruksi
      const upgradable = track &&
        (track.initial_source === 'first-seen' || track.initial_source?.endsWith('-estimasi'));
      if (upgradable) {
        const entry = await this.reconstructEntry(pos, address);
        if (entry && (entry.source === 'index' || track.initial_source === 'first-seen')) {
          track.initial_usd = entry.initialUsd;
          track.initial_source = entry.source;
          track.open_ts = new Date(entry.openTs);
          await sql.unsafe(
            `UPDATE "${schema}".position_track
             SET initial_usd = $2, initial_source = $3, open_ts = $4, updated_at = now()
             WHERE key = $1`,
            [pos.key, entry.initialUsd, entry.source, new Date(entry.openTs)],
          );
        }
      }

      if (!track) {
        const entry = await this.reconstructEntry(pos, address);
        track = {
          key: pos.key,
          open_ts: new Date(entry?.openTs ?? Date.now()),
          initial_usd: entry?.initialUsd ?? pos.valueUsd,
          initial_source: entry?.source ?? 'first-seen',
          data: {},
        };
        await sql.unsafe(
          `INSERT INTO "${schema}".position_track (key, open_ts, initial_usd, initial_source, data)
           VALUES ($1, $2, $3, $4, '{}') ON CONFLICT (key) DO NOTHING`,
          [track.key, track.open_ts, track.initial_usd, track.initial_source],
        );
      }
      pos.initialUsd = Number(track.initial_usd);
      pos.initialSource = track.initial_source;
      pos.openTs = new Date(track.open_ts).getTime();
      pos.ageMs = Date.now() - pos.openTs;
      pos.collectedFeesUsd = Number(track.data?.collectedFeesUsd ?? 0);
      pos.pnlUsd = pos.valueUsd + pos.feesUsd + pos.collectedFeesUsd - pos.initialUsd;
      pos.pnlPct = pos.initialUsd > 0 ? (pos.pnlUsd / pos.initialUsd) * 100 : null;

      await sql.unsafe(
        `UPDATE "${schema}".position_track SET data = $2, updated_at = now() WHERE key = $1`,
        [pos.key, JSON.stringify({
          pair: pos.pair, version: pos.version, valueUsd: pos.valueUsd, feesUsd: pos.feesUsd,
          collectedFeesUsd: pos.collectedFeesUsd, pnlUsd: pos.pnlUsd,
          rangeLower: pos.disp.lower, rangeUpper: pos.disp.upper, lastPrice: pos.disp.price,
          quote: pos.disp.quote, closeSide: pos.inRange ? 'in' : pos.outSide,
        })],
      );
    }

    // Posisi yang dulu terlacak tapi kini hilang = ditutup -> pindah ke journal
    for (const t of tracks) {
      if (activeKeys.includes(t.key) || !t.data?.pair) continue;
      const d = t.data;
      await sql.unsafe(
        `INSERT INTO "${schema}".journal
           (key, pair, version, open_ts, close_ts, initial_usd, final_usd, fees_usd, pnl_usd, pnl_pct, close_side, source)
         VALUES ($1, $2, $3, $4, now(), $5, $6, $7, $8, $9, $10, 'live')
         ON CONFLICT (key) DO NOTHING`,
        [t.key, d.pair, d.version, t.open_ts, t.initial_usd, d.valueUsd,
          (d.feesUsd ?? 0) + (d.collectedFeesUsd ?? 0), d.pnlUsd,
          t.initial_usd > 0 ? (d.pnlUsd / t.initial_usd) * 100 : null, d.closeSide],
      );
      await sql.unsafe(`DELETE FROM "${schema}".position_track WHERE key = $1`, [t.key]);
    }
  }

  async journal(address: string) {
    const schema = tenantSchema(address);
    return sql.unsafe(`SELECT * FROM "${schema}".journal ORDER BY close_ts DESC`);
  }
}
