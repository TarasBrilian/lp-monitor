import { useEffect, useState } from 'react';
import { createWalletClient, custom, getAddress } from 'viem';

declare global {
  interface Window { ethereum?: any }
}

type Session = { token: string; address: string; schema: string };

const api = (path: string, init?: RequestInit) => fetch(`/api${path}`, init);
const EXPLORER = 'https://robinhoodchain.blockscout.com';

// ---------- format (identik dengan v1) ----------
function fmtUsd(v: number | null | undefined, sign = false) {
  if (v == null || !Number.isFinite(v)) return '—';
  const s = sign && v > 0 ? '+' : v < 0 ? '-' : '';
  const abs = Math.abs(v);
  const d = abs > 0 && abs < 1 ? 4 : 2;
  return `${s}$${abs.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

function fmtPrice(p: number) {
  if (!(p > 0) || !Number.isFinite(p)) return '—';
  if (p >= 1e30) return '∞';
  if (p < 1e-30) return '≈0';
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (p >= 0.0001) return Number(p.toPrecision(5)).toString();
  const e = Math.floor(Math.log10(p));
  const digits = Math.round(p * Math.pow(10, -e + 3)).toString().slice(0, 4);
  return `0.0{${-e - 1}}${digits}`;
}

function fmtDur(ms: number | null | undefined) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}j ${m % 60}m`;
  return `${Math.floor(h / 24)}h ${h % 24}j`;
}

const fmtWhen = (ts: number | string) => new Date(ts).toLocaleString('id-ID', {
  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
});

function fmtAmt(v: number) {
  if (!Number.isFinite(v)) return '—';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  if (v >= 1) return v.toFixed(2);
  return v > 0 ? Number(v.toPrecision(4)).toString() : '0';
}

// ---------- app ----------
export function App() {
  const [session, setSession] = useState<Session | null>(() => {
    // sesi via hash (untuk debugging): #token=...&address=...
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get('token') && h.get('address')) {
      const s = { token: h.get('token')!, address: h.get('address')!, schema: '' };
      localStorage.setItem('lpmon-session', JSON.stringify(s));
      history.replaceState(null, '', location.pathname + location.search);
      return s;
    }
    const raw = localStorage.getItem('lpmon-session');
    return raw ? JSON.parse(raw) : null;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function login() {
    setBusy(true);
    setError(null);
    try {
      if (!window.ethereum) throw new Error('Wallet tidak terdeteksi — pasang MetaMask/Rabby dulu');
      const wallet = createWalletClient({ transport: custom(window.ethereum) });
      const [addr] = await wallet.requestAddresses();
      const address = getAddress(addr);
      const { nonce } = await (await api('/auth/nonce')).json();
      const { message } = await (await api('/auth/message', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address, nonce }),
      })).json();
      const signature = await wallet.signMessage({ account: address, message });
      const res = await api('/auth/verify', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address, nonce, signature }),
      });
      if (!res.ok) throw new Error((await res.json()).message ?? 'Verifikasi gagal');
      const s: Session = await res.json();
      localStorage.setItem('lpmon-session', JSON.stringify(s));
      setSession(s);
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  function logout() {
    localStorage.removeItem('lpmon-session');
    setSession(null);
  }

  return (
    <>
      <header className="topbar">
        <div>
          <h1>💧 LP Monitor <span className="v2">v2</span></h1>
          <div className="sub">Robinhood Chain · Uniswap v3 &amp; v4 · multi-user</div>
        </div>
        {session && (
          <div className="topbar-right">
            <span className="chip">{session.address.slice(0, 6)}…{session.address.slice(-4)}</span>
            <button className="ghost" onClick={logout}>Keluar</button>
          </div>
        )}
      </header>
      <main>
        {!session ? (
          <section className="card setup">
            <h2>Masuk dengan wallet</h2>
            <p>Tanda tangani satu pesan untuk membuktikan kepemilikan address-mu. Tanpa transaksi, tanpa gas, tanpa akses dana.</p>
            <button onClick={login} disabled={busy}>{busy ? 'Menunggu tanda tangan…' : 'Connect wallet & Sign-In'}</button>
            {error && <p className="error">{error}</p>}
          </section>
        ) : (
          <Dashboard session={session} onAuthFail={logout} />
        )}
      </main>
      <footer>
        Data: indeks Ponder + RPC resmi Robinhood Chain + Blockscout + GeckoTerminal (semua gratis).
        P&amp;L = (nilai sekarang + semua fee) − modal awal.
      </footer>
    </>
  );
}

