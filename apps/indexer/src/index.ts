import { ponder } from 'ponder:registry';
import { pool, liquidityEvent, positionTransfer, v3PositionEvent } from 'ponder:schema';

ponder.on('PoolManager:Initialize', async ({ event, context }) => {
  await context.db.insert(pool).values({
    id: event.args.id,
    currency0: event.args.currency0,
    currency1: event.args.currency1,
    fee: event.args.fee,
    tickSpacing: event.args.tickSpacing,
    hooks: event.args.hooks,
    createdAt: event.block.timestamp,
  });
});

ponder.on('PoolManager:ModifyLiquidity', async ({ event, context }) => {
  await context.db.insert(liquidityEvent).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    poolId: event.args.id,
    sender: event.args.sender,
    tickLower: event.args.tickLower,
    tickUpper: event.args.tickUpper,
    liquidityDelta: event.args.liquidityDelta,
    salt: event.args.salt,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  });
});

ponder.on('PositionManagerV4:Transfer', async ({ event, context }) => {
  await context.db.insert(positionTransfer).values({
    id: `v4-${event.transaction.hash}-${event.log.logIndex}`,
    version: 'v4',
    tokenId: event.args.tokenId,
    from: event.args.from,
    to: event.args.to,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  });
});

ponder.on('NfpmV3:IncreaseLiquidity', async ({ event, context }) => {
  await context.db.insert(v3PositionEvent).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    tokenId: event.args.tokenId,
    kind: 'increase',
    liquidity: event.args.liquidity,
    amount0: event.args.amount0,
    amount1: event.args.amount1,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  });
});

ponder.on('NfpmV3:DecreaseLiquidity', async ({ event, context }) => {
  await context.db.insert(v3PositionEvent).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    tokenId: event.args.tokenId,
    kind: 'decrease',
    liquidity: event.args.liquidity,
    amount0: event.args.amount0,
    amount1: event.args.amount1,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  });
});

ponder.on('NfpmV3:Collect', async ({ event, context }) => {
  await context.db.insert(v3PositionEvent).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    tokenId: event.args.tokenId,
    kind: 'collect',
    liquidity: 0n,
    amount0: event.args.amount0,
    amount1: event.args.amount1,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  });
});

ponder.on('NfpmV3:Transfer', async ({ event, context }) => {
  await context.db.insert(positionTransfer).values({
    id: `v3-${event.transaction.hash}-${event.log.logIndex}`,
    version: 'v3',
    tokenId: event.args.tokenId,
    from: event.args.from,
    to: event.args.to,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  });
});
