import { Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { ChargerStateService } from './charger-state.service.js';
import { CommandsService } from './commands.service.js';
import { ConfigurationService } from './configuration.service.js';
import { ConnectionRegistry } from './connection-registry.js';
import { LivenessService } from './liveness.service.js';
import { LocalListService } from './local-list.service.js';
import { OcppMessagesService } from './ocpp-messages.service.js';
import { OcppGateway } from './ocpp.gateway.js';
import { ReservationsService } from './reservations.service.js';

@Module({
  imports: [AlertsModule, SessionsModule],
  providers: [
    ConnectionRegistry,
    ChargerStateService,
    CommandsService,
    ConfigurationService,
    OcppMessagesService,
    OcppGateway,
    LivenessService,
    ReservationsService,
    LocalListService,
  ],
  exports: [
    ConnectionRegistry,
    ChargerStateService,
    CommandsService,
    ConfigurationService,
    OcppMessagesService,
    OcppGateway,
    ReservationsService,
    LocalListService,
  ],
})
export class OcppModule {}
