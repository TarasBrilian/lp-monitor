import { onchainTable } from 'ponder';

export const pool = onchainTable('pool', (t) => ({
  id: t.hex().primaryKey(), // poolId v4
  currency0: t.hex().notNull(),
  currency1: t.hex().notNull(),
  fee: t.integer().notNull(),
  tickSpacing: t.integer().notNull(),
  hooks: t.hex().notNull(),
  createdAt: t.bigint().notNull(),
}));

export const liquidityEvent = onchainTable('liquidity_event', (t) => ({
  id: t.text().primaryKey(), // txHash-logIndex
  poolId: t.hex().notNull(),
  sender: t.hex().notNull(),
  tickLower: t.integer().notNull(),
  tickUpper: t.integer().notNull(),
  liquidityDelta: t.bigint().notNull(),
  salt: t.hex().notNull(), // = tokenId posisi v4
  blockNumber: t.bigint().notNull(),
  timestamp: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

// Event liquidity/fee NFPM v3 per tokenId. `kind`: increase | decrease | collect.
// collect membayar tokensOwed = pokok hasil decrease + fee — pemisahan fee
// dilakukan di API dengan mengurangkan pokok decrease yang belum terbayar.
export const v3PositionEvent = onchainTable('v3_position_event', (t) => ({
  id: t.text().primaryKey(), // txHash-logIndex
  tokenId: t.bigint().notNull(),
  kind: t.text().notNull(),
  liquidity: t.bigint().notNull(), // 0 untuk collect
  amount0: t.bigint().notNull(),
  amount1: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  timestamp: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

export const positionTransfer = onchainTable('position_transfer', (t) => ({
  id: t.text().primaryKey(), // version-txHash-logIndex
  version: t.text().notNull(), // 'v3' | 'v4'
  tokenId: t.bigint().notNull(),
  from: t.hex().notNull(),
  to: t.hex().notNull(),
  blockNumber: t.bigint().notNull(),
  timestamp: t.bigint().notNull(),
}));
