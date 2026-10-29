import { Module } from '@nestjs/common';
import { SessionRecorder } from './session-recorder.service.js';
import { SessionsController } from './sessions.controller.js';
import { SessionsService } from './sessions.service.js';

@Module({
  controllers: [SessionsController],
  providers: [SessionRecorder, SessionsService],
  exports: [SessionRecorder],
})
export class SessionsModule {}
