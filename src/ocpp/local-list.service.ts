import {
  BadGatewayException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { AuthContext } from '../auth/auth.decorators.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';
import { ConnectionRegistry } from './connection-registry.js';

const TIMEOUT_MS = 30_000;

export interface LocalListResult {
  status: string;
  version: number;
  entries: number;
}

/**
 * Sends the workspace's active RFID cards to a charger (SendLocalList, OC-09), so cards keep
 * working while the charger is offline. Always a full list with a new version number.
 */
@Injectable()
export class LocalListService {
  private readonly logger = new Logger(LocalListService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectionRegistry,
    private readonly realtime: RealtimeGateway,
  ) {}

  async syncFromConsole(auth: AuthContext, chargerId: string) {
    const charger = await this.prisma.charger.findFirst({
      where: { id: chargerId, workspaceId: auth.workspaceId },
    });
    if (!charger) throw new NotFoundException('Charger not found.');
    if (!this.registry.has(chargerId)) {
      throw new ConflictException(
        `${charger.chargePointId} is not connected. The list is sent when it reconnects.`,
      );
    }
    return this.sync(chargerId);
  }

  /** Builds the list from active cards whose driver is not blocked, and sends it. */
  async sync(chargerId: string): Promise<LocalListResult> {
    const client = this.registry.get(chargerId);
    const charger = await this.prisma.charger.findUniqueOrThrow({
      where: { id: chargerId },
    });
    if (!client) throw new ConflictException('The charger is not connected.');
    const cards = await this.prisma.idToken.findMany({
      where: {
        workspaceId: charger.workspaceId,
        active: true,
        OR: [{ driverId: null }, { driver: { status: 'ACTIVE' } }],
      },
      orderBy: { uid: 'asc' },
    });
    const version = charger.localListVersion + 1;
    const v201 = client.session.protocol === 'ocpp2.0.1';
    let status: string;
    try {
      const res = (await client.call(
        'SendLocalList',
        v201
          ? {
              versionNumber: version,
              updateType: 'Full',
              localAuthorizationList: cards.map((c) => ({
                idToken: { idToken: c.uid, type: 'ISO14443' },
                idTokenInfo: { status: 'Accepted' },
              })),
            }
          : {
              listVersion: version,
              updateType: 'Full',
              localAuthorizationList: cards.map((c) => ({
                idTag: c.uid,
                idTagInfo: { status: 'Accepted' },
              })),
            },
        { callTimeoutMs: TIMEOUT_MS },
      )) as { status: string };
      status = res.status;
    } catch (error) {
      throw new BadGatewayException(
        `${charger.chargePointId} did not answer: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (status === 'Accepted') {
      await this.prisma.charger.update({
        where: { id: chargerId },
        data: { localListVersion: version, localListSyncedAt: new Date() },
      });
      this.realtime.toWorkspace(charger.workspaceId, 'charger.status', {
        chargerId,
      });
    } else {
      this.logger.warn(
        `${charger.chargePointId} answered SendLocalList with ${status}`,
      );
    }
    return {
      status,
      version: status === 'Accepted' ? version : charger.localListVersion,
      entries: cards.length,
    };
  }
}