function useAuthed(path: string, token: string, refreshMs: number, onAuthFail: () => void, reloadKey = 0) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    const load = () =>
      api(path, { headers: { authorization: `Bearer ${token}` } })
        .then(async (r) => {
          if (r.status === 401) return onAuthFail();
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          if (!stop) { setData(await r.json()); setErr(null); }
        })
        .catch((e) => !stop && setErr(e.message));
    load();
    const t = setInterval(load, refreshMs);
    return () => { stop = true; clearInterval(t); };
  }, [path, token, reloadKey]);
  return { data, err };
}

function Dashboard({ session, onAuthFail }: { session: Session; onAuthFail: () => void }) {
  const [reloadKey, setReloadKey] = useState(0);
  const { data: pos, err: posErr } = useAuthed('/positions', session.token, 60_000, onAuthFail, reloadKey);
  const { data: bal } = useAuthed('/balances', session.token, 120_000, onAuthFail);
  const [tab, setTab] = useState<'saldo' | 'history'>(
    () => (new URLSearchParams(location.search).get('tab') === 'history' ? 'history' : 'saldo'),
  );

  async function editInitial(key: string) {
    const usd = prompt('Koreksi modal awal posisi ini (USD):');
    if (!usd) return;
    const res = await api(`/positions/${key}/initial`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ usd: Number(usd) }),
    });
    if (res.ok) setReloadKey((k) => k + 1);
    else alert((await res.json()).message ?? 'Gagal menyimpan');
  }

  const totalAset = (bal?.totalUsd ?? 0) + (pos?.totalValueUsd ?? 0) + (pos?.totalFeesUsd ?? 0);

  return (
    <>
      <section className="tiles">
        <div className="tile"><div className="label">Total aset</div>
          <div className="value">{fmtUsd(totalAset)}</div>
          <div className="hint">saldo wallet + posisi LP + fee</div></div>
        <div className="tile"><div className="label">Saldo wallet</div>
          <div className="value">{fmtUsd(bal?.totalUsd)}</div>
          <div className="hint">di luar posisi LP</div></div>
        <div className="tile"><div className="label">Nilai posisi LP</div>
          <div className="value">{fmtUsd(pos?.totalValueUsd)}</div></div>
        <div className="tile"><div className="label">Total fee</div>
          <div className="value">{fmtUsd(pos?.totalFeesUsd)}</div>
          <div className="hint">belum + sudah diklaim</div></div>
        <div className="tile"><div className="label">Total P&amp;L</div>
          <div className={`value ${(pos?.totalPnlUsd ?? 0) >= 0 ? 'pos-t' : 'neg-t'}`}>
            {pos?.totalPnlUsd === 0 ? '±$0.00' : fmtUsd(pos?.totalPnlUsd, true)}
          </div>
          <div className="hint">vs modal awal semua posisi</div></div>
        <div className="tile"><div className="label">Posisi aktif</div>
          <div className="value">{pos?.positions?.length ?? '…'}</div>
          <div className="hint">deteksi: {pos?.discovery ?? '…'} · ETH {fmtUsd(pos?.ethUsd)}</div></div>
      </section>

      <div className="tabs">
        <button className={`tab ${tab === 'saldo' ? 'active' : ''}`} onClick={() => setTab('saldo')}>Saldo wallet</button>
        <button className={`tab ${tab === 'history' ? 'active' : ''}`} onClick={() => setTab('history')}>History</button>
      </div>
      {tab === 'saldo' ? <Balances bal={bal} /> : <History session={session} onAuthFail={onAuthFail} />}

      <h2>Posisi aktif</h2>
      {posErr && <p className="error">Gagal memuat posisi: {posErr} — dicoba lagi otomatis.</p>}
      {!pos && !posErr && <p className="muted">Memuat posisi… (bisa ~1 menit saat indeks masih mengejar)</p>}
      {pos?.positions?.length === 0 && (
        <p className="muted">Tidak ada posisi LP aktif. Buka posisi di Uniswap, muncul otomatis maksimal 1 menit.</p>
      )}
      {pos?.positions?.map((p: any) => <PositionCard key={p.key} p={p} onEditInitial={editInitial} />)}
    </>
  );
}

