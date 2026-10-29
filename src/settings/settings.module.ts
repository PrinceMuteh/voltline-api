import { Module } from '@nestjs/common';
import { OcppModule } from '../ocpp/ocpp.module.js';
import { SettingsController } from './settings.controller.js';

@Module({ imports: [OcppModule], controllers: [SettingsController] })
export class SettingsModule {}
