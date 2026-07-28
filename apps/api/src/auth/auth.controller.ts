import { Body, Controller, Get, Post } from '@nestjs/common';
import { AuthService, loginMessage } from './auth.service.js';

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Get('nonce')
  nonce() {
    const nonce = this.auth.issueNonce();
    return { nonce };
  }

  // Bantu frontend: kembalikan teks pesan persis yang harus ditandatangani
  @Post('message')
  message(@Body() body: { address: string; nonce: string }) {
    return { message: loginMessage(body.address, body.nonce) };
  }

  @Post('verify')
  verify(@Body() body: { address: string; nonce: string; signature: `0x${string}` }) {
    return this.auth.verify(body.address, body.nonce, body.signature);
  }
}
