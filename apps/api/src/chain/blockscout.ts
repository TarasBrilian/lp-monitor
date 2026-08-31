// Blockscout berada di belakang proteksi bot Cloudflare: request yang tidak
// terlihat seperti browser dibalas 403 (`cf-mitigated: challenge`) — bukan 429,
// jadi retry tidak menolong. fetch() Bun tidak mengirim User-Agent semacam itu,
// karena itu kita set sendiri. Terverifikasi 31 Ags 2026: UA kosong, `Bun/1.x`,
// `node`, dan bahkan `Mozilla/5.0` telanjang tetap 403 — hanya string browser
// utuh yang lolos.
//
// Semua pemanggilan Blockscout WAJIB lewat sini supaya tidak ada call site yang
// terlewat saat proteksinya berubah lagi.
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function blockscoutFetch(url: string, timeoutMs = 15_000): Promise<Response> {
  return fetch(url, {
    headers: { accept: 'application/json', 'user-agent': BROWSER_UA },
    signal: AbortSignal.timeout(timeoutMs),
  });
}
