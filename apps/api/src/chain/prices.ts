import { CONTRACTS, TOKENS } from '@lpmon/shared';
import { client, ZERO_ADDR, isSameAddr } from './client.js';
import { v3FactoryAbi, v3PoolAbi } from './abi.js';
import { sqrtPriceX96ToSqrtPrice, priceFromSqrt } from './math.js';
import type { TokenMeta } from './tokens.js';

let ethCache: { price: number | null; ts: number } = { price: null, ts: 0 };

export async function ethUsd(): Promise<number | null> {
  if (ethCache.price && Date.now() - ethCache.ts < 120_000) return ethCache.price;
  for (const fee of [500, 3000, 10000]) {
    try {
      const pool = await client.readContract({
        address: CONTRACTS.v3Factory as `0x${string}`, abi: v3FactoryAbi,
        functionName: 'getPool', args: [TOKENS.WETH as `0x${string}`, TOKENS.USDG as `0x${string}`, fee],
      });
      if (isSameAddr(pool, ZERO_ADDR)) continue;
      const liq = await client.readContract({ address: pool, abi: v3PoolAbi, functionName: 'liquidity' });
      if (liq === 0n) continue;
      const slot0 = await client.readContract({ address: pool, abi: v3PoolAbi, functionName: 'slot0' });
      const sp = sqrtPriceX96ToSqrtPrice(slot0[0]);
      const t0 = TOKENS.WETH.toLowerCase() < TOKENS.USDG.toLowerCase() ? TOKENS.WETH : TOKENS.USDG;
      const price = isSameAddr(t0, TOKENS.WETH) ? priceFromSqrt(sp, 18, 6) : 1 / priceFromSqrt(sp, 6, 18);
      if (price > 0 && Number.isFinite(price)) {
        ethCache = { price, ts: Date.now() };
        return price;
      }
    } catch { /* coba fee tier berikutnya */ }
  }
  try {
    const res = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/${TOKENS.WETH.toLowerCase()}`,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) },
    );
    if (res.ok) {
      const price = Number((await res.json())?.data?.attributes?.price_usd);
      if (price > 0) {
        ethCache = { price, ts: Date.now() };
        return price;
      }
    }
  } catch { /* pakai cache lama */ }
  return ethCache.price;
}

export function usdPerToken(args: {
  meta0: TokenMeta; meta1: TokenMeta; priceT1PerT0: number; eth: number | null;
}) {
  const anchor = (m: TokenMeta) => {
    if (isSameAddr(m.address, TOKENS.USDG)) return 1;
    if (m.native || isSameAddr(m.address, TOKENS.WETH)) return args.eth;
    return null;
  };
  let usd0 = anchor(args.meta0);
  let usd1 = anchor(args.meta1);
  if (usd0 == null && usd1 != null && args.priceT1PerT0 > 0) usd0 = args.priceT1PerT0 * usd1;
  if (usd1 == null && usd0 != null && args.priceT1PerT0 > 0) usd1 = usd0 / args.priceT1PerT0;
  return { usd0, usd1 };
}
