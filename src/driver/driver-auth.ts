import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service.js';

/** Drivers have their own identity and cookie; console tokens never work here, nor these there. */
export const DRIVER_COOKIE = 'vl_driver';
export const DRIVER_SESSION_DAYS = 30;

export interface DriverContext {
  driverId: string;
  workspaceId: string;
}

export interface DriverTokenPayload {
  typ: 'driver';
  sub: string;
  wid: string;
}

interface DriverRequest extends Request {
  driver?: DriverContext;
}

/** Use with @Public() (which skips the console guard) on every driver-app route. */
@Injectable()
export class DriverGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<DriverRequest>();
    const cookie = (req.cookies as Record<string, string> | undefined)?.[
      DRIVER_COOKIE
    ];
    const [scheme, bearer] = req.headers.authorization?.split(' ') ?? [];
    const token = cookie ?? (scheme === 'Bearer' ? bearer : undefined);
    if (!token) {
      throw new UnauthorizedException(
        'Sign in with your phone number to continue.',
      );
    }
    let payload: DriverTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<DriverTokenPayload>(token);
    } catch {
      throw new UnauthorizedException(
        'Your sign-in has expired. Sign in again.',
      );
    }
    if (payload.typ !== 'driver') {
      throw new UnauthorizedException(
        'Sign in with your phone number to continue.',
      );
    }
    const driver = await this.prisma.driver.findUnique({
      where: { id: payload.sub },
      select: { id: true, workspaceId: true },
    });
    if (!driver) {
      throw new UnauthorizedException(
        'Sign in with your phone number to continue.',
      );
    }
    req.driver = { driverId: driver.id, workspaceId: driver.workspaceId };
    return true;
  }
}

export const CurrentDriver = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => {
    const driver = ctx.switchToHttp().getRequest<DriverRequest>().driver;
    if (!driver) {
      throw new Error('CurrentDriver used without DriverGuard');
    }
    return driver;
  },
);
