import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import type { AuthContext } from '../auth/auth.decorators.js';
import type { Prisma } from '../generated/prisma/client.js';
import { ChargerStateService } from '../ocpp/charger-state.service.js';
import { ConnectionRegistry } from '../ocpp/connection-registry.js';
import { OcppGateway } from '../ocpp/ocpp.gateway.js';
import { OcppMessagesService } from '../ocpp/ocpp-messages.service.js';
import { ReservationsService } from '../ocpp/reservations.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';
import {
  ChargerDetailDto,
  ChargerRowDto,
  ConnectorInputDto,
  CreateChargerDto,
  CreatedChargerDto,
  MessageSearchDto,
  NetworkDto,
  UpdateChargerDto,
} from './dto/charger.dto.js';

const withRelations = {
  site: { select: { id: true, name: true } },
  evses: {
    orderBy: { evseId: 'asc' },
    include: { connectors: { orderBy: { connectorId: 'asc' } } },
  },
} satisfies Prisma.ChargerInclude;

type ChargerWithRelations = Prisma.ChargerGetPayload<{
  include: typeof withRelations;
}>;

/** ChargerRowDto as a plain object type, so spreading it keeps every field. */
type ChargerRow = { [K in keyof ChargerRowDto]: ChargerRowDto[K] };

const CONNECTOR_LABEL = { CCS2: 'CCS2', TYPE2: 'Type 2', CHADEMO: 'CHAdeMO' };
const PROTOCOL_LABEL = { OCPP16J: '1.6J', OCPP201: '2.0.1', OCPP21: '2.1' };

