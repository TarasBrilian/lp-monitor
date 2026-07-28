import { keccak256, encodeAbiParameters, toHex, pad, maxUint128 } from 'viem';
import { CONTRACTS, TOKENS } from '@lpmon/shared';
import { client, isSameAddr } from './client.js';
import { v3PositionManagerAbi, v3FactoryAbi, v3PoolAbi, v4PositionManagerAbi, v4StateViewAbi, POOL_KEY_ABI } from './abi.js';
import { tokenMeta, type TokenMeta } from './tokens.js';
import { positionAmounts, priceFromSqrt, tickToPrice, sqrtPriceX96ToSqrtPrice, toHuman, unpackV4PositionInfo, feesFromGrowth } from './math.js';
import { usdPerToken } from './prices.js';

const POSM = CONTRACTS.v4PositionManager as `0x${string}`;
const STATE_VIEW = CONTRACTS.v4StateView as `0x${string}`;
const NFPM = CONTRACTS.v3PositionManager as `0x${string}`;

export type RawPosition = {
  key: string; version: 'v3' | 'v4'; tokenId: string; pool: string; feeTier: number;
  meta0: TokenMeta; meta1: TokenMeta;
  tick: number; tickLower: number; tickUpper: number;
  price: number; priceLower: number; priceUpper: number;
  liquidity: string; amt0: number; amt1: number; fees0: number; fees1: number;
  usd0: number | null; usd1: number | null;
};

export async function v4Liquidity(tokenId: bigint): Promise<bigint> {
  return client.readContract({
    address: POSM, abi: v4PositionManagerAbi, functionName: 'getPositionLiquidity', args: [tokenId],
  });
}

export async function readV4Position(tokenId: bigint, eth: number | null): Promise<RawPosition> {
  const [[poolKey, packedInfo], liquidity] = await Promise.all([
    client.readContract({ address: POSM, abi: v4PositionManagerAbi, functionName: 'getPoolAndPositionInfo', args: [tokenId] }),
    v4Liquidity(tokenId),
  ]);
  const { tickLower, tickUpper } = unpackV4PositionInfo(packedInfo);
  const poolId = keccak256(encodeAbiParameters(POOL_KEY_ABI, [poolKey]));
  const [meta0, meta1, slot0] = await Promise.all([
    tokenMeta(poolKey.currency0),
    tokenMeta(poolKey.currency1),
    client.readContract({ address: STATE_VIEW, abi: v4StateViewAbi, functionName: 'getSlot0', args: [poolId] }),
  ]);
  const [sqrtPriceX96, tick] = slot0;

  let fees0 = 0, fees1 = 0;
  try {
    const salt = pad(toHex(tokenId), { size: 32 });
    const [growthNow, posInfo] = await Promise.all([
      client.readContract({ address: STATE_VIEW, abi: v4StateViewAbi, functionName: 'getFeeGrowthInside', args: [poolId, tickLower, tickUpper] }),
      client.readContract({ address: STATE_VIEW, abi: v4StateViewAbi, functionName: 'getPositionInfo', args: [poolId, POSM, tickLower, tickUpper, salt] }),
    ]);
    const [liqInPool, last0, last1] = posInfo;
    fees0 = toHuman(feesFromGrowth(liqInPool, growthNow[0], last0), meta0.decimals);
    fees1 = toHuman(feesFromGrowth(liqInPool, growthNow[1], last1), meta1.decimals);
  } catch { /* pool tanpa posisi aktif */ }

  const { amount0, amount1 } = positionAmounts({ liquidity, tickLower, tickUpper, sqrtPriceX96, tick: Number(tick) });
  const price = priceFromSqrt(sqrtPriceX96ToSqrtPrice(sqrtPriceX96), meta0.decimals, meta1.decimals);
  const { usd0, usd1 } = usdPerToken({ meta0, meta1, priceT1PerT0: price, eth });

  return {
    key: `v4-${tokenId}`, version: 'v4', tokenId: tokenId.toString(), pool: poolId,
    feeTier: Number(poolKey.fee), meta0, meta1,
    tick: Number(tick), tickLower, tickUpper,
    price,
    priceLower: tickToPrice(tickLower, meta0.decimals, meta1.decimals),
    priceUpper: tickToPrice(tickUpper, meta0.decimals, meta1.decimals),
    liquidity: liquidity.toString(),
    amt0: toHuman(amount0, meta0.decimals), amt1: toHuman(amount1, meta1.decimals),
    fees0, fees1, usd0, usd1,
  };
}

