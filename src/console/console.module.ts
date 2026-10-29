import { Module } from '@nestjs/common';
import { OcppModule } from '../ocpp/ocpp.module.js';
import { ConsoleController } from './console.controller.js';
import { ConsoleService } from './console.service.js';

@Module({
  imports: [OcppModule],
  controllers: [ConsoleController],
  providers: [ConsoleService],
})
export class ConsoleModule {}
