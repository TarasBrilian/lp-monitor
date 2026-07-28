import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { PositionsService } from './positions.service.js';

@UseGuards(AuthGuard)
@Controller('positions')
export class PositionsController {
  constructor(private positions: PositionsService) {}

  @Get()
  list(@Req() req: { address: string }) {
    return this.positions.list(req.address);
  }
}
