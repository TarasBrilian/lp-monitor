import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { PositionsService } from './positions.service.js';
import { BalancesService } from './balances.service.js';
import { TrackingService } from './tracking.service.js';

@UseGuards(AuthGuard)
@Controller()
export class PositionsController {
  constructor(
    private positions: PositionsService,
    private balances: BalancesService,
    private tracking: TrackingService,
  ) {}

  @Get('journal')
  journal(@Req() req: { address: string }) {
    return this.tracking.journal(req.address);
  }

  @Get('positions')
  list(@Req() req: { address: string }) {
    return this.positions.list(req.address);
  }

  @Get('balances')
  balancesList(@Req() req: { address: string }) {
    return this.balances.list(req.address);
  }

  @Post('positions/:key/initial')
  async setInitial(
    @Req() req: { address: string },
    @Param('key') key: string,
    @Body() body: { usd: number },
  ) {
    const usd = Number(body?.usd);
    if (!Number.isFinite(usd) || usd <= 0) throw new BadRequestException('Nilai USD tidak valid');
    const ok = await this.tracking.setInitial(req.address, key, usd);
    if (!ok) throw new NotFoundException('Posisi tidak ditemukan');
    this.positions.invalidate(req.address);
    return { ok: true };
  }
}