@Injectable()
export class ChargersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly registry: ConnectionRegistry,
    private readonly state: ChargerStateService,
    private readonly messages: OcppMessagesService,
    private readonly gateway: OcppGateway,
    private readonly realtime: RealtimeGateway,
    private readonly reservations: ReservationsService,
  ) {}

  async list(auth: AuthContext): Promise<ChargerRowDto[]> {
    const chargers = await this.prisma.charger.findMany({
      where: { workspaceId: auth.workspaceId },
      include: withRelations,
      orderBy: { chargePointId: 'asc' },
    });
    return chargers.map((c) => this.row(c));
  }

  async detail(auth: AuthContext, id: string): Promise<ChargerDetailDto> {
    const charger = await this.find(auth, id);
    const tariff = await this.prisma.tariff.findFirst({
      where: {
        workspaceId: auth.workspaceId,
        archivedAt: null,
        sites: { some: { siteId: charger.siteId } },
      },
      orderBy: { createdAt: 'asc' },
      select: { name: true, perKwhKobo: true },
    });
    const active = await this.prisma.session.findMany({
      where: { chargerId: charger.id, endedAt: null },
      include: { connector: { include: { evse: true } } },
      orderBy: { startedAt: 'asc' },
    });
    return {
      ...this.row(charger),
      activeSessions: active.map((s) => ({
        id: s.id,
        reference: s.reference,
        evseId: s.connector?.evse.evseId ?? 1,
        startedAt: s.startedAt.toISOString(),
        energyWh: s.energyWh,
      })),
      reservations: await this.reservations.active(auth, charger.id),
      localListVersion: charger.localListVersion,
      localListSyncedAt: charger.localListSyncedAt?.toISOString() ?? null,
      firmwareVersion: charger.firmwareVersion,
      securityProfile: charger.securityProfile,
      ocppUrl: `${this.ocppBaseUrl()}/${encodeURIComponent(charger.chargePointId)}`,
      evses: charger.evses.map((e) => ({
        evseId: e.evseId,
        connectors: e.connectors.map((c) => ({
          connectorId: c.connectorId,
          type: c.type,
          maxPowerW: c.maxPowerW,
          status: c.status,
        })),
      })),
      tariff,
    };
  }

  /** The next free CP-00NN after this workspace's highest ID. IDs are unique platform-wide. */
  async nextId(auth: AuthContext) {
    const ids = await this.prisma.charger.findMany({
      where: { workspaceId: auth.workspaceId },
      select: { chargePointId: true },
    });
    let n = Math.max(
      0,
      ...ids.map((c) => Number(/^CP-(\d+)$/.exec(c.chargePointId)?.[1] ?? 0)),
    );
    for (;;) {
      n += 1;
      const candidate = `CP-${String(n).padStart(4, '0')}`;
      const taken = await this.prisma.charger.findUnique({
        where: { chargePointId: candidate },
        select: { id: true },
      });
      if (!taken) {
        return { chargePointId: candidate };
      }
    }
  }

  async create(
    auth: AuthContext,
    dto: CreateChargerDto,
  ): Promise<CreatedChargerDto> {
    const taken = await this.prisma.charger.findUnique({
      where: { chargePointId: dto.chargePointId },
      select: { id: true },
    });
    if (taken) {
      throw new ConflictException(
        `${dto.chargePointId} is already registered. Charge point IDs are unique across Voltline; choose another.`,
      );
    }
    const siteId = await this.resolveSite(auth, dto);
    const password = newPassword();

    const charger = await this.prisma.charger.create({
      data: {
        workspaceId: auth.workspaceId,
        siteId,
        chargePointId: dto.chargePointId,
        vendor: dto.vendor || null,
        model: dto.model || null,
        evses: { create: evsesFrom(dto.connectors) },
        credentials: { create: { passwordHash: await argon2.hash(password) } },
      },
    });
    return { charger: await this.detail(auth, charger.id), password };
  }

  async update(
    auth: AuthContext,
    id: string,
    dto: UpdateChargerDto,
  ): Promise<ChargerDetailDto> {
    const charger = await this.find(auth, id);
    if (charger.approval !== 'PENDING') {
      throw new ConflictException(
        `${charger.chargePointId} is already live. Change its details from its page.`,
      );
    }
    const siteId =
      dto.siteId || dto.newSiteName
        ? await this.resolveSite(auth, dto)
        : undefined;
    await this.prisma.$transaction(async (tx) => {
      if (dto.connectors) {
        await tx.evse.deleteMany({ where: { chargerId: id } });
      }
      await tx.charger.update({
        where: { id },
        data: {
          siteId,
          vendor: dto.vendor,
          model: dto.model,
          evses: dto.connectors
            ? { create: evsesFrom(dto.connectors) }
            : undefined,
        },
      });
    });
    return this.detail(auth, id);
  }

  /** Revokes every current password and issues a new one. Open sockets stay up until they reconnect. */
  async rotatePassword(auth: AuthContext, id: string) {
    await this.find(auth, id);
    const password = newPassword();
    await this.prisma.$transaction([
      this.prisma.chargerCredential.updateMany({
        where: { chargerId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      this.prisma.chargerCredential.create({
        data: { chargerId: id, passwordHash: await argon2.hash(password) },
      }),
    ]);
    return { password };
  }

  async approve(auth: AuthContext, id: string): Promise<ChargerDetailDto> {
    const charger = await this.find(auth, id);
    if (charger.approval !== 'ACCEPTED') {
      await this.prisma.charger.update({
        where: { id },
        data: { approval: 'ACCEPTED' },
      });
      // A connected charger is still Pending on its side; have it boot again to get Accepted
      void this.gateway.requestBoot(id);
      this.realtime.toWorkspace(auth.workspaceId, 'charger.status', {
        chargerId: id,
      });
    }
    return this.detail(auth, id);
  }

  /** Cards that can be reserved for, with who holds them. */
  async idTokens(auth: AuthContext) {
    const cards = await this.prisma.idToken.findMany({
      where: { workspaceId: auth.workspaceId, active: true },
      include: {
        driver: { select: { name: true } },
        fleet: { select: { name: true } },
      },
      orderBy: { uid: 'asc' },
    });
    return cards.map((c) => ({
      id: c.id,
      uid: c.uid,
      holder: c.driver?.name ?? c.fleet?.name ?? null,
    }));
  }

  async searchMessages(auth: AuthContext, id: string, f: MessageSearchDto) {
    await this.find(auth, id);
    return this.messages.search(id, f);
  }

  async recentMessages(auth: AuthContext, id: string) {
    await this.find(auth, id);
    return this.messages.recent(id);
  }

  async connectCheck(auth: AuthContext, id: string) {
    await this.find(auth, id);
    return this.state.connectCheck(id);
  }

  async network(auth: AuthContext): Promise<NetworkDto> {
    const [approved, openAlerts] = await Promise.all([
      this.prisma.charger.findMany({
        where: { workspaceId: auth.workspaceId, approval: 'ACCEPTED' },
        select: { id: true },
      }),
      this.prisma.alert.count({
        where: { workspaceId: auth.workspaceId, resolvedAt: null },
      }),
    ]);
    return {
      socketsConnected: approved.filter((c) => this.registry.has(c.id)).length,
      chargers: approved.length,
      openAlerts,
    };
  }

  /** Workspace-scoped lookup; anything outside the workspace is a 404. */
  async find(auth: AuthContext, id: string): Promise<ChargerWithRelations> {
    const charger = await this.prisma.charger.findFirst({
      where: { id, workspaceId: auth.workspaceId },
      include: withRelations,
    });
    if (!charger) {
      throw new NotFoundException('Charger not found.');
    }
    return charger;
  }

  private row(c: ChargerWithRelations): ChargerRow {
    const first = c.evses[0]?.connectors[0];
    return {
      id: c.id,
      chargePointId: c.chargePointId,
      model: c.model,
      vendor: c.vendor,
      siteId: c.site.id,
      siteName: c.site.name,
      status: c.status,
      approval: c.approval,
      connector: first
        ? `${CONNECTOR_LABEL[first.type]} · ${first.maxPowerW / 1000} kW`
        : '–',
      powerW: this.state.powerOf(c.id),
      lastSeenAt: latest(this.state.lastMessageAt(c.id), c.lastSeenAt),
      protocol: c.protocol ? PROTOCOL_LABEL[c.protocol] : null,
      connected: this.registry.has(c.id),
    };
  }

  private async resolveSite(
    auth: AuthContext,
    dto: { siteId?: string; newSiteName?: string },
  ) {
    if (dto.newSiteName) {
      const existing = await this.prisma.site.findUnique({
        where: {
          workspaceId_name: {
            workspaceId: auth.workspaceId,
            name: dto.newSiteName,
          },
        },
      });
      if (existing) {
        return existing.id;
      }
      const site = await this.prisma.site.create({
        data: { workspaceId: auth.workspaceId, name: dto.newSiteName },
      });
      return site.id;
    }
    const site = dto.siteId
      ? await this.prisma.site.findFirst({
          where: { id: dto.siteId, workspaceId: auth.workspaceId },
        })
      : null;
    if (!site) {
      throw new UnprocessableEntityException(
        'Choose a site, or add a new one.',
      );
    }
    return site.id;
  }

  private ocppBaseUrl() {
    return (
      this.config.get<string>('OCPP_PUBLIC_URL') ?? 'ws://localhost:4000/ocpp'
    ).replace(/\/$/, '');
  }
}

function latest(a: Date | undefined, b: Date | null) {
  const newest = a && (!b || a > b) ? a : b;
  return newest?.toISOString() ?? null;
}

/** Each connector from Add a charger is its own EVSE (EVSE 1, EVSE 2 …) with connector 1. */
function evsesFrom(connectors: ConnectorInputDto[]) {
  return connectors.map((c, i) => ({
    evseId: i + 1,
    connectors: {
      create: { connectorId: 1, type: c.type, maxPowerW: c.maxKw * 1000 },
    },
  }));
}

/** 32 URL-safe characters; within OCPP 2.0.1's 16–40 character limit for BasicAuthPassword. */
function newPassword() {
  return randomBytes(24).toString('base64url');
}
