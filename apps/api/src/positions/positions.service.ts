import { Injectable } from '@nestjs/common';
import { CONTRACTS, EXPLORER } from '@lpmon/shared';
import { sql } from '../db.js';
import { client } from '../chain/client.js';
import { ethUsd } from '../chain/prices.js';
import { readV3Position, readV4Position, v4Liquidity, displayFields } from '../chain/positions.js';

type Discovered = { v3: bigint[]; v4: bigint[]; source: 'index' | 'blockscout' };

const EMPTY_RECHECK_MS = 6 * 3_600_000;
const LIST_CACHE_MS = 30_000;

@Injectable()
export class PositionsService {
  private knownEmpty = new Map<string, number>(); // key posisi -> ts terakhir dicek kosong
  private listCache = new Map<string, { ts: number; data: unknown }>();

  // Discovery utama dari indeks Ponder; fallback ke Blockscout selama backfill
  // indeks belum mengejar ujung chain.
  private async discover(address: string): Promise<Discovered> {
    try {
      const [{ synced }] = await sql`
        SELECT COALESCE(MAX(block_number), 0)::bigint AS synced FROM ponder.position_transfer`;
      const head = await client.getBlockNumber();
      if (head - BigInt(synced) < 2_000n) {
        const rows = await sql`
          SELECT DISTINCT ON (version, token_id) version, token_id, "to"
          FROM ponder.position_transfer
          ORDER BY version, token_id, block_number DESC`;
        const mine = rows.filter((r: any) => r.to.toLowerCase() === address.toLowerCase());
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
      const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) break;
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

  async list(address: string) {
    const cached = this.listCache.get(address.toLowerCase());
    if (cached && Date.now() - cached.ts < LIST_CACHE_MS) return cached.data;

    const eth = await ethUsd();
    const ids = await this.discover(address);

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

    const positions = [];
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

    const data = {
      address,
      ethUsd: eth,
      discovery: ids.source,
      totalValueUsd: positions.reduce((s, p) => s + p.valueUsd, 0),
      totalFeesUsd: positions.reduce((s, p) => s + p.feesUsd, 0),
      positions,
      updatedAt: Date.now(),
    };
    this.listCache.set(address.toLowerCase(), { ts: Date.now(), data });
    return data;
  }
}
