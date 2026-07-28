import { createConfig } from 'ponder';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC } from '@lpmon/shared';
import { poolManagerAbi, erc721TransferAbi, nfpmV3Abi } from './abis';

// CATATAN M2: RPC resmi rate-limited (429). startBlock disetel dekat supaya sync
// awal ringan; mundurkan bertahap (atau pakai RPC lebih longgar) untuk backfill penuh.
const START_BLOCK = Number(process.env.START_BLOCK ?? 21_000_000);

export default createConfig({
  chains: {
    robinhood: {
      id: CHAIN_ID,
      rpc: process.env.RPC_URL ?? DEFAULT_RPC,
    },
  },
  contracts: {
    PoolManager: {
      chain: 'robinhood',
      abi: poolManagerAbi,
      address: CONTRACTS.v4PoolManager as `0x${string}`,
      startBlock: START_BLOCK,
    },
    PositionManagerV4: {
      chain: 'robinhood',
      abi: erc721TransferAbi,
      address: CONTRACTS.v4PositionManager as `0x${string}`,
      startBlock: START_BLOCK,
    },
    NfpmV3: {
      chain: 'robinhood',
      abi: nfpmV3Abi,
      address: CONTRACTS.v3PositionManager as `0x${string}`,
      startBlock: START_BLOCK,
    },
  },
});
