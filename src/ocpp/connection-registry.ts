import { Injectable } from '@nestjs/common';
import type { ChargerClient } from './ocpp.types.js';

/**
 * Open charger sockets on this instance, by charger id.
 * With several API instances this moves to Redis so a command reaches whichever one holds the socket.
 */
@Injectable()
export class ConnectionRegistry {
  private readonly clients = new Map<string, ChargerClient>();

  get(chargerId: string) {
    return this.clients.get(chargerId);
  }

  has(chargerId: string) {
    return this.clients.has(chargerId);
  }

  set(chargerId: string, client: ChargerClient) {
    this.clients.set(chargerId, client);
  }

  /** Only removes the entry if it still points at this client (a newer socket may have replaced it). */
  delete(chargerId: string, client: ChargerClient) {
    if (this.clients.get(chargerId) === client) {
      this.clients.delete(chargerId);
    }
  }

  connectedIds() {
    return [...this.clients.keys()];
  }
}
