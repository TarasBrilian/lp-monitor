import { Injectable } from '@nestjs/common';
import { keccak256, encodeAbiParameters, pad, toHex } from 'viem';
import { CONTRACTS, EXPLORER, TOKENS, tenantSchema } from '@lpmon/shared';
import { sql } from '../db.js';
import { client, isSameAddr } from '../chain/client.js';
import { modifyLiquidityEvent, v4StateViewAbi, v4PositionManagerAbi, POOL_KEY_ABI } from '../chain/abi.js';
import { tokenMeta, type TokenMeta } from '../chain/tokens.js';
import { sqrtPriceX96ToSqrtPrice, priceFromSqrt } from '../chain/math.js';
import { ethUsd, usdPerToken } from '../chain/prices.js';
import { poolStats } from '../chain/volume.js';
import { v3Liquidity, v4Liquidity } from '../chain/positions.js';

type LiqEvent = { tx_hash: string; block_number: bigint | string; timestamp: number | string; liquidity_delta: bigint | string };
type Episode = LiqEvent[];

// Kolom jsonb bisa tiba sebagai string (tergantung mode query driver) — parse defensif
function parseData(v: unknown): any {
  if (v == null) return {};
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return {}; }
  }
  return v;
}

// Satu NFT bisa dipakai untuk beberapa "episode" posisi (tutup penuh lalu isi
// lagi). Episode = rangkaian event sampai liquidity kumulatif kembali 0.
function segmentEpisodes(events: LiqEvent[]): { episodes: Episode[]; open: Episode | null } {
  const episodes: Episode[] = [];
  let current: Episode = [];
  let cum = 0n;
  for (const e of events) {
    current.push(e);
    cum += BigInt(e.liquidity_delta);
    if (cum === 0n) {
      episodes.push(current);
      current = [];
    }
  }
  return { episodes, open: current.length ? current : null };
}

// Melacak modal awal per posisi di schema milik address (position_track),
// menghitung P&L, memindahkan posisi tertutup ke journal, dan memulihkan
// episode yang terlewat (buka-tutup saat monitor tidak memantau) dari indeks.
@Injectable()
export class TrackingService {
  // Aliran token dari/ke wallet dalam satu tx (untuk nilai deposit/penarikan asli)
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

  // Semua event liquidity sebuah tokenId: dari indeks Ponder, fallback getLogs
  // langsung (jendela ~1,5 hari) saat indeks belum mencakup bloknya
  private async saltEvents(poolId: string | null, tokenId: bigint): Promise<LiqEvent[]> {
    const salt = pad(toHex(tokenId), { size: 32 });
    const rows: LiqEvent[] = await sql`
      SELECT tx_hash, block_number, timestamp, liquidity_delta
      FROM ponder.liquidity_event WHERE salt = ${salt} ORDER BY block_number` as any;
    if (rows.length > 0 || !poolId) return rows;

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
    const mine = logs.filter((l) => l.args.salt === salt);
    return Promise.all(mine.map(async (l) => ({
      tx_hash: l.transactionHash,
      block_number: l.blockNumber,
      timestamp: Number((await client.getBlock({ blockNumber: l.blockNumber })).timestamp),
      liquidity_delta: l.args.liquidityDelta,
    })));
  }

  // Metadata pool sebuah tokenId v4 (masih terbaca walau posisi sudah kosong,
  // selama NFT belum di-burn)
  private async poolMeta(tokenId: bigint): Promise<{ poolId: string; meta0: TokenMeta; meta1: TokenMeta } | null> {
    try {
      const [poolKey] = await client.readContract({
        address: CONTRACTS.v4PositionManager as `0x${string}`, abi: v4PositionManagerAbi,
        functionName: 'getPoolAndPositionInfo', args: [tokenId],
      });
      if (/^0x0+$/.test(poolKey.currency0) && /^0x0+$/.test(poolKey.currency1)) return null;
      const [meta0, meta1] = await Promise.all([tokenMeta(poolKey.currency0), tokenMeta(poolKey.currency1)]);
      return { poolId: keccak256(encodeAbiParameters(POOL_KEY_ABI, [poolKey])), meta0, meta1 };
    } catch {
      return null;
    }
  }

  // Harga USD kedua token pool pada blok tertentu (archive call)
  private async usdAtBlock(poolId: string, meta0: TokenMeta, meta1: TokenMeta, blockNumber: bigint) {
    try {
      const slot0 = await client.readContract({
        address: CONTRACTS.v4StateView as `0x${string}`, abi: v4StateViewAbi,
        functionName: 'getSlot0', args: [poolId as `0x${string}`], blockNumber,
      });
      const price = priceFromSqrt(sqrtPriceX96ToSqrtPrice(slot0[0]), meta0.decimals, meta1.decimals);
      const eth = await ethUsd();
      const { usd0, usd1 } = usdPerToken({ meta0, meta1, priceT1PerT0: price, eth });
      if (usd0 == null || usd1 == null) return null;
      const usesEthAnchor =
        meta0.native || meta1.native ||
        isSameAddr(meta0.address, TOKENS.WETH) || isSameAddr(meta1.address, TOKENS.WETH);
      return { usd0, usd1, estimated: usesEthAnchor };
    } catch {
      return null;
    }
  }

