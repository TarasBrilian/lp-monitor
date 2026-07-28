import { Controller, Get, Req, UseGuards } from '@nestjs/common';
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
}
