import { Injectable } from '@nestjs/common';
import { keccak256, encodeAbiParameters, pad, toHex } from 'viem';
import { CONTRACTS, EXPLORER, TOKENS, tenantSchema } from '@lpmon/shared';
import { sql } from '../db.js';
import { client, isSameAddr } from '../chain/client.js';
import { modifyLiquidityEvent, v4StateViewAbi, v4PositionManagerAbi, POOL_KEY_ABI } from '../chain/abi.js';
import { tokenMeta } from '../chain/tokens.js';
import { sqrtPriceX96ToSqrtPrice, priceFromSqrt } from '../chain/math.js';
import { ethUsd, usdPerToken } from '../chain/prices.js';
import { poolStats } from '../chain/volume.js';
import { v3Liquidity, v4Liquidity } from '../chain/positions.js';

// Kolom jsonb bisa tiba sebagai string (tergantung mode query driver) — parse defensif
function parseData(v: unknown): any {
  if (v == null) return {};
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return {}; }
  }
  return v;
}

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

  // Fallback saat indeks belum mencakup bloknya: cari event liquidity langsung
  // di chain, terfilter poolId (cepat), jendela ~1,5 hari terakhir
  private async chainLiquidityEvents(poolId: string, salt: `0x${string}`, sign: 'add' | 'remove') {
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
          args: { id: poolId as `0x${string}` },
          fromBlock: from, toBlock: to,
        }));
      } catch { /* potongan gagal, lanjut */ }
    }
    const mine = logs.filter((l) =>
      l.args.salt === salt && (sign === 'add' ? l.args.liquidityDelta > 0n : l.args.liquidityDelta < 0n));
    return Promise.all(mine.map(async (l) => ({
      tx_hash: l.transactionHash,
      block_number: l.blockNumber,
      timestamp: Number((await client.getBlock({ blockNumber: l.blockNumber })).timestamp),
    })));
  }

  // Rekonstruksi penutupan dari tx tarik-liquidity asli: nilai penarikan (termasuk
  // fee) dinilai pada harga pool di blok penutupan. Jauh lebih akurat daripada
  // snapshot terakhir kalau monitor sempat tidak memantau saat posisi ditutup.
  private async reconstructClose(key: string, wallet: string) {
    if (!key.startsWith('v4-')) return null;
    try {
      const tokenId = BigInt(key.split('-')[1]);
      const [poolKey] = await client.readContract({
        address: CONTRACTS.v4PositionManager as `0x${string}`, abi: v4PositionManagerAbi,
        functionName: 'getPoolAndPositionInfo', args: [tokenId],
      });
      if (/^0x0+$/.test(poolKey.currency0) && /^0x0+$/.test(poolKey.currency1)) return null; // NFT di-burn
      const [meta0, meta1] = await Promise.all([tokenMeta(poolKey.currency0), tokenMeta(poolKey.currency1)]);
      const poolId = keccak256(encodeAbiParameters(POOL_KEY_ABI, [poolKey]));
      const salt = pad(toHex(tokenId), { size: 32 });

      let removes: { tx_hash: string; block_number: bigint | string; timestamp: number }[] = await sql`
        SELECT tx_hash, block_number, timestamp FROM ponder.liquidity_event
        WHERE salt = ${salt} AND liquidity_delta < 0 ORDER BY block_number` as any;
      if (removes.length === 0) removes = await this.chainLiquidityEvents(poolId, salt, 'remove');
      if (removes.length === 0) return null;

      const pos = { pool: poolId, meta0, meta1 };
      let finalUsd = 0;
      let memeUsd = 0;
      let anchorUsd = 0;
      let estimated = false;
      for (const rm of removes) {
        const hist = await this.usdAtBlock(pos, BigInt(rm.block_number));
        if (!hist) { estimated = true; }
        const flows = await this.walletFlows(rm.tx_hash, wallet);
        for (const [addr, amt] of flows) {
          let price: number | null = null;
          if (isSameAddr(addr, TOKENS.USDG)) price = 1;
          else if (isSameAddr(addr, meta0.address)) price = hist?.usd0 ?? null;
          else if (isSameAddr(addr, meta1.address)) price = hist?.usd1 ?? null;
          else continue;
          if (price == null) { estimated = true; continue; }
          const v = Math.abs(amt) * price;
          finalUsd += v;
          const anchorTok = isSameAddr(addr, TOKENS.USDG) || isSameAddr(addr, TOKENS.WETH);
          if (anchorTok) anchorUsd += v; else memeUsd += v;
        }
      }
      if (!(finalUsd > 0)) return null;
      const share = memeUsd + anchorUsd > 0 ? memeUsd / (memeUsd + anchorUsd) : 0;
      return {
        finalUsd,
        closeTs: Number(removes[removes.length - 1].timestamp) * 1000,
        closeSide: share > 0.95 ? 'below' : share < 0.05 ? 'above' : 'in',
        estimated,
      };
    } catch {
      return null;
    }
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
      if (adds.length === 0) adds = await this.chainLiquidityEvents(pos.pool, salt, 'add');
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

    const tracks = (await sql.unsafe(`SELECT * FROM "${schema}".position_track`))
      .map((t: any) => ({ ...t, data: parseData(t.data) }));
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

      // Volume pool 24 jam + baseline saat pertama terpantau (untuk alert M4)
      const stats = await poolStats(pos.pool).catch(() => null);
      pos.vol24 = stats?.volume24hUsd ?? null;
      pos.reserveUsd = stats?.reserveUsd ?? null;
      let baselineVol24 = track.data?.baselineVol24 ?? null;
      if (baselineVol24 == null && stats && stats.volume24hUsd > 0) {
        baselineVol24 = stats.volume24hUsd;
      }
      pos.baselineVol24 = baselineVol24;

      await sql.unsafe(
        `UPDATE "${schema}".position_track SET data = $2, updated_at = now() WHERE key = $1`,
        [pos.key, JSON.stringify({
          pair: pos.pair, version: pos.version, valueUsd: pos.valueUsd, feesUsd: pos.feesUsd,
          collectedFeesUsd: pos.collectedFeesUsd, pnlUsd: pos.pnlUsd, baselineVol24,
          rangeLower: pos.disp.lower, rangeUpper: pos.disp.upper, lastPrice: pos.disp.price,
          quote: pos.disp.quote, closeSide: pos.inRange ? 'in' : pos.outSide,
        })],
      );
    }

    // Posisi yang dulu terlacak tapi kini hilang = kandidat ditutup.
    // ANTI-FLAPPING: sebelum dicatat tutup, verifikasi on-chain bahwa
    // liquidity-nya benar-benar 0 — gangguan RPC/Blockscout sesaat tidak boleh
    // menghasilkan entri jurnal palsu (bug yang terjadi di v1).
    for (const t of tracks) {
      if (activeKeys.includes(t.key) || !t.data?.pair) continue;
      try {
        const tokenId = BigInt(t.key.split('-')[1]);
        const liq = t.key.startsWith('v4-')
          ? await v4Liquidity(tokenId)
          : await v3Liquidity(tokenId);
        if (liq > 0n) continue; // masih hidup — jangan dijurnal, coba lagi poll berikutnya
      } catch {
        continue; // tidak bisa diverifikasi — tunda, jangan ambil kesimpulan
      }
      const d = t.data;
      // Utamakan rekonstruksi dari tx penutupan asli (nilai penarikan riil,
      // termasuk fee); fallback ke snapshot terakhir kalau tidak tersedia
      const rec = await this.reconstructClose(t.key, address);
      const initial = Number(t.initial_usd);
      const finalUsd = rec?.finalUsd ?? d.valueUsd;
      const feesUsd = rec ? null : (d.feesUsd ?? 0) + (d.collectedFeesUsd ?? 0);
      const pnlUsd = rec ? rec.finalUsd - initial : d.pnlUsd;
      await sql.unsafe(
        `INSERT INTO "${schema}".journal
           (key, pair, version, open_ts, close_ts, initial_usd, final_usd, fees_usd, pnl_usd, pnl_pct, close_side, source, estimated)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (key, close_ts) DO NOTHING`,
        [t.key, d.pair, d.version, t.open_ts,
          rec ? new Date(rec.closeTs) : new Date(),
          initial, finalUsd, feesUsd, pnlUsd,
          initial > 0 ? (pnlUsd / initial) * 100 : null,
          rec?.closeSide ?? d.closeSide,
          rec ? 'live' : 'live-snapshot',
          rec?.estimated ?? false],
      );
      await sql.unsafe(`DELETE FROM "${schema}".position_track WHERE key = $1`, [t.key]);
    }
  }

  async journal(address: string) {
    const schema = tenantSchema(address);
    return sql.unsafe(`SELECT * FROM "${schema}".journal ORDER BY close_ts DESC`);
  }

  // Koreksi manual modal awal (tidak akan ditimpa self-healing)
  async setInitial(address: string, key: string, usd: number): Promise<boolean> {
    if (!Number.isFinite(usd) || usd <= 0) return false;
    const schema = tenantSchema(address);
    const res = await sql.unsafe(
      `UPDATE "${schema}".position_track
       SET initial_usd = $2, initial_source = 'manual', updated_at = now()
       WHERE key = $1`,
      [key, usd],
    );
    return (res as any).count > 0;
  }
}
