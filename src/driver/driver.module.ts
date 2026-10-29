import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { OcppModule } from '../ocpp/ocpp.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { DriverGuard } from './driver-auth.js';
import { DriverAuthService } from './driver-auth.service.js';
import { DriverAuthController, DriverController } from './driver.controller.js';
import { DriverService } from './driver.service.js';

@Module({
  imports: [AuthModule, OcppModule, SessionsModule],
  controllers: [DriverAuthController, DriverController],
  providers: [DriverAuthService, DriverService, DriverGuard],
})
export class DriverModule {}
