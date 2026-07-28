import { Controller, Get, Module, Req, UseGuards } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { tenantSchema } from '@lpmon/shared';
import { AuthController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { AuthGuard } from './auth/auth.guard.js';
import { TenantService } from './tenant/tenant.service.js';
import { PositionsController } from './positions/positions.controller.js';
import { PositionsService } from './positions/positions.service.js';
import { BalancesService } from './positions/balances.service.js';
import { sql } from './db.js';

@Controller()
class AppController {
  @Get('health')
  async health() {
    const [row] = await sql`SELECT 1 AS ok`;
    return { ok: row.ok === 1, ts: Date.now() };
  }

  @UseGuards(AuthGuard)
  @Get('me')
  me(@Req() req: { address: string }) {
    return { address: req.address, schema: tenantSchema(req.address) };
  }
}

@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET ?? 'dev-only-ganti-di-env',
      signOptions: { expiresIn: '7d' },
    }),
  ],
  controllers: [AppController, AuthController, PositionsController],
  providers: [AuthService, AuthGuard, TenantService, PositionsService, BalancesService],
})
export class AppModule {}