  // Nilai USD aliran token milik wallet untuk sekumpulan event (adds ATAU removes),
  // dinilai pada harga pool di blok masing-masing event
  private async valueEvents(
    events: LiqEvent[], poolId: string, meta0: TokenMeta, meta1: TokenMeta, wallet: string,
  ) {
    let usd = 0;
    let memeUsd = 0;
    let anchorUsd = 0;
    let estimated = false;
    for (const ev of events) {
      const hist = await this.usdAtBlock(poolId, meta0, meta1, BigInt(ev.block_number));
      if (!hist) estimated = true;
      else if (hist.estimated) estimated = true;
      const flows = await this.walletFlows(ev.tx_hash, wallet);
      for (const [addr, amt] of flows) {
        let price: number | null = null;
        if (isSameAddr(addr, TOKENS.USDG)) price = 1;
        else if (isSameAddr(addr, meta0.address)) price = hist?.usd0 ?? null;
        else if (isSameAddr(addr, meta1.address)) price = hist?.usd1 ?? null;
        else continue;
        if (price == null) { estimated = true; continue; }
        const v = Math.abs(amt) * price;
        usd += v;
        const anchorTok = isSameAddr(addr, TOKENS.USDG) || isSameAddr(addr, TOKENS.WETH) ||
          (meta0.native && isSameAddr(addr, meta0.address)) || (meta1.native && isSameAddr(addr, meta1.address));
        if (anchorTok) anchorUsd += v; else memeUsd += v;
      }
    }
    const share = memeUsd + anchorUsd > 0 ? memeUsd / (memeUsd + anchorUsd) : 0;
    return { usd, memeShare: share, estimated };
  }

  // Modal awal posisi v4 AKTIF: adds milik episode berjalan (bukan episode lama NFT yang dipakai ulang)
  private async reconstructEntry(pos: any, wallet: string): Promise<{ initialUsd: number; openTs: number; source: string } | null> {
    if (pos.version !== 'v4') return null;
    try {
      const events = await this.saltEvents(pos.pool, BigInt(pos.tokenId));
      const { open } = segmentEpisodes(events);
      if (!open) return null;
      const adds = open.filter((e) => BigInt(e.liquidity_delta) > 0n);
      if (adds.length === 0) return null;
      const { usd, estimated } = await this.valueEvents(adds, pos.pool, pos.meta0, pos.meta1, wallet);
      if (!(usd > 0)) return null;
      return {
        initialUsd: usd,
        openTs: Number(adds[0].timestamp) * 1000,
        source: estimated ? 'index-estimasi' : 'index',
      };
    } catch {
      return null;
    }
  }

  // Rekonstruksi penuh satu episode TERTUTUP -> entri journal
  private async reconstructEpisode(
    tokenId: bigint, episode: Episode, poolId: string, meta0: TokenMeta, meta1: TokenMeta, wallet: string,
  ) {
    const adds = episode.filter((e) => BigInt(e.liquidity_delta) > 0n);
    const removes = episode.filter((e) => BigInt(e.liquidity_delta) < 0n);
    if (adds.length === 0 || removes.length === 0) return null;
    const entry = await this.valueEvents(adds, poolId, meta0, meta1, wallet);
    const exit = await this.valueEvents(removes, poolId, meta0, meta1, wallet);
    if (!(entry.usd > 0) || !(exit.usd > 0)) return null;
    const flip = isSameAddr(meta0.address, TOKENS.USDG) ||
      ((meta0.native || isSameAddr(meta0.address, TOKENS.WETH)) && !isSameAddr(meta1.address, TOKENS.USDG));
    const base = flip ? meta1.symbol : meta0.symbol;
    const quote = flip ? meta0.symbol : meta1.symbol;
    return {
      key: `v4-${tokenId}`,
      pair: `${base}/${quote}`,
      openTs: Number(adds[0].timestamp) * 1000,
      closeTs: Number(removes[removes.length - 1].timestamp) * 1000,
      initialUsd: entry.usd,
      finalUsd: exit.usd,
      pnlUsd: exit.usd - entry.usd,
      closeSide: exit.memeShare > 0.95 ? 'below' : exit.memeShare < 0.05 ? 'above' : 'in',
      estimated: entry.estimated || exit.estimated,
    };
  }