function PositionCard({ p, onEditInitial }: { p: any; onEditInitial: (key: string) => void }) {
  const d = p.disp;
  const logPct = (() => {
    if (!(d.upper > d.lower) || !(d.price > 0) || !(d.lower > 0)) return null;
    const lo = Math.log(d.lower), hi = Math.log(d.upper);
    return Math.max(0, Math.min(1, (Math.log(d.price) - lo) / (hi - lo))) * 100;
  })();
  const distNote = p.inRange
    ? <>jarak ke batas bawah: <b>{(((d.price - d.lower) / d.price) * 100).toFixed(1)}%</b></>
    : p.outSide === 'below'
      ? <>harga <b>{(((d.lower - d.price) / d.lower) * 100).toFixed(1)}% di bawah</b> batas range</>
      : <>harga <b>{(((d.price - d.upper) / d.upper) * 100).toFixed(1)}% di atas</b> batas range</>;

  return (
    <article className="card position">
      <div className="pos-head">
        <span className="pair">{p.pair}</span>
        <span className="badge">{p.version}</span>
        <span className="badge">fee {(p.feeTier / 10000).toLocaleString('en-US', { maximumFractionDigits: 2 })}%</span>
        {p.inRange
          ? <span className="status in">● DALAM RANGE</span>
          : p.outSide === 'below'
            ? <span className="status out-below">✕ TEMBUS BAWAH — 100% {d.base}</span>
            : <span className="status out-above">▲ DI ATAS RANGE — 100% {d.quote}</span>}
      </div>

      {logPct != null && (
        <div className="range">
          <div className="range-bar">
            <div className="range-fill" />
            <div className={`range-marker ${p.inRange ? '' : 'out'}`} style={{ left: `${logPct}%` }} />
          </div>
          <div className="range-labels">
            <span>min {fmtPrice(d.lower)}</span>
            <span className="cur">{fmtPrice(d.price)} {d.quote}</span>
            <span>max {fmtPrice(d.upper)}</span>
          </div>
          <div className="range-note">{distNote}</div>
        </div>
      )}

      <div className="pos-grid">
        <div><div className="label">{d.base}</div>
          <div className="val">{fmtAmt(d.baseAmt)} <span className="sub">≈ {fmtUsd(d.baseAmt * (d.baseUsd ?? 0))}</span></div></div>
        <div><div className="label">{d.quote}</div>
          <div className="val">{fmtAmt(d.quoteAmt)} <span className="sub">≈ {fmtUsd(d.quoteAmt * (d.quoteUsd ?? 0))}</span></div></div>
        <div><div className="label">Fee belum diklaim</div>
          <div className="val">{fmtUsd(p.feesUsd)}</div>
          <div className="sub">{fmtAmt(d.baseFees)} {d.base} + {fmtAmt(d.quoteFees)} {d.quote}</div></div>
        <div><div className="label">Fee sudah diklaim</div>
          <div className={`val ${(p.collectedFeesUsd ?? 0) > 0 ? 'pos-t' : ''}`}>
            {(p.collectedFeesUsd ?? 0) > 0 ? fmtUsd(p.collectedFeesUsd) : '$—'}</div>
          <div className="sub">dari tx klaim on-chain</div></div>
        <div><div className="label">Umur posisi</div><div className="val">{fmtDur(p.ageMs)}</div></div>
        <div><div className="label">Volume 24 jam pool</div>
          <div className="val">{p.vol24 != null ? `$${fmtAmt(p.vol24)}` : '—'}</div>
          {p.baselineVol24 != null && p.vol24 != null && (
            <div className="sub">{((p.vol24 / p.baselineVol24 - 1) * 100).toFixed(0)}% vs entry</div>
          )}</div>
        <div><div className="label">Modal awal</div>
          <div className="val editable" title="Klik untuk koreksi manual" onClick={() => onEditInitial(p.key)}>{fmtUsd(p.initialUsd)}</div>
          <div className="sub">{p.initialSource === 'index' ? 'dari on-chain' : p.initialSource === 'index-estimasi' ? 'on-chain (estimasi)' : p.initialSource === 'manual' ? 'manual' : 'sejak terpantau'}</div></div>
        <div><div className="label">Nilai posisi</div><div className="val">{fmtUsd(p.valueUsd)}</div></div>
      </div>

      {p.pnlUsd != null && (
        <div className="pnl-line">
          Modal {fmtUsd(p.initialUsd)} → nilai {fmtUsd(p.valueUsd)}
          {' '}(<span className={p.valueUsd - p.initialUsd >= 0 ? 'pos-t' : 'neg-t'}>{fmtUsd(p.valueUsd - p.initialUsd, true)}</span>)
          {' '}+ fee {fmtUsd(p.feesUsd + (p.collectedFeesUsd ?? 0))} ⇒{' '}
          <b className={p.pnlUsd >= 0 ? 'pos-t' : 'neg-t'}>
            P&amp;L {fmtUsd(p.pnlUsd, true)}{p.pnlPct != null ? ` (${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct.toFixed(1)}%)` : ''}
          </b>
        </div>
      )}

      <div className="pos-links">
        <a href={`https://www.geckoterminal.com/robinhood/pools/${p.pool}`} target="_blank" rel="noopener">GeckoTerminal ↗</a>
        {p.version === 'v3' && <a href={`${EXPLORER}/address/${p.pool}`} target="_blank" rel="noopener">Pool di explorer ↗</a>}
      </div>
    </article>
  );
}

