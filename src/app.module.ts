import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AlertsModule } from './alerts/alerts.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ChargersModule } from './chargers/chargers.module.js';
import { validateEnv } from './config/env.validation.js';
import { ConsoleModule } from './console/console.module.js';
import { HealthController } from './health/health.controller.js';
import { OcppModule } from './ocpp/ocpp.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { SessionsModule } from './sessions/sessions.module.js';
import { TariffsModule } from './tariffs/tariffs.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    PrismaModule,
    AuthModule,
    RealtimeModule,
    AlertsModule,
    OcppModule,
    ChargersModule,
    SessionsModule,
    TariffsModule,
    ConsoleModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