  // Pemulihan: episode tertutup yang belum ada di journal (mis. buka-tutup saat
  // monitor tidak memantau) direkonstruksi dari indeks. Jalan hanya saat indeks
  // sudah dekat ujung chain.
  private async recoverMissedEpisodes(address: string, schema: string, activeKeys: string[]) {
    const [{ synced }] = await sql`
      SELECT COALESCE(MAX(block_number), 0)::bigint AS synced FROM ponder.liquidity_event`;
    const head = await client.getBlockNumber();
    if (head - BigInt(synced) > 5_000n) return;

    const owned = await sql`
      SELECT token_id FROM (
        SELECT DISTINCT ON (version, token_id) version, token_id, "to"
        FROM ponder.position_transfer
        ORDER BY version, token_id, block_number DESC, id DESC
      ) latest
      WHERE version = 'v4' AND lower(latest."to") = ${address.toLowerCase()}`;

    for (const { token_id } of owned as any[]) {
      const tokenId = BigInt(token_id);
      const key = `v4-${tokenId}`;
      const events = await this.saltEvents(null, tokenId);
      const { episodes } = segmentEpisodes(events);
      if (episodes.length === 0) continue;
      let meta: Awaited<ReturnType<typeof this.poolMeta>> = null;
      for (const ep of episodes) {
        const closeTs = Number(ep[ep.length - 1].timestamp) * 1000;
        const [exists] = await sql.unsafe(
          `SELECT 1 FROM "${schema}".journal
           WHERE key = $1 AND ABS(EXTRACT(EPOCH FROM close_ts) - $2) < 180`,
          [key, closeTs / 1000],
        );
        if (exists) continue;
        // posisi aktif dengan episode lama yang belum dijurnal tetap dipulihkan;
        // episode berjalan tidak tersentuh karena hanya episode TERTUTUP di sini
        meta ??= await this.poolMeta(tokenId);
        if (!meta) break;
        const rec = await this.reconstructEpisode(tokenId, ep, meta.poolId, meta.meta0, meta.meta1, address);
        if (!rec) continue;
        await sql.unsafe(
          `INSERT INTO "${schema}".journal
             (key, pair, version, open_ts, close_ts, initial_usd, final_usd, fees_usd, pnl_usd, pnl_pct, close_side, source, estimated)
           VALUES ($1,$2,'v4',$3,$4,$5,$6,NULL,$7,$8,$9,'rekonstruksi',$10)
           ON CONFLICT (key, close_ts) DO NOTHING`,
          [rec.key, rec.pair, new Date(rec.openTs), new Date(rec.closeTs), rec.initialUsd, rec.finalUsd,
            rec.pnlUsd, rec.initialUsd > 0 ? (rec.pnlUsd / rec.initialUsd) * 100 : null,
            rec.closeSide, rec.estimated],
        );
      }
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

      // Self-healing: modal "first-seen"/"estimasi" di-upgrade ke nilai eksak
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

    // Posisi terlacak yang hilang = kandidat ditutup.
    // ANTI-FLAPPING: verifikasi on-chain liquidity = 0 sebelum dijurnal.
    for (const t of tracks) {
      if (activeKeys.includes(t.key) || !t.data?.pair) continue;
      try {
        const tokenId = BigInt(t.key.split('-')[1]);
        const liq = t.key.startsWith('v4-')
          ? await v4Liquidity(tokenId)
          : await v3Liquidity(tokenId);
        if (liq > 0n) continue;
      } catch {
        continue; // tidak bisa diverifikasi — tunda
      }
      const d = t.data;
      // Nilai penutupan dari tx tarik-liquidity asli; fallback snapshot terakhir
      let rec: any = null;
      if (t.key.startsWith('v4-')) {
        const tokenId = BigInt(t.key.split('-')[1]);
        const meta = await this.poolMeta(tokenId);
        if (meta) {
          const events = await this.saltEvents(meta.poolId, tokenId);
          const { episodes } = segmentEpisodes(events);
          if (episodes.length > 0) {
            rec = await this.reconstructEpisode(
              tokenId, episodes[episodes.length - 1], meta.poolId, meta.meta0, meta.meta1, address,
            );
          }
        }
      }
      const initial = rec?.initialUsd ?? Number(t.initial_usd);
      const finalUsd = rec?.finalUsd ?? d.valueUsd;
      const feesUsd = rec ? null : (d.feesUsd ?? 0) + (d.collectedFeesUsd ?? 0);
      const pnlUsd = rec ? rec.pnlUsd : d.pnlUsd;
      await sql.unsafe(
        `INSERT INTO "${schema}".journal
           (key, pair, version, open_ts, close_ts, initial_usd, final_usd, fees_usd, pnl_usd, pnl_pct, close_side, source, estimated)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (key, close_ts) DO NOTHING`,
        [t.key, d.pair, d.version,
          rec ? new Date(rec.openTs) : t.open_ts,
          rec ? new Date(rec.closeTs) : new Date(),
          initial, finalUsd, feesUsd, pnlUsd,
          initial > 0 ? (pnlUsd / initial) * 100 : null,
          rec?.closeSide ?? d.closeSide,
          rec ? 'live' : 'live-snapshot',
          rec?.estimated ?? false],
      );
      await sql.unsafe(`DELETE FROM "${schema}".position_track WHERE key = $1`, [t.key]);
    }

    // Episode yang terjadi di luar pengawasan monitor
    await this.recoverMissedEpisodes(address, schema, activeKeys).catch((err) =>
      console.warn('[tracking] pemulihan episode gagal:', err.message));
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