const HISTORY_PER_PAGE = 10;

// ISO 8601 dengan offset zona waktu lokal, mis. 2026-07-28T15:14:16+07:00
function isoLocal(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const off = -d.getTimezoneOffset();
  const p = (n: number) => String(Math.abs(Math.trunc(n))).padStart(2, '0');
  return (
    new Date(d.getTime() + off * 60000).toISOString().slice(0, 19) +
    `${off >= 0 ? '+' : '-'}${p(off / 60)}:${p(off % 60)}`
  );
}

function csvField(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadHistoryCsv(rows: any[], address: string) {
  const header = [
    'key', 'pair', 'version', 'open_ts', 'close_ts', 'duration_hours',
    'initial_usd', 'final_usd', 'fees_usd', 'pnl_usd', 'pnl_pct',
    'close_side', 'source', 'estimated',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    const durH = r.open_ts && r.close_ts
      ? ((new Date(r.close_ts).getTime() - new Date(r.open_ts).getTime()) / 3_600_000).toFixed(2)
      : '';
    lines.push([
      r.key, r.pair, r.version, isoLocal(r.open_ts), isoLocal(r.close_ts), durH,
      r.initial_usd ?? '', r.final_usd ?? '', r.fees_usd ?? '',
      r.pnl_usd ?? '', r.pnl_pct ?? '', r.close_side ?? '', r.source ?? '',
      r.estimated ? 'true' : 'false',
    ].map(csvField).join(','));
  }
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `lp-monitor-history-${address.slice(2, 8)}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function History({ session, onAuthFail }: { session: Session; onAuthFail: () => void }) {
  const { data: rows } = useAuthed('/journal', session.token, 120_000, onAuthFail);
  const [page, setPage] = useState(1);
  if (!rows) return <p className="muted">Memuat history…</p>;
  if (rows.length === 0) {
    return <p className="muted">Belum ada history — posisi pertama yang kamu tutup akan tercatat di sini otomatis.</p>;
  }

  const num = (v: any) => (v == null ? null : Number(v));
  const wins = rows.filter((r: any) => num(r.pnl_usd)! > 0);
  const losses = rows.filter((r: any) => num(r.pnl_usd)! <= 0);
  const feeRows = rows.filter((r: any) => r.fees_usd != null);
  const totalPnl = rows.reduce((s: number, r: any) => s + (num(r.pnl_usd) ?? 0), 0);
  const avg = (arr: any[], f: (r: any) => number) => (arr.length ? arr.reduce((s, r) => s + f(r), 0) / arr.length : 0);
  const durMs = (r: any) => (r.open_ts && r.close_ts ? new Date(r.close_ts).getTime() - new Date(r.open_ts).getTime() : 0);

  const pages = Math.max(1, Math.ceil(rows.length / HISTORY_PER_PAGE));
  const cur = Math.min(Math.max(1, page), pages);
  const slice = rows.slice((cur - 1) * HISTORY_PER_PAGE, cur * HISTORY_PER_PAGE);

  const badge = (side: string) =>
    side === 'below' ? <span className="status out-below">tembus bawah</span>
    : side === 'above' ? <span className="status out-above">di atas range</span>
    : side === 'in' ? <span className="status in">dalam range</span>
    : <span className="muted">—</span>;

  return (
    <>
      <section className="tiles small">
        <div className="tile"><div className="label">Total P&amp;L tertutup</div>
          <div className={`value ${totalPnl >= 0 ? 'pos-t' : 'neg-t'}`}>{fmtUsd(totalPnl, true)}</div></div>
        <div className="tile"><div className="label">Win rate</div>
          <div className="value">{((wins.length / rows.length) * 100).toFixed(0)}%</div>
          <div className="hint">{wins.length} profit / {losses.length} rugi</div></div>
        <div className="tile"><div className="label">Rata-rata fee</div>
          <div className="value">{feeRows.length ? fmtUsd(avg(feeRows, (r) => num(r.fees_usd)!)) : '—'}</div>
          <div className="hint">{feeRows.length ? `dari ${feeRows.length} posisi terpantau` : 'fee posisi lama termasuk di penarikan'}</div></div>
        <div className="tile"><div className="label">Rata-rata rugi</div>
          <div className="value">{losses.length ? fmtUsd(avg(losses, (r) => num(r.pnl_usd)!)) : '—'}</div>
          <div className="hint">per posisi rugi</div></div>
        <div className="tile"><div className="label">Rata-rata durasi</div>
          <div className="value">{fmtDur(avg(rows, durMs))}</div></div>
      </section>

      <div className="history-toolbar">
        <span className="muted">{rows.length} posisi tertutup</span>
        <button className="ghost" onClick={() => downloadHistoryCsv(rows, session.address)}>
          ⬇ Unduh CSV
        </button>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Pair</th><th>Dibuka</th><th>Durasi</th><th>Penutupan</th><th className="num">Modal</th><th className="num">Fee</th><th className="num">P&amp;L $</th><th className="num">P&amp;L %</th></tr>
          </thead>
          <tbody>
            {slice.map((r: any) => (
              <tr key={r.key}>
                <td>{r.pair} <span className="badge">{r.version}</span>{r.source === 'rekonstruksi' && <span className="badge" title="Direkonstruksi dari transaksi on-chain"> on-chain</span>}</td>
                <td>{r.open_ts ? fmtWhen(r.open_ts) : '—'}</td>
                <td>{fmtDur(durMs(r))}</td>
                <td>{badge(r.close_side)}</td>
                <td className="num">{fmtUsd(num(r.initial_usd))}</td>
                <td className="num">{r.fees_usd != null ? fmtUsd(num(r.fees_usd)) : <span className="muted" title="Fee sudah termasuk di nilai penarikan">—</span>}</td>
                <td className={`num ${Math.abs(num(r.pnl_usd)!) < 0.005 ? 'muted' : num(r.pnl_usd)! >= 0 ? 'pos-t' : 'neg-t'}`}>
                  {Math.abs(num(r.pnl_usd)!) < 0.005 ? '$0.00' : `${r.estimated ? '≈' : ''}${fmtUsd(num(r.pnl_usd), true)}`}</td>
                <td className={`num ${Math.abs(num(r.pnl_usd)!) < 0.005 ? 'muted' : num(r.pnl_usd)! >= 0 ? 'pos-t' : 'neg-t'}`}>
                  {r.pnl_pct == null ? '—' : Math.abs(num(r.pnl_usd)!) < 0.005 ? '0.0%' : `${num(r.pnl_pct)! >= 0 ? '+' : ''}${num(r.pnl_pct)!.toFixed(1)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="pager">
          <button className="ghost" disabled={cur <= 1} onClick={() => setPage(cur - 1)}>‹ Sebelumnya</button>
          <span className="muted">Halaman {cur} / {pages} · {rows.length} posisi</span>
          <button className="ghost" disabled={cur >= pages} onClick={() => setPage(cur + 1)}>Berikutnya ›</button>
        </div>
      )}
    </>
  );
}

