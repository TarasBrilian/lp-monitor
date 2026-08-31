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
| Deploy | Frontend: Vercel (proxy /api → VPS). Backend: VPS (pm2: API via Bun, indexer via Node 22, Postgres native). Dev lokal: Postgres di Docker |
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
sudah membuktikan ROI). Sejak 31 Ags 2026 indexer kembali memakai RPC publik
ini; `PONDER_RPC_URL` di `.env` produksi dinonaktifkan (saldo dRPC habis) dan
tinggal diaktifkan lagi setelah top up.

Blockscout (`api/v2/*`) berada di belakang Cloudflare: WAJIB lewat
`apps/api/src/chain/blockscout.ts` yang memasang User-Agent browser.

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

3. **M3 — Paritas v1** ✅ SELESAI
   Nilai posisi + fee real-time (v3/v4), saldo wallet (+ deteksi token palsu),
   modal awal akurat (rekonstruksi dari tx pembukaan, dinilai pada harga blok
   kejadian, self-healing), P&L per posisi + total, jurnal otomatis saat
   posisi ditutup (schema address), volume pool 24 jam + baseline entry,
   koreksi manual modal awal (klik di kartu posisi), tab History lengkap
   (statistik win rate / rata-rata fee / rata-rata rugi / durasi + pagination
   10/halaman), riwayat v1 terimpor via `apps/api/scripts/import-v1.ts`,
   UI paritas v1 penuh.

4. **M4 — Alert** ⬜ BELUM MULAI
   Rule engine server-side (near-lower, tembus bawah, di atas range, P&L flip,
   volume kering/spike) + Web Push per user.

5. **M5 — Deploy** 🔶 SEBAGIAN (28 Jul 2026)
   Live: frontend di Vercel (https://lp-monitor-five.vercel.app, rewrite
   /api/* → VPS), backend di VPS 103.127.134.131 (API port 8790 via Bun+pm2,
   indexer Ponder port 42070 via Node 22/nvm+pm2, Postgres native lokal,
   pm2 startup systemd). Data journal termigrasi (pg_dump schema addr_*).
   Belum: HTTPS/domain untuk jalur API, hardening akses server & database,
   rate limit API.

   **Insiden 31 Ags 2026 — dua kegagalan yang menumpuk:**
   1. Blockscout dipasangi proteksi bot Cloudflare; `fetch()` tanpa
      User-Agent browser dibalas 403 (`cf-mitigated: challenge`, bukan 429 —
      retry tidak menolong). Discovery posisi sengaja melempar error alih-alih
      mengembalikan daftar kosong, sehingga muncul sebagai HTTP 500 di UI.
      Diperbaiki: semua panggilan Blockscout lewat `chain/blockscout.ts`.
      UA parsial tidak lolos — harus string browser utuh.
   2. `PONDER_RPC_URL` (dRPC berbayar) kehabisan saldo → indexer crash-loop
      3.878 kali sejak 30 Jul, indeks basi 28 jt blok. Ditangani dengan
      kembali ke RPC publik + START_BLOCK dinaikkan ke **50.963.120** dan
      schema `ponder` di-drop (Ponder menolak memakai ulang schema milik build
      lain: `MigrationError: Schema "ponder" was previously used by a different
      Ponder app`). Konsekuensi: riwayat indeks di bawah 50,96 jt hilang;
      jurnal di schema `addr_*` tidak terpengaruh. Posisi lama tetap bisa
      direkonstruksi karena `saltEvents` punya fallback `getLogs` 600 rb blok.
      Backup sebelum drop: `~/lpmon-backup/` di VPS (ponder 142 MB gz +
      tenants 38 KB), salinan tenant juga di `.backup-prod/` lokal.

      **Percobaan pertama gagal dan ini penting untuk diketahui:** START_BLOCK
      sempat diset 50.750.000 (200 rb blok backfill). Diukur dari
      `ponder._ponder_checkpoint`, indexer hanya maju **18 detik waktu chain
      per 55 detik waktu nyata** (±3,2 blok/dtk, sementara chain menghasilkan
      ±10 blok/dtk) — makin tertinggal, bukan mengejar. Di RPC publik, backfill
      apa pun yang berarti tidak akan pernah selesai.

      **Keadaan sekarang belum stabil.** Setelah START_BLOCK didekatkan ke
      ujung chain, ketertinggalan turun dari 5,81 jam ke 3,5 menit
      (`indexFresh` sempat true), tapi terus melebar: 213s → 285s → 319s dalam
      pemantauan singkat. Diperkirakan menembus ambang 5.000 blok lagi.
      Kesimpulan terukur: RPC publik tidak sanggup menahan indexer di ujung
      chain. Jalan keluar: isi ulang dRPC (aktifkan lagi `PONDER_RPC_URL`),
      atau setel `maxRequestsPerSecond`/`ethGetLogsBlockRange` Ponder supaya
      tidak boros retry akibat 429.

   Pelajaran operasional: sumber data eksternal gratis bisa berubah kebijakan
   tanpa peringatan, dan RPC berbayar bisa habis diam-diam. Keduanya hanya
   terlihat lewat `pm2 list` (restart count) dan log — belum ada alerting.

## Konvensi

- Bahasa UI: Indonesia. P&L = (nilai sekarang + semua fee) − modal awal.
- Normalisasi tampilan selalu micin/quote (lihat displayFields v1 — port logikanya).
- Semua nilai uang USD float; jumlah token disimpan raw string + decimals.
