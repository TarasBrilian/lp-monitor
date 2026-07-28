import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private jwt: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    try {
      const payload = await this.jwt.verifyAsync(token);
      req.address = payload.sub as string;
      return true;
    } catch {
      throw new UnauthorizedException('Login dulu (SIWE)');
    }
  }
}
