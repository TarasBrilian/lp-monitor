export const CHAIN_ID = 4663;
export const CHAIN_NAME = 'Robinhood Chain';
export const DEFAULT_RPC = 'https://rpc.mainnet.chain.robinhood.com';
export const EXPLORER = 'https://robinhoodchain.blockscout.com';

export const CONTRACTS = {
  v3Factory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa',
  v3PositionManager: '0x73991a25c818bf1f1128deaab1492d45638de0d3',
  v4PositionManager: '0x58daec3116aae6d93017baaea7749052e8a04fa7',
  v4PoolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  v4StateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
} as const;

export const TOKENS = {
  USDG: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  WETH: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
} as const;

/** Nama schema Postgres untuk data aplikasi sebuah address */
export function tenantSchema(address: string): string {
  return `addr_${address.toLowerCase().replace(/^0x/, '')}`;
}