export async function readV3Position(tokenId: bigint, owner: `0x${string}`, eth: number | null): Promise<RawPosition> {
  const pos = await client.readContract({ address: NFPM, abi: v3PositionManagerAbi, functionName: 'positions', args: [tokenId] });
  const [, , token0, token1, fee, tickLower, tickUpper, liquidity] = pos;
  const [meta0, meta1, poolAddr] = await Promise.all([
    tokenMeta(token0), tokenMeta(token1),
    client.readContract({ address: CONTRACTS.v3Factory as `0x${string}`, abi: v3FactoryAbi, functionName: 'getPool', args: [token0, token1, fee] }),
  ]);
  const slot0 = await client.readContract({ address: poolAddr, abi: v3PoolAbi, functionName: 'slot0' });
  const [sqrtPriceX96, tick] = slot0;

  let fees0 = 0, fees1 = 0;
  try {
    const { result } = await client.simulateContract({
      address: NFPM, abi: v3PositionManagerAbi, functionName: 'collect',
      args: [{ tokenId, recipient: owner, amount0Max: maxUint128, amount1Max: maxUint128 }],
      account: owner,
    });
    fees0 = toHuman(Number(result[0]), meta0.decimals);
    fees1 = toHuman(Number(result[1]), meta1.decimals);
  } catch { /* tanpa fee */ }

  const { amount0, amount1 } = positionAmounts({
    liquidity, tickLower: Number(tickLower), tickUpper: Number(tickUpper), sqrtPriceX96, tick: Number(tick),
  });
  const price = priceFromSqrt(sqrtPriceX96ToSqrtPrice(sqrtPriceX96), meta0.decimals, meta1.decimals);
  const { usd0, usd1 } = usdPerToken({ meta0, meta1, priceT1PerT0: price, eth });

  return {
    key: `v3-${tokenId}`, version: 'v3', tokenId: tokenId.toString(), pool: poolAddr.toLowerCase(),
    feeTier: Number(fee), meta0, meta1,
    tick: Number(tick), tickLower: Number(tickLower), tickUpper: Number(tickUpper),
    price,
    priceLower: tickToPrice(Number(tickLower), meta0.decimals, meta1.decimals),
    priceUpper: tickToPrice(Number(tickUpper), meta0.decimals, meta1.decimals),
    liquidity: liquidity.toString(),
    amt0: toHuman(amount0, meta0.decimals), amt1: toHuman(amount1, meta1.decimals),
    fees0, fees1, usd0, usd1,
  };
}

// Normalisasi tampilan: harga selalu "micin per quote" apa pun urutan token0/token1
export function displayFields(pos: RawPosition) {
  const isAnchor = (m: TokenMeta) =>
    m.native || isSameAddr(m.address, TOKENS.USDG) || isSameAddr(m.address, TOKENS.WETH);
  const anchor0 = isAnchor(pos.meta0);
  const anchor1 = isAnchor(pos.meta1);
  let flip = false;
  if (anchor0 && anchor1) flip = isSameAddr(pos.meta0.address, TOKENS.USDG);
  else if (anchor0) flip = true;

  const disp = flip
    ? {
        price: pos.price > 0 ? 1 / pos.price : 0,
        lower: pos.priceUpper > 0 ? 1 / pos.priceUpper : 0,
        upper: pos.priceLower > 0 ? 1 / pos.priceLower : 0,
        base: pos.meta1.symbol, quote: pos.meta0.symbol,
        baseAmt: pos.amt1, quoteAmt: pos.amt0,
        baseUsd: pos.usd1, quoteUsd: pos.usd0,
        baseFees: pos.fees1, quoteFees: pos.fees0,
      }
    : {
        price: pos.price, lower: pos.priceLower, upper: pos.priceUpper,
        base: pos.meta0.symbol, quote: pos.meta1.symbol,
        baseAmt: pos.amt0, quoteAmt: pos.amt1,
        baseUsd: pos.usd0, quoteUsd: pos.usd1,
        baseFees: pos.fees0, quoteFees: pos.fees1,
      };

  const inRange = pos.tick >= pos.tickLower && pos.tick < pos.tickUpper;
  const outSide = inRange ? null : (pos.tick < pos.tickLower) !== flip ? 'below' : 'above';
  return { disp, inRange, outSide, quoteIsAnchor: flip ? anchor0 : anchor1 };
}
