import { Module } from '@nestjs/common';
import { OcppModule } from '../ocpp/ocpp.module.js';
import { DriversController } from './drivers.controller.js';
import { DriversService } from './drivers.service.js';

@Module({
  imports: [OcppModule],
  controllers: [DriversController],
  providers: [DriversService],
})
export class DriversModule {}
