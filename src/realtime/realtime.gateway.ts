import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';

export interface TicketPayload {
  typ: 'rt';
  wid: string;
  mid: string;
}

/** Events the console listens for. Payloads stay small; the web app refetches what it shows. */
export type ConsoleEvent =
  | 'charger.status'
  | 'charger.power'
  | 'charger.message'
  | 'charger.connect_check'
  | 'alert.changed'
  | 'command.result'
  | 'session.updated'
  | 'session.meter';

/**
 * Live updates for the operator console. Each browser joins its workspace's room with a
 * short-lived ticket from POST /v1/console/realtime/ticket (the access cookie is httpOnly
 * and scoped to the web origin, so it cannot be read here).
 */
@WebSocketGateway({ namespace: 'console' })
export class RealtimeGateway implements OnGatewayConnection {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  private readonly server: Namespace;

  constructor(private readonly jwt: JwtService) {}

  async handleConnection(socket: Socket) {
    const ticket = (socket.handshake.auth as { ticket?: unknown }).ticket;
    try {
      if (typeof ticket !== 'string') {
        throw new Error('missing ticket');
      }
      const payload = await this.jwt.verifyAsync<TicketPayload>(ticket);
      if (payload.typ !== 'rt') {
        throw new Error('not a realtime ticket');
      }
      await socket.join(room(payload.wid));
    } catch (error) {
      this.logger.debug(`Refused console socket: ${String(error)}`);
      socket.emit('unauthorized');
      socket.disconnect(true);
    }
  }

  toWorkspace(workspaceId: string, event: ConsoleEvent, payload: object) {
    this.server?.to(room(workspaceId)).emit(event, payload);
  }
}

const room = (workspaceId: string) => `ws:${workspaceId}`;
