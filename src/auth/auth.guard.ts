import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Role } from '../generated/prisma/client.js';
import {
  ACCESS_COOKIE,
  AuthContext,
  AuthedRequest,
  IS_PUBLIC,
  ROLES,
} from './auth.decorators.js';

interface AccessPayload {
  sub: string;
  mid: string;
  wid: string;
  role: Role;
}

/**
 * Global guard. Accepts the access token from the httpOnly cookie (web) or an
 * Authorization: Bearer header (mobile and partner clients).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) {
      return true;
    }

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token = this.extractToken(req);
    if (!token) {
      throw new UnauthorizedException('Sign in to continue.');
    }

    let payload: AccessPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessPayload>(token);
      // Realtime tickets share the signing key but carry a typ claim; they never authorize HTTP
      if ('typ' in payload) {
        throw new Error('not an access token');
      }
    } catch {
      throw new UnauthorizedException(
        'Your session has expired. Sign in again.',
      );
    }
    const auth: AuthContext = {
      userId: payload.sub,
      memberId: payload.mid,
      workspaceId: payload.wid,
      role: payload.role,
    };
    req.auth = auth;

    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES,
      targets,
    );
    if (roles && !roles.includes(auth.role)) {
      throw new ForbiddenException('Your role does not allow this action.');
    }
    return true;
  }

  private extractToken(req: AuthedRequest): string | undefined {
    const cookie = (req.cookies as Record<string, string> | undefined)?.[
      ACCESS_COOKIE
    ];
    if (cookie) {
      return cookie;
    }
    const [scheme, value] = req.headers.authorization?.split(' ') ?? [];
    return scheme === 'Bearer' ? value : undefined;
  }
}
