import { Injectable } from '@nestjs/common';
import { keccak256, encodeAbiParameters, pad, toHex } from 'viem';
import { CONTRACTS, EXPLORER, TOKENS, tenantSchema } from '@lpmon/shared';
import { sql } from '../db.js';
import { client, isSameAddr } from '../chain/client.js';
import { modifyLiquidityEvent, nfpmV3Events, v3PoolAbi, v4StateViewAbi, v4PositionManagerAbi, POOL_KEY_ABI } from '../chain/abi.js';
import { tokenMeta, type TokenMeta } from '../chain/tokens.js';
import { sqrtPriceX96ToSqrtPrice, priceFromSqrt, positionAmounts, toHuman } from '../chain/math.js';
import { ethUsd, usdPerToken } from '../chain/prices.js';
import { poolStats } from '../chain/volume.js';
import { v3Liquidity, v4Liquidity } from '../chain/positions.js';

type LiqEvent = {
  tx_hash: string; block_number: bigint | string; timestamp: number | string;
  liquidity_delta: bigint | string; tick_lower?: number | string; tick_upper?: number | string;
};
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

// Event v3 (increase/decrease/collect) → bentuk LiqEvent untuk segmentEpisodes
function v3ToDeltas(rows: any[]): any[] {
  return rows.map((r) => ({
    ...r,
    liquidity_delta:
      r.kind === 'increase' ? BigInt(r.liquidity)
      : r.kind === 'decrease' ? -BigInt(r.liquidity)
      : 0n,
  }));
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
      SELECT tx_hash, block_number, timestamp, liquidity_delta, tick_lower, tick_upper
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
      tick_lower: l.args.tickLower,
      tick_upper: l.args.tickUpper,
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
      return { usd0, usd1, sqrtPriceX96: slot0[0], tick: Number(slot0[1]), estimated: usesEthAnchor };
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
    let principalUsd = 0; // nilai pokok (dari liquidity math) — selisihnya dengan aliran = fee
    let estimated = false;
    const seenTx = new Set<string>(); // >1 event dalam 1 tx: aliran wallet dihitung sekali
    for (const ev of events) {
      const hist = await this.usdAtBlock(poolId, meta0, meta1, BigInt(ev.block_number));
      if (!hist) estimated = true;
      else if (hist.estimated) estimated = true;

      if (hist && ev.tick_lower != null && ev.tick_upper != null) {
        const delta = BigInt(ev.liquidity_delta);
        const { amount0, amount1 } = positionAmounts({
          liquidity: delta < 0n ? -delta : delta,
          tickLower: Number(ev.tick_lower),
          tickUpper: Number(ev.tick_upper),
          sqrtPriceX96: hist.sqrtPriceX96,
          tick: hist.tick,
        });
        principalUsd += toHuman(amount0, meta0.decimals) * hist.usd0 + toHuman(amount1, meta1.decimals) * hist.usd1;
      }
      if (seenTx.has(ev.tx_hash)) continue;
      seenTx.add(ev.tx_hash);
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
    return { usd, memeShare: share, principalUsd, estimated };
  }

  // Modal awal posisi AKTIF: semua adds milik episode berjalan (bukan episode
  // lama NFT yang dipakai ulang). lastAddBlock = blok add terakhir yang sudah
  // masuk hitungan — dipakai mendeteksi add liquidity susulan.
  private async reconstructEntry(pos: any, wallet: string, indexFresh = false):
    Promise<{ initialUsd: number; openTs: number; source: string; lastAddBlock: number } | null> {
    if (pos.version !== 'v4') return this.reconstructEntryV3(pos, indexFresh);
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
        lastAddBlock: Number(adds[adds.length - 1].block_number),
      };
    } catch {
      return null;
    }
  }

  // Modal awal v3: jumlah amount0/amount1 semua IncreaseLiquidity episode
  // berjalan, dinilai pada harga pool di blok masing-masing. Amount event =
  // yang benar-benar masuk posisi (refund NFPM otomatis tak terhitung).
  private async reconstructEntryV3(pos: any, indexFresh: boolean):
    Promise<{ initialUsd: number; openTs: number; source: string; lastAddBlock: number } | null> {
    try {
      const rows = await this.v3Events(BigInt(pos.tokenId), indexFresh);
      if (!rows || rows.length === 0) return null;
      const { open } = segmentEpisodes(v3ToDeltas(rows));
      if (!open) return null;
      const incs = (open as any[]).filter((e) => e.kind === 'increase');
      if (incs.length === 0) return null;
      let usd = 0;
      let estimated = false;
      for (const inc of incs) {
        const { usd0, usd1, estimated: est } = await this.v3UsdAtBlock(pos, BigInt(inc.block_number));
        if (est) estimated = true;
        if (usd0 == null || usd1 == null) { estimated = true; continue; }
        usd += toHuman(Number(inc.amount0), pos.meta0.decimals) * usd0
             + toHuman(Number(inc.amount1), pos.meta1.decimals) * usd1;
      }
      if (!(usd > 0)) return null;
      let openTs = Number(incs[0].timestamp ?? 0) * 1000;
      if (!openTs) { // event dari fallback chain tidak membawa timestamp
        openTs = Number((await client.getBlock({
          blockNumber: BigInt(incs[0].block_number),
        })).timestamp) * 1000;
      }
      return {
        initialUsd: usd, openTs,
        source: estimated ? 'index-estimasi' : 'index',
        lastAddBlock: Number(incs[incs.length - 1].block_number),
      };
    } catch {
      return null;
    }
  }

  // Add liquidity SUSULAN (setelah sinceBlock) pada episode berjalan — nilainya
  // ditambahkan ke modal awal yang sudah ada (termasuk modal manual)
  private async entryAddsDelta(pos: any, wallet: string, sinceBlock: number, indexFresh: boolean):
    Promise<{ usd: number; lastBlock: number; estimated: boolean } | null> {
    if (pos.version === 'v4') {
      const events = await this.saltEvents(pos.pool, BigInt(pos.tokenId));
      const { open } = segmentEpisodes(events);
      if (!open) return null;
      const fresh = open.filter(
        (e) => BigInt(e.liquidity_delta) > 0n && Number(e.block_number) > sinceBlock,
      );
      if (fresh.length === 0) return null;
      const { usd, estimated } = await this.valueEvents(fresh, pos.pool, pos.meta0, pos.meta1, wallet);
      if (!(usd > 0)) return null;
      return { usd, lastBlock: Number(fresh[fresh.length - 1].block_number), estimated };
    }
    const rows = await this.v3Events(BigInt(pos.tokenId), indexFresh);
    if (!rows || rows.length === 0) return null;
    const { open } = segmentEpisodes(v3ToDeltas(rows));
    if (!open) return null;
    const fresh = (open as any[]).filter(
      (e) => e.kind === 'increase' && Number(e.block_number) > sinceBlock,
    );
    if (fresh.length === 0) return null;
    let usd = 0;
    let estimated = false;
    for (const inc of fresh) {
      const { usd0, usd1, estimated: est } = await this.v3UsdAtBlock(pos, BigInt(inc.block_number));
      if (est) estimated = true;
      if (usd0 == null || usd1 == null) { estimated = true; continue; }
      usd += toHuman(Number(inc.amount0), pos.meta0.decimals) * usd0
           + toHuman(Number(inc.amount1), pos.meta1.decimals) * usd1;
    }
    if (!(usd > 0)) return null;
    return { usd, lastBlock: Number(fresh[fresh.length - 1].block_number), estimated };
  }

  // Rekonstruksi penuh satu episode TERTUTUP -> entri journal
  private async reconstructEpisode(
    tokenId: bigint, episode: Episode, poolId: string, meta0: TokenMeta, meta1: TokenMeta, wallet: string,
  ) {
    const adds = episode.filter((e) => BigInt(e.liquidity_delta) > 0n);
    // Klaim fee v4 = ModifyLiquidity dengan delta 0. Ikut dinilai sebagai aliran
    // keluar (pokoknya nol), sehingga fee yang diklaim di tengah episode masuk
    // ke exit.usd — tanpa ini, klaim terpisah lenyap dari fee & P&L.
    const removes = episode.filter((e) => BigInt(e.liquidity_delta) <= 0n);
    if (adds.length === 0 || !removes.some((e) => BigInt(e.liquidity_delta) < 0n)) return null;
    const entry = await this.valueEvents(adds, poolId, meta0, meta1, wallet);
    const exit = await this.valueEvents(removes, poolId, meta0, meta1, wallet);
    if (!(entry.usd > 0) || !(exit.usd > 0)) return null;
    // Fee = total penarikan (termasuk klaim di tengah episode) − pokok
    // (liquidity math di blok masing-masing event; event delta-0 pokoknya 0).
    const feesUsd = exit.principalUsd > 0 ? Math.max(0, exit.usd - exit.principalUsd) : null;
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
      feesUsd,
      pnlUsd: exit.usd - entry.usd,
      closeSide: exit.memeShare > 0.95 ? 'below' : exit.memeShare < 0.05 ? 'above' : 'in',
      estimated: entry.estimated || exit.estimated,
    };
  }

  // Fee v4 yang sudah DIKLAIM selama episode berjalan: event delta-0 (collect)
  // milik episode terbuka, dinilai dari aliran token ke wallet pada blok kejadian.
  // Inkremental — hanya event setelah sinceBlock yang dinilai (hemat Blockscout).
  private async v4CollectedDelta(pos: any, wallet: string, sinceBlock: number) {
    const events = await this.saltEvents(null, BigInt(pos.tokenId)); // index-only, tanpa fallback getLogs
    const { open } = segmentEpisodes(events);
    if (!open) return null;
    const collects = open.filter(
      (e) => BigInt(e.liquidity_delta) === 0n && Number(e.block_number) > sinceBlock,
    );
    if (collects.length === 0) return null;
    // Tiap event = 1 Blockscout + 1 archive call — dibatasi per poll supaya
    // dashboard tidak menggantung; sisanya lanjut poll berikutnya dari lastBlock
    const batch = collects.slice(0, 8);
    const { usd } = await this.valueEvents(batch, pos.pool, pos.meta0, pos.meta1, wallet);
    if (!(usd > 0)) return null;
    return { usd, lastBlock: Number(batch[batch.length - 1].block_number) };
  }

  // Fallback saat indeks belum segar: event v3 sebuah tokenId langsung dari
  // chain via getLogs (jendela ~600 rb blok, potongan 150 rb), cache 10 menit.
  // Posisi lebih tua dari jendela hanya kehilangan event awalnya — walk fee
  // tetap konservatif karena pokok decrease dinetkan dari collect.
  private v3LogsCache = new Map<string, { ts: number; events: any[] }>();
  private async v3EventsFromChain(tokenId: bigint): Promise<any[] | null> {
    const cacheKey = tokenId.toString();
    const hit = this.v3LogsCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < 600_000) return hit.events;
    const head = await client.getBlockNumber();
    const CHUNK = 150_000n;
    const start = head > 600_000n ? head - 600_000n : 0n;
    const logs: any[] = [];
    let ok = false;
    for (const ev of nfpmV3Events) {
      for (let from = start; from <= head; from += CHUNK) {
        const to = from + CHUNK - 1n > head ? head : from + CHUNK - 1n;
        try {
          logs.push(...await client.getLogs({
            address: CONTRACTS.v3PositionManager as `0x${string}`,
            event: ev as any, args: { tokenId } as any,
            fromBlock: from, toBlock: to,
          }));
          ok = true;
        } catch { /* potongan gagal, lanjut */ }
      }
    }
    if (!ok) return null; // semua potongan gagal — jangan cache, coba lagi nanti
    const kindOf: Record<string, string> = {
      IncreaseLiquidity: 'increase', DecreaseLiquidity: 'decrease', Collect: 'collect',
    };
    const events = logs
      .map((l: any) => ({
        kind: kindOf[l.eventName],
        liquidity: l.args.liquidity ?? 0n,
        amount0: l.args.amount0, amount1: l.args.amount1,
        tx_hash: l.transactionHash, block_number: l.blockNumber, timestamp: 0,
      }))
      .sort((a, b) => Number(BigInt(a.block_number) - BigInt(b.block_number)));
    this.v3LogsCache.set(cacheKey, { ts: Date.now(), events });
    return events;
  }

  // Semua event v3 sebuah tokenId: dari indeks saat segar, selain itu (atau
  // saat indeks kosong untuk token ini) langsung dari chain
  private async v3Events(tokenId: bigint, indexFresh: boolean): Promise<any[] | null> {
    if (indexFresh) {
      try {
        const rows: any[] = await sql`
          SELECT kind, liquidity, amount0, amount1, tx_hash, block_number, timestamp
          FROM ponder.v3_position_event
          WHERE token_id = ${tokenId.toString()}::numeric
          ORDER BY block_number` as any;
        if (rows.length > 0) return rows;
      } catch { /* tabel belum ada — pakai fallback chain */ }
    }
    return this.v3EventsFromChain(tokenId);
  }

  // Harga USD kedua token pool v3 pada blok tertentu (fallback: harga sekarang)
  private async v3UsdAtBlock(pos: any, blockNumber: bigint):
    Promise<{ usd0: number | null; usd1: number | null; estimated: boolean }> {
    try {
      const slot0 = await client.readContract({
        address: pos.pool as `0x${string}`, abi: v3PoolAbi, functionName: 'slot0', blockNumber,
      });
      const price = priceFromSqrt(sqrtPriceX96ToSqrtPrice(slot0[0]), pos.meta0.decimals, pos.meta1.decimals);
      const eth = await ethUsd();
      const { usd0, usd1 } = usdPerToken({ meta0: pos.meta0, meta1: pos.meta1, priceT1PerT0: price, eth });
      const estimated = pos.meta0.native || pos.meta1.native ||
        isSameAddr(pos.meta0.address, TOKENS.WETH) || isSameAddr(pos.meta1.address, TOKENS.WETH);
      return { usd0, usd1, estimated };
    } catch {
      return { usd0: pos.usd0, usd1: pos.usd1, estimated: true };
    }
  }

  // Fee v3 yang sudah diklaim: collect() membayar tokensOwed = pokok hasil
  // decrease + fee. Porsi fee = collect − pokok decrease yang belum terbayar,
  // dinilai pada harga pool di blok klaim (fallback: harga sekarang).
  // Decrease yang belum di-collect membuat porsi fee tertahan sementara (≥0).
  private async v3CollectedDelta(pos: any, sinceBlock: number, indexFresh: boolean) {
    const rows = await this.v3Events(BigInt(pos.tokenId), indexFresh);
    if (rows == null || rows.length === 0) return null;
    const { open } = segmentEpisodes(v3ToDeltas(rows));
    if (!open) return null;
    let pend0 = 0n, pend1 = 0n; // pokok decrease yang belum ditarik via collect
    const feeEvents: { block: number; fee0: bigint; fee1: bigint }[] = [];
    for (const ev of open as any[]) {
      if (ev.kind === 'decrease') {
        pend0 += BigInt(ev.amount0);
        pend1 += BigInt(ev.amount1);
      } else if (ev.kind === 'collect') {
        const a0 = BigInt(ev.amount0), a1 = BigInt(ev.amount1);
        const f0 = a0 > pend0 ? a0 - pend0 : 0n;
        const f1 = a1 > pend1 ? a1 - pend1 : 0n;
        pend0 = pend0 > a0 ? pend0 - a0 : 0n;
        pend1 = pend1 > a1 ? pend1 - a1 : 0n;
        if (f0 > 0n || f1 > 0n) feeEvents.push({ block: Number(ev.block_number), fee0: f0, fee1: f1 });
      }
    }
    // Batasi archive call per poll — sisanya lanjut poll berikutnya dari lastBlock
    const fresh = feeEvents.filter((fe) => fe.block > sinceBlock).slice(0, 8);
    if (fresh.length === 0) return null;
    let usd = 0;
    for (const fe of fresh) {
      const { usd0, usd1 } = await this.v3UsdAtBlock(pos, BigInt(fe.block));
      usd += toHuman(Number(fe.fee0), pos.meta0.decimals) * (usd0 ?? 0)
           + toHuman(Number(fe.fee1), pos.meta1.decimals) * (usd1 ?? 0);
    }
    if (!(usd > 0)) return null;
    return { usd, lastBlock: fresh[fresh.length - 1].block };
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
      WHERE version = 'v4' AND lower(latest."to") = ${address.toLowerCase()}
      ORDER BY token_id DESC`; // terbaru dulu: entri terkini kebagian jatah heavy-ops duluan

    // Pekerjaan berat (rekonstruksi via Blockscout + archive call) dibatasi per
    // poll supaya request dashboard tidak menggantung; sisanya poll berikutnya
    let heavyOps = 0;
    const MAX_HEAVY = 4;

    for (const { token_id } of owned as any[]) {
      if (heavyOps >= MAX_HEAVY) break;
      const tokenId = BigInt(token_id);
      const key = `v4-${tokenId}`;
      const events = await this.saltEvents(null, tokenId);
      const { episodes } = segmentEpisodes(events);
      if (episodes.length === 0) continue;
      let meta: Awaited<ReturnType<typeof this.poolMeta>> = null;
      for (const ep of episodes) {
        if (heavyOps >= MAX_HEAVY) break;
        // Episode nyata minimal punya satu add dan satu remove. Potongan berisi
        // klaim delta-0 saja (riwayat sebelum START_BLOCK terpotong) dilewati —
        // rekonstruksinya pasti null dan akan menguras jatah heavyOps tiap poll
        if (!ep.some((e) => BigInt(e.liquidity_delta) > 0n) ||
            !ep.some((e) => BigInt(e.liquidity_delta) < 0n)) continue;
        const closeTs = Number(ep[ep.length - 1].timestamp) * 1000;
        const [exists] = await sql.unsafe(
          `SELECT id, fees_usd, collects_checked FROM "${schema}".journal
           WHERE key = $1 AND ABS(EXTRACT(EPOCH FROM close_ts) - $2) < 180`,
          [key, closeTs / 1000],
        );
        // Backfill bila: belum ada fee (impor v1 / rekonstruksi lama), ATAU
        // episode mengandung klaim fee (delta-0) yang belum pernah diperhitungkan
        // — rekonstruksi sebelum fix collects membuang event tersebut
        const hasCollects = ep.some((e) => BigInt(e.liquidity_delta) === 0n);
        if (exists && exists.fees_usd != null && (exists.collects_checked || !hasCollects)) {
          if (!exists.collects_checked) {
            await sql.unsafe(
              `UPDATE "${schema}".journal SET collects_checked = true WHERE id = $1`, [exists.id]);
          }
          continue;
        }
        meta ??= await this.poolMeta(tokenId);
        if (!meta) break;
        const rec = await this.reconstructEpisode(tokenId, ep, meta.poolId, meta.meta0, meta.meta1, address);
        heavyOps++;
        if (!rec) {
          // null deterministik (mis. dana bukan dari wallet ini) — tandai supaya
          // tidak dicoba ulang tiap poll; kegagalan transien melempar exception
          if (exists) await sql.unsafe(
            `UPDATE "${schema}".journal SET collects_checked = true WHERE id = $1`, [exists.id]);
          continue;
        }
        const pnlPct = rec.initialUsd > 0 ? (rec.pnlUsd / rec.initialUsd) * 100 : null;
        if (exists) {
          await sql.unsafe(
            `UPDATE "${schema}".journal
             SET open_ts = $2, initial_usd = $3, final_usd = $4, fees_usd = $5,
                 pnl_usd = $6, pnl_pct = $7, close_side = $8, estimated = $9,
                 collects_checked = true
             WHERE id = $1`,
            [exists.id, new Date(rec.openTs), rec.initialUsd, rec.finalUsd, rec.feesUsd,
              rec.pnlUsd, pnlPct, rec.closeSide, rec.estimated],
          );
        } else {
          await sql.unsafe(
            `INSERT INTO "${schema}".journal
               (key, pair, version, open_ts, close_ts, initial_usd, final_usd, fees_usd, pnl_usd, pnl_pct, close_side, source, estimated, collects_checked)
             VALUES ($1,$2,'v4',$3,$4,$5,$6,$7,$8,$9,$10,'rekonstruksi',$11,true)
             ON CONFLICT (key, close_ts) DO NOTHING`,
            [rec.key, rec.pair, new Date(rec.openTs), new Date(rec.closeTs), rec.initialUsd, rec.finalUsd,
              rec.feesUsd, rec.pnlUsd, pnlPct, rec.closeSide, rec.estimated],
          );
        }
      }
    }
  }

  async enrich(address: string, positions: any[]) {
    const schema = tenantSchema(address);
    const activeKeys = positions.map((p) => p.key);

    // Akumulasi fee terklaim hanya saat indeks dekat ujung chain — pada indeks
    // parsial, episode lama yang belum lengkap bisa disangka episode berjalan
    // dan klaimnya salah menempel permanen ke posisi sekarang
    let indexFresh = false;
    let headBlock = 0;
    try {
      headBlock = Number(await client.getBlockNumber());
      const [{ synced }] = await sql`
        SELECT COALESCE(MAX(block_number), 0)::bigint AS synced FROM ponder.liquidity_event`;
      indexFresh = BigInt(headBlock) - BigInt(synced) < 5_000n;
    } catch { /* indeks/RPC belum siap */ }

    const tracks = (await sql.unsafe(`SELECT * FROM "${schema}".position_track`))
      .map((t: any) => ({ ...t, data: parseData(t.data) }));
    const byKey = new Map(tracks.map((t: any) => [t.key, t]));

    for (const pos of positions) {
      let track: any = byKey.get(pos.key);

      // Self-healing: modal "first-seen"/"estimasi" di-upgrade ke nilai eksak
      const upgradable = track &&
        (track.initial_source === 'first-seen' || track.initial_source?.endsWith('-estimasi'));
      if (upgradable) {
        const entry = await this.reconstructEntry(pos, address, indexFresh);
        if (entry && (entry.source === 'index' || track.initial_source === 'first-seen')) {
          track.initial_usd = entry.initialUsd;
          track.initial_source = entry.source;
          track.open_ts = new Date(entry.openTs);
          track.data.entryLastBlock = entry.lastAddBlock;
          track.data.trackedLiquidity = pos.liquidity;
          await sql.unsafe(
            `UPDATE "${schema}".position_track
             SET initial_usd = $2, initial_source = $3, open_ts = $4, updated_at = now()
             WHERE key = $1`,
            [pos.key, entry.initialUsd, entry.source, new Date(entry.openTs)],
          );
        }
      }

      if (!track) {
        const entry = await this.reconstructEntry(pos, address, indexFresh);
        track = {
          key: pos.key,
          open_ts: new Date(entry?.openTs ?? Date.now()),
          initial_usd: entry?.initialUsd ?? pos.valueUsd,
          initial_source: entry?.source ?? 'first-seen',
          data: entry ? { entryLastBlock: entry.lastAddBlock, trackedLiquidity: pos.liquidity } : {},
        };
        await sql.unsafe(
          `INSERT INTO "${schema}".position_track (key, open_ts, initial_usd, initial_source, data)
           VALUES ($1, $2, $3, $4, '{}') ON CONFLICT (key) DO NOTHING`,
          [track.key, track.open_ts, track.initial_usd, track.initial_source],
        );
      }

      // --- Modal awal mengikuti add liquidity susulan ---
      // Tanpa ini, add ke posisi yang sama menaikkan nilai tapi modal diam,
      // sehingga P&L melonjak palsu.
      let entryLastBlock = Number(track.data?.entryLastBlock ?? 0);
      let trackedLiquidity: string | undefined = track.data?.trackedLiquidity;
      try {
        const reconSource = track.initial_source === 'index' || track.initial_source === 'index-estimasi';
        if (!entryLastBlock) {
          // Migrasi track lama (belum punya penanda): sumber on-chain
          // direkonstruksi penuh sekali supaya add yang telanjur terjadi ikut
          // terhitung; sumber manual/first-seen dianggap mencakup kondisi kini
          if (reconSource) {
            const entry = await this.reconstructEntry(pos, address, indexFresh);
            if (entry) {
              track.initial_usd = entry.initialUsd;
              track.initial_source = entry.source;
              track.open_ts = new Date(entry.openTs);
              entryLastBlock = entry.lastAddBlock;
              trackedLiquidity = pos.liquidity;
              await sql.unsafe(
                `UPDATE "${schema}".position_track
                 SET initial_usd = $2, initial_source = $3, open_ts = $4, updated_at = now()
                 WHERE key = $1`,
                [pos.key, entry.initialUsd, entry.source, new Date(entry.openTs)],
              );
            }
          }
          if (!entryLastBlock && !reconSource && headBlock > 0) {
            entryLastBlock = headBlock;
            trackedLiquidity = pos.liquidity;
          }
        } else if (trackedLiquidity != null && BigInt(pos.liquidity) > BigInt(trackedLiquidity)) {
          // Liquidity on-chain naik = ada add baru → nilai add setelah
          // entryLastBlock dan tambahkan ke modal (modal manual ikut bertambah,
          // sumbernya tetap 'manual')
          const delta = await this.entryAddsDelta(pos, address, entryLastBlock, indexFresh);
          if (delta) {
            track.initial_usd = Number(track.initial_usd) + delta.usd;
            if (track.initial_source !== 'manual' && delta.estimated) {
              track.initial_source = 'index-estimasi';
            }
            entryLastBlock = delta.lastBlock;
            trackedLiquidity = pos.liquidity;
            await sql.unsafe(
              `UPDATE "${schema}".position_track
               SET initial_usd = $2, initial_source = $3, updated_at = now()
               WHERE key = $1`,
              [pos.key, track.initial_usd, track.initial_source],
            );
          }
          // delta null: event add belum terlihat indeks/logs — coba poll berikutnya
        } else {
          trackedLiquidity = pos.liquidity; // tetap/berkurang — modal tidak berubah
        }
      } catch { /* transien — dicoba lagi poll berikutnya */ }

      pos.initialUsd = Number(track.initial_usd);
      pos.initialSource = track.initial_source;
      pos.openTs = new Date(track.open_ts).getTime();
      pos.ageMs = Date.now() - pos.openTs;
      // Fee yang sudah diklaim: diakumulasi dari indeks (v4: event delta-0,
      // v3: event Collect), inkremental sejak blok terakhir yang sudah dinilai
      pos.collectedFeesUsd = Number(track.data?.collectedFeesUsd ?? 0);
      let collectLastBlock = Number(track.data?.collectLastBlock ?? 0);
      try {
        // v4 menunggu indeks segar (episode butuh riwayat lengkap); v3 punya
        // fallback getLogs langsung ke chain sehingga jalan kapan pun
        const claimed = pos.version === 'v4'
          ? (indexFresh ? await this.v4CollectedDelta(pos, address, collectLastBlock) : null)
          : await this.v3CollectedDelta(pos, collectLastBlock, indexFresh);
        if (claimed) {
          pos.collectedFeesUsd += claimed.usd;
          collectLastBlock = Math.max(collectLastBlock, claimed.lastBlock);
        }
      } catch { /* transien — dicoba lagi poll berikutnya */ }
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
          collectedFeesUsd: pos.collectedFeesUsd, collectLastBlock,
          entryLastBlock, trackedLiquidity, pnlUsd: pos.pnlUsd, baselineVol24,
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
          // Episode nyata terakhir — potongan berisi klaim delta-0 saja (mis.
          // klaim dust setelah tutup penuh) bukan episode dan dilewati
          const real = episodes.filter((ep) =>
            ep.some((e) => BigInt(e.liquidity_delta) > 0n) &&
            ep.some((e) => BigInt(e.liquidity_delta) < 0n));
          if (real.length > 0) {
            rec = await this.reconstructEpisode(
              tokenId, real[real.length - 1], meta.poolId, meta.meta0, meta.meta1, address,
            );
          }
        }
      }
      const initial = rec?.initialUsd ?? Number(t.initial_usd);
      const finalUsd = rec?.finalUsd ?? d.valueUsd;
      const feesUsd = rec ? rec.feesUsd : (d.feesUsd ?? 0) + (d.collectedFeesUsd ?? 0);
      const pnlUsd = rec ? rec.pnlUsd : d.pnlUsd;
      await sql.unsafe(
        `INSERT INTO "${schema}".journal
           (key, pair, version, open_ts, close_ts, initial_usd, final_usd, fees_usd, pnl_usd, pnl_pct, close_side, source, estimated, collects_checked)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (key, close_ts) DO NOTHING`,
        [t.key, d.pair, d.version,
          rec ? new Date(rec.openTs) : t.open_ts,
          rec ? new Date(rec.closeTs) : new Date(),
          initial, finalUsd, feesUsd, pnlUsd,
          initial > 0 ? (pnlUsd / initial) * 100 : null,
          rec?.closeSide ?? d.closeSide,
          rec ? 'live' : 'live-snapshot',
          rec?.estimated ?? false,
          rec != null],
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
