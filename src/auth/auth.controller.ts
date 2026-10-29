import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { CookieOptions, Request, Response } from 'express';
import { ACCESS_COOKIE, Public, REFRESH_COOKIE } from './auth.decorators.js';
import { AuthService, IssuedTokens } from './auth.service.js';
import { SignInDto } from './dto/sign-in.dto.js';
import { SignUpDto } from './dto/sign-up.dto.js';

/** Tokens travel only in httpOnly cookies, never in the response body. */
@ApiTags('auth')
@Public()
@Throttle({ default: { limit: 10, ttl: 60_000 } })
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Post('sign-up')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Workspace created; auth cookies set' })
  async signUp(
    @Body() dto: SignUpDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.setCookies(res, await this.auth.signUp(dto));
  }

  @Post('sign-in')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Auth cookies set' })
  async signIn(
    @Body() dto: SignInDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.setCookies(res, await this.auth.signIn(dto));
  }

  @Post('refresh')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Auth cookies rotated' })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      this.setCookies(res, await this.auth.refresh(this.refreshCookie(req)));
    } catch (error) {
      this.clearCookies(res);
      throw error;
    }
  }

  @Post('sign-out')
  @HttpCode(204)
  @ApiNoContentResponse({
    description: 'Refresh token revoked; cookies cleared',
  })
  async signOut(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.signOut(this.refreshCookie(req));
    this.clearCookies(res);
  }

  private refreshCookie(req: Request): string | undefined {
    return (req.cookies as Record<string, string> | undefined)?.[
      REFRESH_COOKIE
    ];
  }

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.get<string>('COOKIE_SECURE') === 'true',
      path: '/',
    };
  }

  private setCookies(res: Response, tokens: IssuedTokens) {
    res.cookie(ACCESS_COOKIE, tokens.accessToken, {
      ...this.cookieOptions(),
      maxAge: tokens.accessMaxAgeMs,
    });
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
      ...this.cookieOptions(),
      maxAge: tokens.refreshMaxAgeMs,
    });
  }

  private clearCookies(res: Response) {
    res.clearCookie(ACCESS_COOKIE, this.cookieOptions());
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
  }
}
