// Volume 24 jam + likuiditas pool dari GeckoTerminal (gratis, tanpa API key).
// v3 pakai alamat pool, v4 pakai pool id (bytes32) — dua-duanya didukung GT.
const cache = new Map<string, { ts: number; data: PoolStats | null }>();

export type PoolStats = {
  volume24hUsd: number;
  reserveUsd: number | null;
  priceChange24hPct: number | null;
};

export async function poolStats(poolIdOrAddress: string): Promise<PoolStats | null> {
  const key = poolIdOrAddress.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < 300_000) return hit.data;
  try {
    const res = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/robinhood/pools/${key}`,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) throw new Error(`geckoterminal ${res.status}`);
    const attrs = ((await res.json()) as any)?.data?.attributes ?? {};
    const data: PoolStats = {
      volume24hUsd: Number(attrs?.volume_usd?.h24) || 0,
      reserveUsd: Number(attrs?.reserve_in_usd) || null,
      priceChange24hPct: Number(attrs?.price_change_percentage?.h24) || null,
    };
    cache.set(key, { ts: Date.now(), data });
    return data;
  } catch {
    return cache.get(key)?.data ?? null;
  }
}
