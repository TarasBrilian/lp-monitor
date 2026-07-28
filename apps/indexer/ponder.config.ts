import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createConfig } from 'ponder';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC } from '@lpmon/shared';
import { poolManagerAbi, erc721TransferAbi, nfpmV3Abi } from './abis';

// Muat .env root monorepo (Ponder sendiri hanya membaca .env.local)
const ROOT_ENV = join(dirname(fileURLToPath(import.meta.url)), '../../.env');
try {
  if (existsSync(ROOT_ENV)) process.loadEnvFile(ROOT_ENV);
} catch { /* opsional */ }

// CATATAN M2: RPC resmi rate-limited (429) — Ponder menyesuaikan laju otomatis.
// startBlock 16 juta ≈ pertengahan Juli 2026, mencakup seluruh era LP user awal.
const START_BLOCK = Number(process.env.START_BLOCK ?? 16_000_000);

export default createConfig({
  database: {
    kind: 'postgres',
    connectionString: process.env.DATABASE_URL ?? 'postgres://lpmon:lpmon-dev@127.0.0.1:5433/lpmon',
  },
  chains: {
    robinhood: {
      id: CHAIN_ID,
      rpc: process.env.RPC_URL ?? DEFAULT_RPC,
      pollingInterval: 2_000,
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
