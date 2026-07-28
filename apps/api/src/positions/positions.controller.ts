import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { PositionsService } from './positions.service.js';
import { BalancesService } from './balances.service.js';

@UseGuards(AuthGuard)
@Controller()
export class PositionsController {
  constructor(
    private positions: PositionsService,
    private balances: BalancesService,
  ) {}

  @Get('positions')
  list(@Req() req: { address: string }) {
    return this.positions.list(req.address);
  }

  @Get('balances')
  balancesList(@Req() req: { address: string }) {
    return this.balances.list(req.address);
  }
}
