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
        <section className="card">
          <h2>Terhubung ✓</h2>
          <p><b>Address:</b> <code>{session.address}</code></p>
          <p><b>Schema data:</b> <code>{me?.schema ?? '…'}</code></p>
          <p className="muted">
            M1 selesai: auth &amp; provisioning. Dashboard posisi menyusul di M2-M3
            (lihat ARCHITECTURE.md).
          </p>
          <button onClick={logout} className="ghost">Keluar</button>
        </section>
      )}
    </main>
  );
}