function Balances({ bal }: { bal: any }) {
  if (!bal) return <p className="muted">Memuat saldo…</p>;
  const shown = bal.tokens.filter((t: any) => (t.usd ?? 0) >= 0.01 || (t.usd == null && t.amount > 0));
  const dust = bal.tokens.length - shown.length;
  return (
    <>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Token</th><th className="num">Jumlah</th><th className="num">Harga</th><th className="num">Nilai</th></tr>
          </thead>
          <tbody>
            {shown.map((t: any, i: number) => (
              <tr key={t.address ?? `native-${i}`}>
                <td>
                  {t.symbol}
                  {t.verified && <span className="pos-t"> ✓</span>}
                  {t.native && <span className="badge"> native</span>}
                  {t.impostor && <span className="badge" style={{ color: 'var(--critical)' }}> palsu?</span>}
                </td>
                <td className="num">{fmtAmt(t.amount)}</td>
                <td className="num">{t.priceUsd != null ? fmtUsd(t.priceUsd) : '—'}</td>
                <td className="num">{t.usd != null ? fmtUsd(t.usd) : <span className="muted">tidak ada harga</span>}</td>
              </tr>
            ))}
            <tr><td><b>Total</b></td><td /><td /><td className="num"><b>{fmtUsd(bal.totalUsd)}</b></td></tr>
          </tbody>
        </table>
      </div>
      {dust > 0 && <p className="muted">{dust} token debu (&lt; $0.01) disembunyikan.</p>}
    </>
  );
}
