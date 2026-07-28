import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'node:crypto';
import { verifyMessage, isAddress, getAddress } from 'viem';
import { TenantService } from '../tenant/tenant.service.js';

const NONCE_TTL_MS = 5 * 60_000;

// Pesan yang ditandatangani wallet. Frontend HARUS membuat string yang sama persis.
export function loginMessage(address: string, nonce: string): string {
  return [
    'LP Monitor v2 — verifikasi kepemilikan address.',
    '',
    `Address: ${getAddress(address)}`,
    `Nonce: ${nonce}`,
    'Tanda tangan ini tidak memicu transaksi dan tidak memberi akses dana.',
  ].join('\n');
}

@Injectable()
export class AuthService {
  private nonces = new Map<string, number>(); // nonce -> kedaluwarsa

  constructor(
    private jwt: JwtService,
    private tenant: TenantService,
  ) {}

  issueNonce(): string {
    const nonce = randomBytes(16).toString('hex');
    this.nonces.set(nonce, Date.now() + NONCE_TTL_MS);
    for (const [n, exp] of this.nonces) if (exp < Date.now()) this.nonces.delete(n);
    return nonce;
  }

  async verify(address: string, nonce: string, signature: `0x${string}`) {
    if (!isAddress(address)) throw new UnauthorizedException('Address tidak valid');
    const exp = this.nonces.get(nonce);
    if (!exp || exp < Date.now()) throw new UnauthorizedException('Nonce kedaluwarsa — minta nonce baru');
    this.nonces.delete(nonce); // sekali pakai

    const ok = await verifyMessage({
      address: getAddress(address),
      message: loginMessage(address, nonce),
      signature,
    }).catch(() => false);
    if (!ok) throw new UnauthorizedException('Tanda tangan tidak cocok dengan address');

    const schema = await this.tenant.provision(address);
    const token = await this.jwt.signAsync({ sub: getAddress(address) });
    return { token, address: getAddress(address), schema };
  }
}
