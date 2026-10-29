import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Role } from '../generated/prisma/client.js';

export const ACCESS_COOKIE = 'vl_access';
export const REFRESH_COOKIE = 'vl_refresh';

export interface AuthContext {
  userId: string;
  memberId: string;
  workspaceId: string;
  role: Role;
}

export interface AuthedRequest extends Request {
  auth?: AuthContext;
}

export const IS_PUBLIC = 'isPublic';
/** Skips the global AuthGuard. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ROLES = 'roles';
/** Limits a route to these roles. Without it, any signed-in member may call it. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export const CurrentAuth = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => {
    const auth = ctx.switchToHttp().getRequest<AuthedRequest>().auth;
    if (!auth) {
      throw new Error('CurrentAuth used on a public route');
    }
    return auth;
  },
);
