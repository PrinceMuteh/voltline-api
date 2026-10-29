import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiCookieAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  CurrentAuth,
  Roles,
  type AuthContext,
} from '../auth/auth.decorators.js';
import type { OcppSettings } from '../generated/prisma/client.js';
import { ConfigurationService } from '../ocpp/configuration.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  OcppSettingsDto,
  OcppSettingsUpdateDto,
} from './dto/ocpp-settings.dto.js';

/** Settings › OCPP. New values apply to the next BootNotification and the next sweep. */
@ApiTags('console')
@ApiCookieAuth()
@Controller('console/ocpp-settings')
export class SettingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly configuration: ConfigurationService,
  ) {}

  @Get()
  @ApiOkResponse({ type: OcppSettingsDto })
  async get(@CurrentAuth() auth: AuthContext) {
    const settings = await this.prisma.ocppSettings.upsert({
      where: { workspaceId: auth.workspaceId },
      create: { workspaceId: auth.workspaceId },
      update: {},
    });
    return this.toDto(settings);
  }

  @Patch()
  @Roles('ADMIN')
  @ApiOkResponse({ type: OcppSettingsDto })
  async update(
    @CurrentAuth() auth: AuthContext,
    @Body() dto: OcppSettingsUpdateDto,
  ) {
    const settings = await this.prisma.ocppSettings.upsert({
      where: { workspaceId: auth.workspaceId },
      create: Object.assign({ workspaceId: auth.workspaceId }, dto),
      update: dto,
    });
    if (dto.meterValuesSampleSec !== undefined) {
      // In the background: a slow charger must not hold up the save
      void this.configuration.applyMeterInterval(
        auth.workspaceId,
        dto.meterValuesSampleSec,
      );
    }
    return this.toDto(settings);
  }

  private toDto(s: OcppSettings): OcppSettingsDto {
    const base = (
      this.config.get<string>('OCPP_PUBLIC_URL') ?? 'ws://localhost:4000/ocpp'
    ).replace(/\/$/, '');
    return {
      accept16J: s.accept16J,
      accept201: s.accept201,
      accept21: false,
      autoApproveChargers: s.autoApproveChargers,
      syncLocalLists: s.syncLocalLists,
      heartbeatIntervalSec: s.heartbeatIntervalSec,
      meterValuesSampleSec: s.meterValuesSampleSec,
      offlineAlertAfterMin: s.offlineAlertAfterMin,
      endpoint: `${base}/{chargePointId}`,
    };
  }
}
