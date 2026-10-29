import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { RealtimeController } from './realtime.controller.js';
import { RealtimeGateway } from './realtime.gateway.js';

@Global()
@Module({
  imports: [AuthModule],
  controllers: [RealtimeController],
  providers: [RealtimeGateway],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
