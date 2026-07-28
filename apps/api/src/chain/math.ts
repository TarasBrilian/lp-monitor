const Q96 = 2 ** 96;
const Q128 = 2n ** 128n;
const U256 = 2n ** 256n;

export const sqrtPriceX96ToSqrtPrice = (x: bigint) => Number(x) / Q96;
export const tickToSqrtPrice = (tick: number) => Math.pow(1.0001, tick / 2);

export const priceFromSqrt = (sqrtPrice: number, dec0: number, dec1: number) =>
  sqrtPrice * sqrtPrice * Math.pow(10, dec0 - dec1);

export const tickToPrice = (tick: number, dec0: number, dec1: number) =>
  Math.pow(1.0001, tick) * Math.pow(10, dec0 - dec1);

export function positionAmounts(args: {
  liquidity: bigint; tickLower: number; tickUpper: number; sqrtPriceX96: bigint; tick: number;
}) {
  const L = Number(args.liquidity);
  const sa = tickToSqrtPrice(args.tickLower);
  const su = tickToSqrtPrice(args.tickUpper);
  const sp = sqrtPriceX96ToSqrtPrice(args.sqrtPriceX96);
  let amount0 = 0;
  let amount1 = 0;
  if (args.tick < args.tickLower) amount0 = (L * (su - sa)) / (sa * su);
  else if (args.tick >= args.tickUpper) amount1 = L * (su - sa);
  else {
    amount0 = (L * (su - sp)) / (sp * su);
    amount1 = L * (sp - sa);
  }
  return { amount0, amount1 };
}

// Fee v4: selisih feeGrowthInside dengan wraparound uint256
export function feesFromGrowth(liquidity: bigint, growthNow: bigint, growthLast: bigint): number {
  const delta = (growthNow - growthLast + U256) % U256;
  return Number((liquidity * delta) / Q128);
}

export const toHuman = (raw: number, decimals: number) => raw / Math.pow(10, decimals);

export function unpackV4PositionInfo(info: bigint) {
  const signed24 = (v: bigint) => {
    const n = Number(v & 0xffffffn);
    return n & 0x800000 ? n - 0x1000000 : n;
  };
  return { tickLower: signed24(info >> 8n), tickUpper: signed24(info >> 32n) };
}
