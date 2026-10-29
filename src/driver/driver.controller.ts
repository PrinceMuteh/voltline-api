import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../auth/auth.decorators.js';
import { SessionDetailDto } from '../sessions/dto/session.dto.js';
import {
  CurrentDriver,
  DRIVER_COOKIE,
  DRIVER_SESSION_DAYS,
  DriverGuard,
  type DriverContext,
} from './driver-auth.js';
import { DriverAuthService } from './driver-auth.service.js';
import { DriverService } from './driver.service.js';
import {
  DriverMeDto,
  HistoryDto,
  LinkCardDto,
  LiveDto,
  SendCodeDto,
  SentCodeDto,
  StartDto,
  StartResultDto,
  StationDto,
  UpdateDriverDto,
  VerifiedDto,
  VerifyCodeDto,
} from './dto/driver.dto.js';

@ApiTags('driver app')
@Public()
@Controller('app')
export class DriverAuthController {
  constructor(
    private readonly auth: DriverAuthService,
    private readonly config: ConfigService,
  ) {}

  @Post('auth/otp/send')
  @HttpCode(200)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ApiOkResponse({ type: SentCodeDto })
  send(@Body() dto: SendCodeDto) {
    return this.auth.sendCode(dto.phone);
  }

  @Post('auth/otp/verify')
  @HttpCode(200)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOkResponse({ type: VerifiedDto })
  async verify(
    @Body() dto: VerifyCodeDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VerifiedDto> {
    const { token, isNew } = await this.auth.verify(dto.phone, dto.code);
    res.cookie(DRIVER_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.get('COOKIE_SECURE') === 'true',
      path: '/',
      maxAge: DRIVER_SESSION_DAYS * 86_400_000,
    });
    return { isNew };
  }

  @Post('auth/sign-out')
  @HttpCode(204)
  signOut(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(DRIVER_COOKIE, { path: '/' });
  }
}

@ApiTags('driver app')
@Public()
@UseGuards(DriverGuard)
@Controller('app')
export class DriverController {
  constructor(private readonly driver: DriverService) {}

  @Get('me')
  @ApiOkResponse({ type: DriverMeDto })
  me(@CurrentDriver() d: DriverContext) {
    return this.driver.me(d);
  }

  @Patch('me')
  @ApiOkResponse({ type: DriverMeDto })
  update(@CurrentDriver() d: DriverContext, @Body() dto: UpdateDriverDto) {
    return this.driver.update(d, dto);
  }

  @Post('me/cards')
  @HttpCode(200)
  @ApiOkResponse({ type: DriverMeDto })
  linkCard(@CurrentDriver() d: DriverContext, @Body() dto: LinkCardDto) {
    return this.driver.linkCard(d, dto.uid);
  }

  @Get('stations')
  @ApiOkResponse({ type: [StationDto] })
  stations(@CurrentDriver() d: DriverContext) {
    return this.driver.stations(d);
  }

  @Get('stations/:id')
  @ApiOkResponse({ type: StationDto })
  station(
    @CurrentDriver() d: DriverContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.driver.stationById(d, id);
  }

  /** The QR code on a charger encodes its charge point ID. */
  @Get('chargers/by-code/:code')
  @ApiOkResponse({ type: StationDto })
  byCode(@CurrentDriver() d: DriverContext, @Param('code') code: string) {
    return this.driver.byCode(d, code);
  }

  @Post('sessions')
  @HttpCode(200)
  @ApiOkResponse({ type: StartResultDto })
  start(@CurrentDriver() d: DriverContext, @Body() dto: StartDto) {
    return this.driver.start(d, dto.chargerId, dto.evseId);
  }

  @Get('sessions/live')
  @ApiOkResponse({ type: LiveDto })
  async live(@CurrentDriver() d: DriverContext): Promise<LiveDto> {
    return { session: await this.driver.live(d) };
  }

  @Get('sessions')
  @ApiOkResponse({ type: HistoryDto })
  history(@CurrentDriver() d: DriverContext) {
    return this.driver.history(d);
  }

  @Get('sessions/:id')
  @ApiOkResponse({ type: SessionDetailDto })
  receipt(
    @CurrentDriver() d: DriverContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.driver.receipt(d, id);
  }

  @Post('sessions/:id/stop')
  @HttpCode(200)
  stop(
    @CurrentDriver() d: DriverContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.driver.stop(d, id);
  }
}
