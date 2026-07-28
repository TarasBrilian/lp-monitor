import { Injectable } from '@nestjs/common';
import { EXPLORER, TOKENS } from '@lpmon/shared';
import { client, isSameAddr } from '../chain/client.js';
import { ethUsd } from '../chain/prices.js';

const priceCache = new Map<string, { price: number | null; ts: number }>();

async function gtPrices(addrs: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const need: string[] = [];
  for (const addr of addrs) {
    const hit = priceCache.get(addr);
    if (hit && Date.now() - hit.ts < 300_000) {
      if (hit.price != null) result.set(addr, hit.price);
    } else need.push(addr);
  }
  if (need.length === 0) return result;
  try {
    const res = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/multi/${need.slice(0, 30).join(',')}`,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) },
    );
    if (res.ok) {
      const json: any = await res.json();
      for (const item of json?.data ?? []) {
        const addr = item?.attributes?.address?.toLowerCase();
        const price = Number(item?.attributes?.price_usd);
        if (addr && price > 0) {
          priceCache.set(addr, { price, ts: Date.now() });
          result.set(addr, price);
        }
      }
    }
    for (const addr of need) if (!result.has(addr)) priceCache.set(addr, { price: null, ts: Date.now() });
  } catch { /* tampil tanpa harga */ }
  return result;
}

@Injectable()
export class BalancesService {
  private cache = new Map<string, { ts: number; data: unknown }>();

  async list(address: string) {
    const hit = this.cache.get(address.toLowerCase());
    if (hit && Date.now() - hit.ts < 60_000) return hit.data;

    const eth = await ethUsd();
    const tokens: any[] = [];

    try {
      const raw = await client.getBalance({ address: address as `0x${string}` });
      const amount = Number(raw) / 1e18;
      tokens.push({ symbol: 'ETH', address: null, native: true, verified: true, amount, priceUsd: eth, usd: eth != null ? amount * eth : null });
    } catch { /* saldo ETH tidak terbaca */ }

    try {
      let url = `${EXPLORER}/api/v2/addresses/${address}/tokens?type=ERC-20`;
      const items: any[] = [];
      for (let page = 0; page < 5 && url; page++) {
        const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) break;
        const json: any = await res.json();
        items.push(...(json.items ?? []));
        const next = json.next_page_params;
        url = next
          ? `${EXPLORER}/api/v2/addresses/${address}/tokens?type=ERC-20&` +
            new URLSearchParams(Object.entries(next).map(([k, v]) => [k, String(v)])).toString()
          : '';
      }

      const unknown: string[] = [];
      for (const it of items) {
        const t = it.token ?? {};
        const addr = (t.address_hash ?? t.address)?.toLowerCase();
        const decimals = Number(t.decimals ?? 18);
        const amount = Number(it.value ?? 0) / Math.pow(10, decimals);
        if (!addr || !(amount > 0)) continue;
        const verified = isSameAddr(addr, TOKENS.USDG) || isSameAddr(addr, TOKENS.WETH);
        let priceUsd: number | null = null;
        if (isSameAddr(addr, TOKENS.USDG)) priceUsd = 1;
        else if (isSameAddr(addr, TOKENS.WETH)) priceUsd = eth;
        else if (Number(t.exchange_rate) > 0) priceUsd = Number(t.exchange_rate);
        if (priceUsd == null) unknown.push(addr);
        const impostor = !verified && ['USDG', 'WETH', 'ETH'].includes((t.symbol ?? '').toUpperCase());
        tokens.push({ symbol: t.symbol ?? '???', address: addr, native: false, verified, impostor, amount, priceUsd, usd: priceUsd != null ? amount * priceUsd : null });
      }

      const found = await gtPrices(unknown);
      for (const b of tokens) {
        if (b.usd == null && b.address && found.has(b.address)) {
          b.priceUsd = found.get(b.address);
          b.usd = b.amount * b.priceUsd;
        }
      }
    } catch { /* Blockscout gagal, minimal ETH tampil */ }

    tokens.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
    const data = { tokens, totalUsd: tokens.reduce((s, t) => s + (t.usd ?? 0), 0), updatedAt: Date.now() };
    this.cache.set(address.toLowerCase(), { ts: Date.now(), data });
    return data;
  }
}
