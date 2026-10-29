import { Module } from '@nestjs/common';
import { AlertsController } from './alerts.controller.js';
import { AlertsService } from './alerts.service.js';

@Module({
  controllers: [AlertsController],
  providers: [AlertsService],
  exports: [AlertsService],
})
export class AlertsModule {}
