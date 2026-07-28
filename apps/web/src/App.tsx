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
      history.replaceState(null, '', location.pathname);
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
        P&amp;L lengkap &amp; jurnal menyusul di M3.
      </footer>
    </>
  );
}

function useAuthed(path: string, token: string, refreshMs: number, onAuthFail: () => void) {
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
  }, [path, token]);
  return { data, err };
}

function Dashboard({ session, onAuthFail }: { session: Session; onAuthFail: () => void }) {
  const { data: pos, err: posErr } = useAuthed('/positions', session.token, 60_000, onAuthFail);
  const { data: bal } = useAuthed('/balances', session.token, 120_000, onAuthFail);
  const [tab, setTab] = useState<'saldo' | 'history'>('saldo');

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
      {pos?.positions?.map((p: any) => <PositionCard key={p.key} p={p} />)}
    </>
  );
}

function PositionCard({ p }: { p: any }) {
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
        <div><div className="label">Umur posisi</div><div className="val">{fmtDur(p.ageMs)}</div></div>
        <div><div className="label">Modal awal</div>
          <div className="val">{fmtUsd(p.initialUsd)}</div>
          <div className="sub">{p.initialSource === 'index' ? 'dari on-chain' : p.initialSource === 'index-estimasi' ? 'on-chain (estimasi)' : 'sejak terpantau'}</div></div>
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

function History({ session, onAuthFail }: { session: Session; onAuthFail: () => void }) {
  const { data: rows } = useAuthed('/journal', session.token, 120_000, onAuthFail);
  if (!rows) return <p className="muted">Memuat history…</p>;
  if (rows.length === 0) {
    return <p className="muted">Belum ada history — posisi pertama yang kamu tutup akan tercatat di sini otomatis.</p>;
  }
  const badge = (side: string) =>
    side === 'below' ? <span className="status out-below">tembus bawah</span>
    : side === 'above' ? <span className="status out-above">di atas range</span>
    : side === 'in' ? <span className="status in">dalam range</span>
    : <span className="muted">—</span>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr><th>Pair</th><th>Dibuka</th><th>Penutupan</th><th className="num">Modal</th><th className="num">Fee</th><th className="num">P&amp;L $</th><th className="num">P&amp;L %</th></tr>
        </thead>
        <tbody>
          {rows.map((r: any) => (
            <tr key={r.key}>
              <td>{r.pair} <span className="badge">{r.version}</span></td>
              <td>{fmtWhen(r.open_ts)}</td>
              <td>{badge(r.close_side)}</td>
              <td className="num">{fmtUsd(Number(r.initial_usd))}</td>
              <td className="num">{fmtUsd(Number(r.fees_usd))}</td>
              <td className={`num ${Number(r.pnl_usd) >= 0 ? 'pos-t' : 'neg-t'}`}>{fmtUsd(Number(r.pnl_usd), true)}</td>
              <td className={`num ${Number(r.pnl_usd) >= 0 ? 'pos-t' : 'neg-t'}`}>{r.pnl_pct != null ? `${Number(r.pnl_pct) >= 0 ? '+' : ''}${Number(r.pnl_pct).toFixed(1)}%` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
