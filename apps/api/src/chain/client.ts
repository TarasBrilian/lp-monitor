import { createPublicClient, http, defineChain } from 'viem';
import { CHAIN_ID, CHAIN_NAME, DEFAULT_RPC, EXPLORER } from '@lpmon/shared';

export const robinhoodChain = defineChain({
  id: CHAIN_ID,
  name: CHAIN_NAME,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL ?? DEFAULT_RPC] } },
  blockExplorers: { default: { name: 'Blockscout', url: EXPLORER } },
  contracts: {
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
  },
});

// batch.multicall menggabungkan readContract paralel jadi satu eth_call — wajib
// karena RPC resmi rate-limited (429)
export const client = createPublicClient({
  chain: robinhoodChain,
  batch: { multicall: { wait: 100 } },
  transport: http(process.env.RPC_URL ?? DEFAULT_RPC, {
    batch: { wait: 100 },
    retryCount: 3,
    retryDelay: 1500,
    timeout: 20_000,
  }),
});

export const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
export const isSameAddr = (a?: string, b?: string) => a?.toLowerCase() === b?.toLowerCase();
