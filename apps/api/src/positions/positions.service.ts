import { Injectable } from '@nestjs/common';
import { CONTRACTS, EXPLORER } from '@lpmon/shared';
import { sql } from '../db.js';
import { client, isSameAddr } from '../chain/client.js';
import { blockscoutFetch } from '../chain/blockscout.js';
import { ethUsd } from '../chain/prices.js';
import { readV3Position, readV4Position, v4Liquidity, displayFields } from '../chain/positions.js';
import { erc721TransferEvent, v3PositionManagerAbi, v4PositionManagerAbi } from '../chain/abi.js';
import { TrackingService } from './tracking.service.js';

type Discovered = { v3: bigint[]; v4: bigint[]; source: string };

const EMPTY_RECHECK_MS = 6 * 3_600_000;
const LIST_CACHE_MS = 30_000;
// Jendela pindaian awal jaring pengaman (~14 jam pada ~10 blok/detik) — cukup
// menutup ketertinggalan Blockscout maupun indeks. Setelahnya inkremental.
const SAFETY_LOOKBACK = 500_000n;
const SAFETY_CHUNK = 50_000n;

@Injectable()
export class PositionsService {
  constructor(private tracking: TrackingService) {}

  private knownEmpty = new Map<string, number>(); // key posisi -> ts terakhir dicek kosong
  private listCache = new Map<string, { ts: number; data: unknown }>();

  invalidate(address: string) {
    this.listCache.delete(address.toLowerCase());
  }

  // Discovery utama dari indeks Ponder; fallback ke Blockscout selama backfill
  // indeks belum mengejar ujung chain.
  private async discoverPrimary(address: string): Promise<Discovered> {
    try {
      const [{ synced }] = await sql`
        SELECT COALESCE(MAX(block_number), 0)::bigint AS synced FROM ponder.position_transfer`;
      const head = await client.getBlockNumber();
      if (head - BigInt(synced) < 2_000n) {
        // Pemilik terakhir tiap NFT; tie-break pakai id supaya deterministik
        // saat ada >1 transfer dalam blok yang sama
        const mine = await sql`
          SELECT version, token_id FROM (
            SELECT DISTINCT ON (version, token_id) version, token_id, "to"
            FROM ponder.position_transfer
            ORDER BY version, token_id, block_number DESC, id DESC
          ) latest
          WHERE lower(latest."to") = ${address.toLowerCase()}`;
        return {
          v3: mine.filter((r: any) => r.version === 'v3').map((r: any) => BigInt(r.token_id)),
          v4: mine.filter((r: any) => r.version === 'v4').map((r: any) => BigInt(r.token_id)),
          source: 'index',
        };
      }
    } catch { /* indeks belum siap */ }
    return this.discoverBlockscout(address);
  }

  private async discoverBlockscout(address: string): Promise<Discovered> {
    const v3Addr = CONTRACTS.v3PositionManager.toLowerCase();
    const v4Addr = CONTRACTS.v4PositionManager.toLowerCase();
    const found: Discovered = { v3: [], v4: [], source: 'blockscout' };
    let url = `${EXPLORER}/api/v2/addresses/${address}/nft?type=ERC-721`;
    for (let page = 0; page < 10 && url; page++) {
      const res = await blockscoutFetch(url);
      // Kegagalan harus jadi error, bukan hasil kosong — hasil kosong palsu
      // akan membuat semua posisi dianggap "ditutup"
      if (!res.ok) throw new Error(`Blockscout ${res.status} saat discovery`);
      const json: any = await res.json();
      for (const item of json.items ?? []) {
        const addr = (item?.token?.address_hash ?? item?.token?.address)?.toLowerCase();
        if (item?.id == null) continue;
        if (addr === v3Addr) found.v3.push(BigInt(item.id));
        if (addr === v4Addr) found.v4.push(BigInt(item.id));
      }
      const next = json.next_page_params;
      url = next
        ? `${EXPLORER}/api/v2/addresses/${address}/nft?type=ERC-721&` +
          new URLSearchParams(Object.entries(next).map(([k, v]) => [k, String(v)])).toString()
        : '';
    }
    return found;
  }

  // Kedua sumber utama bisa tertinggal berjam-jam: indeks kepemilikan NFT
  // Blockscout maupun indeks Ponder saat RPC lambat. Posisi yang baru dibuka
  // lalu tidak terlihat sama sekali. Jaring pengaman: pindai event Transfer
  // ke address ini langsung dari chain, inkremental sejak blok terakhir yang
  // sudah dipindai.
  //
  // HANYA MENAMBAH kandidat, tidak pernah menggantikan sumber utama — pindaian
  // ini cuma mencakup blok belakangan, jadi kalau dipakai sendirian posisi lama
  // akan tampak hilang dan ikut terjurnal sebagai "ditutup".
  private safetyScan = new Map<string, { lastBlock: bigint; v3: Set<string>; v4: Set<string> }>();

  private async discoverOnchain(address: string): Promise<{ v3: bigint[]; v4: bigint[] }> {
    const key = address.toLowerCase();
    const head = await client.getBlockNumber();
    const prev = this.safetyScan.get(key);
    const state = prev ?? { lastBlock: 0n, v3: new Set<string>(), v4: new Set<string>() };
    const from = prev ? prev.lastBlock + 1n : head > SAFETY_LOOKBACK ? head - SAFETY_LOOKBACK : 0n;

    let complete = true;
    for (const [version, contract] of [
      ['v3', CONTRACTS.v3PositionManager],
      ['v4', CONTRACTS.v4PositionManager],
    ] as const) {
      for (let f = from; f <= head; f += SAFETY_CHUNK) {
        const t = f + SAFETY_CHUNK - 1n > head ? head : f + SAFETY_CHUNK - 1n;
        try {
          const logs = await client.getLogs({
            address: contract as `0x${string}`,
            event: erc721TransferEvent,
            args: { to: address as `0x${string}` },
            fromBlock: f,
            toBlock: t,
          });
          for (const l of logs) state[version].add(String(l.args.tokenId));
        } catch {
          complete = false; // potongan gagal — jangan majukan penanda, coba lagi nanti
        }
      }
    }
    // Penanda hanya maju kalau seluruh rentang berhasil dipindai, supaya tidak
    // ada blok yang terlewat diam-diam
    if (complete) state.lastBlock = head;
    this.safetyScan.set(key, state);
    return { v3: [...state.v3].map(BigInt), v4: [...state.v4].map(BigInt) };
  }

