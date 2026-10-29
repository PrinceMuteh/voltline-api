import { Module } from '@nestjs/common';
import { OcppModule } from '../ocpp/ocpp.module.js';
import { ChargersController } from './chargers.controller.js';
import { ChargersService } from './chargers.service.js';

@Module({
  imports: [OcppModule],
  controllers: [ChargersController],
  providers: [ChargersService],
})
export class ChargersModule {}
