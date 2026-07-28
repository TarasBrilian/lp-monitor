import { client, ZERO_ADDR, isSameAddr } from './client.js';
import { erc20Abi } from './abi.js';

export type TokenMeta = { address: string; symbol: string; decimals: number; native: boolean };

const cache = new Map<string, TokenMeta>();

export async function tokenMeta(address: string): Promise<TokenMeta> {
  if (isSameAddr(address, ZERO_ADDR)) {
    return { address: ZERO_ADDR, symbol: 'ETH', decimals: 18, native: true };
  }
  const key = address.toLowerCase();
  const hit = cache.get(key);
  if (hit) return hit;
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: address as `0x${string}`, abi: erc20Abi, functionName: 'symbol' }).catch(() => '???'),
    client.readContract({ address: address as `0x${string}`, abi: erc20Abi, functionName: 'decimals' }).catch(() => 18),
  ]);
  const meta = { address: key, symbol, decimals: Number(decimals), native: false };
  cache.set(key, meta);
  return meta;
}