  // NFT yang pernah masuk ke address bisa sudah dipindahtangankan — pemilik
  // sekarang harus diverifikasi sebelum posisinya ikut ditampilkan
  private async ownedNow(address: string, v3: bigint[], v4: bigint[]) {
    const keep = async (ids: bigint[], contract: string, abi: typeof v3PositionManagerAbi | typeof v4PositionManagerAbi) => {
      const res = await Promise.allSettled(ids.map((id) =>
        client.readContract({ address: contract as `0x${string}`, abi: abi as any, functionName: 'ownerOf', args: [id] })));
      return ids.filter((_, i) => {
        const r = res[i];
        return r.status === 'fulfilled' && isSameAddr(r.value as string, address);
      });
    };
    const [k3, k4] = await Promise.all([
      keep(v3, CONTRACTS.v3PositionManager, v3PositionManagerAbi),
      keep(v4, CONTRACTS.v4PositionManager, v4PositionManagerAbi),
    ]);
    return { v3: k3, v4: k4 };
  }

  private async discover(address: string): Promise<Discovered> {
    const found = await this.discoverPrimary(address);
    try {
      const extra = await this.discoverOnchain(address);
      const seen3 = new Set(found.v3.map(String));
      const seen4 = new Set(found.v4.map(String));
      const cand3 = extra.v3.filter((id) => !seen3.has(String(id)));
      const cand4 = extra.v4.filter((id) => !seen4.has(String(id)));
      if (cand3.length || cand4.length) {
        const owned = await this.ownedNow(address, cand3, cand4);
        found.v3.push(...owned.v3);
        found.v4.push(...owned.v4);
        if (owned.v3.length || owned.v4.length) found.source += '+onchain';
      }
    } catch { /* jaring pengaman bersifat best-effort — sumber utama tetap dipakai */ }
    return found;
  }

  async list(address: string) {
    const cached = this.listCache.get(address.toLowerCase());
    if (cached && Date.now() - cached.ts < LIST_CACHE_MS) return cached.data;

    const eth = await ethUsd();
    let ids: Discovered;
    try {
      ids = await this.discover(address);
    } catch (err: any) {
      // Discovery gagal total: kembalikan snapshot lama (basi) daripada
      // menyimpulkan portofolio kosong
      if (cached) return { ...(cached.data as any), stale: true, error: err.message };
      throw err;
    }

    // Saring posisi kosong dengan pembacaan ringan (digabung Multicall3).
    // NFT yang sudah ketahuan kosong tidak dicek ulang selama 6 jam.
    const v4Cand = ids.v4.filter((id) => {
      const ts = this.knownEmpty.get(`v4-${id}`);
      return !(ts && Date.now() - ts < EMPTY_RECHECK_MS);
    });
    const v4Liqs = await Promise.allSettled(v4Cand.map((id) => v4Liquidity(id)));
    const v4Active = v4Cand.filter((id, i) => {
      const r = v4Liqs[i];
      const active = r.status === 'fulfilled' && r.value > 0n;
      if (r.status === 'fulfilled' && !active) this.knownEmpty.set(`v4-${id}`, Date.now());
      return active;
    });

    const results = await Promise.allSettled([
      ...v4Active.map((id) => readV4Position(id, eth)),
      ...ids.v3.map((id) => readV3Position(id, address as `0x${string}`, eth)),
    ]);

    const positions: any[] = []; // enrich menambahkan field P&L/fee secara dinamis
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const pos = r.value;
      if (Number(pos.liquidity) === 0 && pos.fees0 === 0 && pos.fees1 === 0) continue;
      const { disp, inRange, outSide, quoteIsAnchor } = displayFields(pos);
      const valueUsd = pos.amt0 * (pos.usd0 ?? 0) + pos.amt1 * (pos.usd1 ?? 0);
      const feesUsd = pos.fees0 * (pos.usd0 ?? 0) + pos.fees1 * (pos.usd1 ?? 0);
      positions.push({
        ...pos,
        pair: `${disp.base}/${disp.quote}`,
        disp, inRange, outSide, quoteIsAnchor, valueUsd, feesUsd,
      });
    }
    positions.sort((a, b) => b.valueUsd - a.valueUsd);

    // Modal awal, P&L, umur, dan jurnal penutupan (schema milik address)
    await this.tracking.enrich(address, positions).catch((err) =>
      console.warn('[tracking] gagal:', err.message));

    const data = {
      address,
      ethUsd: eth,
      discovery: ids.source,
      totalValueUsd: positions.reduce((s, p) => s + p.valueUsd, 0),
      totalFeesUsd: positions.reduce((s, p) => s + p.feesUsd + (p.collectedFeesUsd ?? 0), 0),
      totalPnlUsd: positions.reduce((s, p) => s + (p.pnlUsd ?? 0), 0),
      positions,
      updatedAt: Date.now(),
    };
    this.listCache.set(address.toLowerCase(), { ts: Date.now(), data });
    return data;
  }
}
