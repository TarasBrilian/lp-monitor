import { useEffect, useState } from 'react';
import { createWalletClient, custom, getAddress } from 'viem';

declare global {
  interface Window { ethereum?: any }
}

type Session = { token: string; address: string; schema: string };

const api = (path: string, init?: RequestInit) => fetch(`/api${path}`, init);

export function App() {
  const [session, setSession] = useState<Session | null>(() => {
    const raw = localStorage.getItem('lpmon-session');
    return raw ? JSON.parse(raw) : null;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<any>(null);

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
    setMe(null);
  }

  useEffect(() => {
    if (!session) return;
    api('/me', { headers: { authorization: `Bearer ${session.token}` } })
      .then(async (r) => (r.ok ? setMe(await r.json()) : logout()))
      .catch(() => {});
  }, [session]);

  return (
    <main className="wrap">
      <h1>💧 LP Monitor <span className="v2">v2</span></h1>
      <p className="sub">Robinhood Chain · Uniswap v3 &amp; v4 · multi-user</p>

      {!session ? (
        <section className="card">
          <h2>Masuk dengan wallet</h2>
          <p>
            Tanda tangani satu pesan untuk membuktikan kepemilikan address-mu.
            Tanpa transaksi, tanpa gas, tanpa akses dana.
          </p>
          <button onClick={login} disabled={busy}>
            {busy ? 'Menunggu tanda tangan…' : 'Connect wallet & Sign-In'}
          </button>
          {error && <p className="error">{error}</p>}
        </section>
      ) : (
        <>
          <section className="card">
            <h2>Terhubung ✓</h2>
            <p><b>Address:</b> <code>{session.address}</code></p>
            <p><b>Schema data:</b> <code>{me?.schema ?? '…'}</code></p>
            <button onClick={logout} className="ghost">Keluar</button>
          </section>
          <Positions token={session.token} />
        </>
      )}
    </main>
  );
}

function fmtUsd(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const d = abs > 0 && abs < 1 ? 4 : 2;
  return `$${abs.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

function fmtPrice(p: number) {
  if (!(p > 0)) return '—';
  if (p >= 1e30) return '∞';
  if (p < 1e-30) return '≈0';
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (p >= 0.0001) return Number(p.toPrecision(5)).toString();
  const e = Math.floor(Math.log10(p));
  const digits = Math.round(p * Math.pow(10, -e + 3)).toString().slice(0, 4);
  return `0.0{${-e - 1}}${digits}`;
}

function Positions({ token }: { token: string }) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const load = () =>
      api('/positions', { headers: { authorization: `Bearer ${token}` } })
        .then(async (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          if (!stop) { setData(await r.json()); setErr(null); }
        })
        .catch((e) => !stop && setErr(e.message));
    load();
    const t = setInterval(load, 60_000);
    return () => { stop = true; clearInterval(t); };
  }, [token]);

  if (err) return <section className="card"><p className="error">Gagal memuat posisi: {err}</p></section>;
  if (!data) return <section className="card"><p className="muted">Memuat posisi… (bisa ~1 menit saat indeks masih backfill)</p></section>;

  return (
    <section className="card">
      <h2>Posisi aktif ({data.positions.length})</h2>
      <p className="muted">
        Total nilai {fmtUsd(data.totalValueUsd)} · fee {fmtUsd(data.totalFeesUsd)} ·
        ETH {fmtUsd(data.ethUsd)} · sumber: {data.discovery}
      </p>
      {data.positions.length === 0 && (
        <p className="muted">Tidak ada posisi LP aktif. Buka posisi di Uniswap, refresh dalam ~1 menit.</p>
      )}
      {data.positions.map((p: any) => (
        <div key={p.key} className="pos">
          <div className="pos-head">
            <b>{p.pair}</b> <span className="badge">{p.version}</span>{' '}
            <span className={p.inRange ? 'ok' : 'bad'}>
              {p.inRange ? '● dalam range' : p.outSide === 'below' ? '✕ tembus bawah' : '▲ di atas range'}
            </span>
          </div>
          <div className="muted">
            {fmtPrice(p.disp.lower)} — <b>{fmtPrice(p.disp.price)}</b> — {fmtPrice(p.disp.upper)} {p.disp.quote}
          </div>
          <div>
            nilai <b>{fmtUsd(p.valueUsd)}</b> · fee belum diklaim <b>{fmtUsd(p.feesUsd)}</b> ·{' '}
            {p.disp.baseAmt.toFixed(2)} {p.disp.base} + {p.disp.quoteAmt.toFixed(2)} {p.disp.quote}
          </div>
        </div>
      ))}
    </section>
  );
}
