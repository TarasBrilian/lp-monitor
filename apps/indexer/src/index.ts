import { ponder } from 'ponder:registry';
import { pool, liquidityEvent, positionTransfer } from 'ponder:schema';

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
