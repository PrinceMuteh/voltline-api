import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { DRIVER_SESSION_DAYS, type DriverTokenPayload } from './driver-auth.js';

const CODE_TTL_MS = 5 * 60_000;
const RESEND_AFTER_MS = 30_000;
const MAX_ATTEMPTS = 5;

/**
 * Phone sign-in for the driver app: a 6-digit code, valid 5 minutes, 5 tries, kept only as a
 * hash and deleted once used. No SMS provider is wired yet, so outside production the code is
 * returned to the app (and logged); in production sending is refused until one is set up.
 */
@Injectable()
export class DriverAuthService {
  private readonly logger = new Logger(DriverAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async sendCode(rawPhone: string) {
    const phone = normalizeNigerianPhone(rawPhone);
    if (this.config.get('NODE_ENV') === 'production') {
      throw new ServiceUnavailableException(
        'Phone sign-in is not available yet: no SMS provider is set up.',
      );
    }
    const last = await this.prisma.otpCode.findFirst({
      where: { phone },
      orderBy: { createdAt: 'desc' },
    });
    if (last && Date.now() - last.createdAt.getTime() < RESEND_AFTER_MS) {
      const wait = Math.ceil(
        (RESEND_AFTER_MS - (Date.now() - last.createdAt.getTime())) / 1000,
      );
      throw new HttpException(
        `Wait ${wait} s before asking for another code.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.prisma.$transaction([
      this.prisma.otpCode.deleteMany({ where: { phone } }),
      this.prisma.otpCode.create({
        data: {
          phone,
          codeHash: this.hash(phone, code),
          expiresAt: new Date(Date.now() + CODE_TTL_MS),
        },
      }),
    ]);
    this.logger.log(`Sign-in code for ${phone}: ${code} (development only)`);
    return { phone, devCode: code };
  }

  /** Checks the code, then finds or creates the driver in the app's workspace. */
  async verify(rawPhone: string, code: string) {
    const phone = normalizeNigerianPhone(rawPhone);
    const otp = await this.prisma.otpCode.findFirst({
      where: { phone },
      orderBy: { createdAt: 'desc' },
    });
    const wrong = () =>
      new UnauthorizedException(
        'That code is not right. Check the text and try again.',
      );
    if (!otp || otp.expiresAt < new Date()) {
      throw new UnauthorizedException(
        'That code has expired. Ask for a new one.',
      );
    }
    if (otp.attempts >= MAX_ATTEMPTS) {
      throw new UnauthorizedException('Too many tries. Ask for a new code.');
    }
    const expected = Buffer.from(otp.codeHash, 'hex');
    const given = Buffer.from(this.hash(phone, code), 'hex');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      await this.prisma.otpCode.update({
        where: { id: otp.id },
        data: { attempts: { increment: 1 } },
      });
      throw wrong();
    }
    await this.prisma.otpCode.deleteMany({ where: { phone } });

    const workspaceId = await this.appWorkspaceId();
    const existing = await this.prisma.driver.findUnique({
      where: { workspaceId_phone: { workspaceId, phone } },
    });
    const driver =
      existing ??
      (await this.prisma.driver.create({
        // The wallet marks them as an app user in the console's Drivers list
        data: {
          workspaceId,
          phone,
          plugTypes: ['CCS2'],
          wallet: { create: {} },
        },
      }));
    const payload: DriverTokenPayload = {
      typ: 'driver',
      sub: driver.id,
      wid: workspaceId,
    };
    const token = await this.jwt.signAsync(payload, {
      expiresIn: `${DRIVER_SESSION_DAYS}d`,
    });
    return { token, isNew: !existing };
  }

  /**
   * The app is white-labelled per operator: it belongs to one workspace, named by
   * DRIVER_APP_WORKSPACE (default: the seeded demo workspace).
   */
  async appWorkspaceId() {
    const name =
      this.config.get<string>('DRIVER_APP_WORKSPACE') ?? 'Voltline Demo';
    const workspace = await this.prisma.workspace.findFirst({
      where: { name },
      select: { id: true },
    });
    if (!workspace) {
      throw new NotFoundException(
        `The driver app's workspace "${name}" does not exist.`,
      );
    }
    return workspace.id;
  }

  private hash(phone: string, code: string) {
    return createHmac(
      'sha256',
      this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
    )
      .update(`${phone}:${code}`)
      .digest('hex');
  }
}

/** "0803 000 0000", "803…", "+234 803…" → "+2348030000000". Throws for anything else. */
export function normalizeNigerianPhone(raw: string) {
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('234')) digits = digits.slice(3);
  if (digits.startsWith('0')) digits = digits.slice(1);
  if (!/^[789]\d{9}$/.test(digits)) {
    throw new HttpException(
      'Enter a Nigerian mobile number like 803 000 0000.',
      HttpStatus.BAD_REQUEST,
    );
  }
  return `+234${digits}`;
}
