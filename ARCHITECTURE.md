# LP Monitor v2 — Arsitektur

Monitoring posisi LP Uniswap v3/v4 di Robinhood Chain (chain id 4663), multi-user.
Penerus `lp-monitor` v1 (v1 tetap jalan sampai v2 mencapai paritas fitur).

## Keputusan terkunci (28 Jul 2026)

| Area | Keputusan |
|---|---|
| Target user | Multi-user dari awal |
| Auth | Sign-In with Ethereum (SIWE / EIP-4361) — wallet = identitas |
| Scope pantau | User hanya memantau address yang dibuktikan miliknya via tanda tangan |
| Backend | NestJS dijalankan dengan Bun (`bun run src/main.ts`, tanpa build step) |
| Frontend | Vite + React + wagmi/viem, package manager pnpm |
| Indexer | Ponder — mengindeks PoolManager v4 + PositionManager v3/v4 |
| Database | PostgreSQL. Data indeks on-chain: schema `ponder` (satu untuk semua). Data aplikasi: **satu schema per address** (`addr_<address>`): jurnal, alert, setting, baseline |
| Alert | Notifikasi browser (Web Push + service worker, VAPID) |
| Deploy | Docker Compose — portabel ke VPS mana pun. Dev: hanya Postgres di Docker |
| Biaya infra | $0 di luar VPS: RPC publik resmi, tanpa API berbayar |

## Struktur monorepo

```
lp-monitor-v2/
├── apps/
│   ├── api/        NestJS (Bun) — auth SIWE, tenant provisioning, REST + SSE
│   ├── web/        Vite + React — dashboard
│   └── indexer/    Ponder — event on-chain → Postgres schema `ponder`
├── packages/
│   └── shared/     alamat kontrak, konstanta chain, tipe bersama
├── docker-compose.yml   dev: postgres. prod: + api, web, indexer
└── .env             DATABASE_URL, RPC, VAPID keys, JWT secret
```

## Aliran data

```
Robinhood Chain ── Ponder ──> Postgres(schema ponder)
                                   │  (liquidity events, transfers, swaps, pools)
       user ── SIWE ──> API ───────┤
                        │          └─> query posisi & riwayat per address
                        └──> Postgres(schema addr_xxx): jurnal, alert config, baseline
       web (React) <── REST + SSE ── API ──> Web Push (alert)
```

## Kenapa schema per address (bukan database per address)

Ponder bersifat chain-scoped: satu pipeline indexing untuk semua wallet — memaksa
database per address berarti menduplikasi indeks atau join lintas-database. Schema
per address memberi isolasi jelas untuk data aplikasi, dengan satu server Postgres,
satu pool koneksi, dan migrasi yang masih terkelola (loop semua schema `addr_%`).

## Kontrak yang diindeks (Robinhood Chain, 4663)

| Kontrak | Alamat | Event |
|---|---|---|
| v4 PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` | Initialize, ModifyLiquidity, Swap |
| v4 PositionManager | `0x58daec3116aae6d93017baaea7749052e8a04fa7` | Transfer (ERC-721) |
| v3 NFPM | `0x73991a25c818bf1f1128deaab1492d45638de0d3` | Transfer, IncreaseLiquidity, DecreaseLiquidity, Collect |

RPC: `https://rpc.mainnet.chain.robinhood.com` (rate-limited 429 — Ponder perlu
konfigurasi polling konservatif; pertimbangkan RPC berbayar HANYA jika fee LP
sudah membuktikan ROI).

Token anchor: USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6 des),
WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`.

## Milestone

Status per 28 Jul 2026:

1. **M1 — Fondasi** ✅ SELESAI (teruji E2E)
   Scaffold monorepo, compose postgres, auth SIWE + tenant provisioning
   (schema per address otomatis saat login), web connect wallet + sign-in.

2. **M2 — Indexer** ✅ SELESAI (dengan catatan)
   Ponder 0.17 sync event v4/v3 ke schema `ponder`; API discovery posisi dari
   indeks dengan fallback otomatis ke Blockscout selama indeks tertinggal.
   *Catatan: backfill dangkal (START_BLOCK 21,3 jt) karena RPC publik
   rate-limited — laju sync hanya setara laju chain. Backfill dalam (era
   posisi lama) menunggu RPC lebih longgar di VPS; tinggal ubah START_BLOCK.*

3. **M3 — Paritas v1** 🔶 SEBAGIAN BESAR SELESAI
   Sudah: nilai posisi + fee real-time (v3/v4), saldo wallet (+ deteksi token
   palsu), modal awal akurat (rekonstruksi dari tx pembukaan, dinilai pada
   harga blok kejadian, self-healing), P&L per posisi + total, jurnal otomatis
   saat posisi ditutup (schema address), tab History dari jurnal, UI paritas
   v1 (tiles, kartu posisi, range bar log, pill status).
   Belum: volume pool 24 jam + baseline entry, statistik History (win rate,
   rata-rata fee/rugi) + pagination 10/halaman, koreksi manual modal awal,
   rekonstruksi riwayat lama pra-indeks (40 posisi lama user pertama — sudah
   ada di data v1).

4. **M4 — Alert** ⬜ BELUM MULAI
   Rule engine server-side (near-lower, tembus bawah, di atas range, P&L flip,
   volume kering/spike) + Web Push per user.

5. **M5 — Deploy** ⬜ BELUM MULAI
   Compose produksi (api+web+indexer+postgres), panduan VPS, hardening
   (basic auth/rate limit API), lalu pensiunkan v1.

## Konvensi

- Bahasa UI: Indonesia. P&L = (nilai sekarang + semua fee) − modal awal.
- Normalisasi tampilan selalu micin/quote (lihat displayFields v1 — port logikanya).
- Semua nilai uang USD float; jumlah token disimpan raw string + decimals.
