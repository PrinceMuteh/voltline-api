import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import argon2 from 'argon2';
import { createHmac, randomBytes } from 'node:crypto';
import type { Member } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SignInDto } from './dto/sign-in.dto.js';
import { SignUpDto } from './dto/sign-up.dto.js';

export interface IssuedTokens {
  accessToken: string;
  accessMaxAgeMs: number;
  refreshToken: string;
  refreshMaxAgeMs: number;
}

const BAD_CREDENTIALS = 'Email or password is incorrect.';

@Injectable()
export class AuthService {
  // Verified against when the email is unknown, so both paths take the same time
  private readonly dummyHash = argon2.hash('voltline-timing-guard');

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async signUp(dto: SignUpDto): Promise<IssuedTokens> {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existing) {
      throw new ConflictException(
        'An account with this email already exists. Sign in instead.',
      );
    }

    const passwordHash = await argon2.hash(dto.password);
    const member = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { name: dto.name, email: dto.email, passwordHash },
      });
      const workspace = await tx.workspace.create({
        data: {
          name: dto.company,
          registeredCompanyName: dto.company,
          country: dto.country,
          chargerCountBand: dto.chargerCount,
          ocppConfig: { create: {} },
          gateway: { create: {} },
        },
      });
      return tx.member.create({
        data: { workspaceId: workspace.id, userId: user.id, role: 'ADMIN' },
      });
    });

    return this.issueTokens(member);
  }

  async signIn(dto: SignInDto): Promise<IssuedTokens> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: { memberships: { orderBy: { createdAt: 'asc' }, take: 1 } },
    });
    if (!user) {
      await argon2.verify(await this.dummyHash, dto.password);
      throw new UnauthorizedException(BAD_CREDENTIALS);
    }
    if (!(await argon2.verify(user.passwordHash, dto.password))) {
      throw new UnauthorizedException(BAD_CREDENTIALS);
    }
    const [member] = user.memberships;
    if (!member) {
      throw new UnauthorizedException(
        'This account is not part of any workspace.',
      );
    }
    return this.issueTokens(member);
  }

  /** Rotates the refresh token. Presenting a revoked token revokes every token of that user. */
  async refresh(refreshToken: string | undefined): Promise<IssuedTokens> {
    if (!refreshToken) {
      throw new UnauthorizedException('Sign in to continue.');
    }
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hashRefreshToken(refreshToken) },
    });
    if (!stored) {
      throw new UnauthorizedException('Sign in to continue.');
    }
    if (stored.revokedAt) {
      await this.prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Sign in to continue.');
    }
    if (stored.expiresAt < new Date()) {
      throw new UnauthorizedException(
        'Your session has expired. Sign in again.',
      );
    }

    const member = await this.prisma.member.findFirst({
      where: { userId: stored.userId },
      orderBy: { createdAt: 'asc' },
    });
    if (!member) {
      throw new UnauthorizedException(
        'This account is not part of any workspace.',
      );
    }
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });
    return this.issueTokens(member);
  }

  async signOut(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) {
      return;
    }
    await this.prisma.refreshToken.updateMany({
      where: {
        tokenHash: this.hashRefreshToken(refreshToken),
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
  }

  private async issueTokens(member: Member): Promise<IssuedTokens> {
    const accessMaxAgeMs =
      this.config.getOrThrow<number>('JWT_ACCESS_TTL_MIN') * 60_000;
    const refreshMaxAgeMs =
      this.config.getOrThrow<number>('JWT_REFRESH_TTL_DAYS') * 86_400_000;

    const accessToken = await this.jwt.signAsync(
      {
        sub: member.userId,
        mid: member.id,
        wid: member.workspaceId,
        role: member.role,
      },
      { expiresIn: accessMaxAgeMs / 1000 },
    );
    const refreshToken = randomBytes(32).toString('base64url');
    await this.prisma.refreshToken.create({
      data: {
        userId: member.userId,
        tokenHash: this.hashRefreshToken(refreshToken),
        expiresAt: new Date(Date.now() + refreshMaxAgeMs),
      },
    });
    return { accessToken, accessMaxAgeMs, refreshToken, refreshMaxAgeMs };
  }

  private hashRefreshToken(token: string): string {
    return createHmac(
      'sha256',
      this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
    )
      .update(token)
      .digest('hex');
  }
}
