import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { inPeakWindow, minuteOfDay, price } from '../billing/pricing.js';
import type { Prisma, Tariff } from '../generated/prisma/client.js';
import { ChargerStateService } from '../ocpp/charger-state.service.js';
import { CommandsService } from '../ocpp/commands.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import type { DriverContext } from './driver-auth.js';
import {
  DriverMeDto,
  HistoryDto,
  LiveSessionDto,
  StartResultDto,
  StationDto,
  UpdateDriverDto,
} from './dto/driver.dto.js';

const siteInclude = {
  chargers: {
    where: { approval: 'ACCEPTED' },
    include: {
      evses: {
        orderBy: { evseId: 'asc' },
        include: { connectors: { orderBy: { connectorId: 'asc' } } },
      },
    },
    orderBy: { chargePointId: 'asc' },
  },
  tariffs: { include: { tariff: true } },
} satisfies Prisma.SiteInclude;

type SiteWithChargers = Prisma.SiteGetPayload<{ include: typeof siteInclude }>;

/** The driver app's backend: what a driver sees and does, always scoped to their own data. */
@Injectable()
export class DriverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: CommandsService,
    private readonly state: ChargerStateService,
    private readonly sessions: SessionsService,
  ) {}

  async me(d: DriverContext): Promise<DriverMeDto> {
    const driver = await this.prisma.driver.findUniqueOrThrow({
      where: { id: d.driverId },
      include: {
        wallet: true,
        idTokens: {
          where: { active: true, NOT: { uid: { startsWith: 'APP-' } } },
        },
        workspace: { select: { name: true } },
      },
    });
    return {
      id: driver.id,
      name: driver.name,
      phone: driver.phone,
      plugTypes: driver.plugTypes,
      autoStopKobo: driver.autoStopKobo,
      walletKobo: driver.wallet?.balanceKobo ?? null,
      cards: driver.idTokens.map((t) => t.uid),
      operator: driver.workspace.name,
    };
  }

  async update(d: DriverContext, dto: UpdateDriverDto) {
    await this.prisma.driver.update({
      where: { id: d.driverId },
      data: {
        name: dto.name,
        plugTypes: dto.plugTypes,
        autoStopKobo: dto.autoStopKobo,
      },
    });
    return this.me(d);
  }

  /** Links a printed RFID card. A card already linked to another driver can't be taken. */
  async linkCard(d: DriverContext, rawUid: string) {
    const hex = rawUid.replace(/:/g, '').toUpperCase();
    const uid = hex.match(/.{2}/g)!.join(':');
    const card = await this.prisma.idToken.findUnique({
      where: { workspaceId_uid: { workspaceId: d.workspaceId, uid } },
    });
    if (card && card.driverId && card.driverId !== d.driverId) {
      throw new ConflictException(
        'This card is linked to another account. Contact the operator if it is yours.',
      );
    }
    if (card) {
      await this.prisma.idToken.update({
        where: { id: card.id },
        data: { driverId: d.driverId, active: true },
      });
    } else {
      await this.prisma.idToken.create({
        data: { workspaceId: d.workspaceId, uid, driverId: d.driverId },
      });
    }
    return this.me(d);
  }

  async stations(d: DriverContext): Promise<StationDto[]> {
    const [sites, driver] = await Promise.all([
      this.prisma.site.findMany({
        where: {
          workspaceId: d.workspaceId,
          chargers: { some: { approval: 'ACCEPTED' } },
        },
        include: siteInclude,
        orderBy: { name: 'asc' },
      }),
      this.prisma.driver.findUniqueOrThrow({ where: { id: d.driverId } }),
    ]);
    return sites.map((site) => this.station(site, driver.fleetId));
  }

  async stationById(d: DriverContext, siteId: string): Promise<StationDto> {
    const site = await this.prisma.site.findFirst({
      where: { id: siteId, workspaceId: d.workspaceId },
      include: siteInclude,
    });
    if (!site) throw new NotFoundException('Station not found.');
    const driver = await this.prisma.driver.findUniqueOrThrow({
      where: { id: d.driverId },
    });
    return this.station(site, driver.fleetId);
  }

  /** For "Start by QR code" and "Enter charger ID instead": the charger's station. */
  async byCode(d: DriverContext, chargePointId: string): Promise<StationDto> {
    const charger = await this.prisma.charger.findFirst({
      where: {
        workspaceId: d.workspaceId,
        chargePointId: { equals: chargePointId.trim(), mode: 'insensitive' },
        approval: 'ACCEPTED',
      },
      select: { siteId: true, chargePointId: true },
    });
    if (!charger) {
      throw new NotFoundException(
        `No charger called ${chargePointId.trim().toUpperCase()}. Check the ID printed under the QR code.`,
      );
    }
    const station = await this.stationById(d, charger.siteId);
    // Only that charger's connectors: the driver scanned one charger, not the site
    station.connectors = station.connectors.filter(
      (c) => c.chargePointId === charger.chargePointId,
    );
    return station;
  }

  /** Remote start with the driver's app token. Sent now or refused; never queued. */
  async start(
    d: DriverContext,
    chargerId: string,
    evseId: number,
  ): Promise<StartResultDto> {
    const [driver, charger] = await Promise.all([
      this.prisma.driver.findUniqueOrThrow({ where: { id: d.driverId } }),
      this.prisma.charger.findFirst({
        where: {
          id: chargerId,
          workspaceId: d.workspaceId,
          approval: 'ACCEPTED',
        },
        include: { evses: { include: { connectors: true } }, site: true },
      }),
    ]);
    if (!charger) throw new NotFoundException('Charger not found.');
    if (driver.status !== 'ACTIVE') {
      throw new ForbiddenException(
        driver.status === 'BLOCKED'
          ? 'Your account is blocked. Contact the operator.'
          : 'Settle your unpaid session before starting a new one.',
      );
    }
    const active = await this.prisma.session.findFirst({
      where: { driverId: d.driverId, endedAt: null },
    });
    if (active) {
      throw new ConflictException(
        `You already have a session running (${active.reference}).`,
      );
    }
    const evse = charger.evses.find((e) => e.evseId === evseId);
    if (!evse)
      throw new NotFoundException(
        `${charger.chargePointId} has no EVSE ${evseId}.`,
      );
    const busy = evse.connectors.find(
      (c) => !['AVAILABLE', 'RESERVED'].includes(c.status),
    );
    if (busy && charger.status !== 'OFFLINE') {
      throw new ConflictException(
        `EVSE ${evseId} is ${busy.status.toLowerCase()}. Choose another connector.`,
      );
    }

    const token = await this.appToken(d);
    const result = await this.commands.sendNow(
      charger.id,
      'remote-start',
      { evseId, idTag: token },
      `driver:${d.driverId}`,
    );
    const where = `${charger.chargePointId} · EVSE ${evseId}`;
    switch (result.outcome) {
      case 'ACCEPTED':
        return {
          outcome: 'ACCEPTED',
          title: 'Charging started',
          message: `The charger accepted the start. ${where}.`,
        };
      case 'OFFLINE':
        return {
          outcome: 'OFFLINE',
          title: `${charger.site.name} is offline`,
          message:
            'This charger is not checked in, so it cannot start a session from the app. An RFID card may still work on site.',
        };
      case 'NO_RESPONSE':
        return {
          outcome: 'NO_RESPONSE',
          title: 'The charger did not respond',
          message: `We asked ${charger.chargePointId} to start but heard nothing back for 30 seconds. Check the cable is pushed all the way in, then try again.`,
        };
      case 'REJECTED':
        return {
          outcome: 'REJECTED',
          title: 'The charger refused to start',
          message: `${charger.chargePointId} replied ${result.reply}. Check the cable is plugged in, or choose another connector.`,
        };
    }
  }

  async stop(d: DriverContext, sessionId: string) {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, driverId: d.driverId },
      include: { connector: { include: { evse: true } } },
    });
    if (!session) throw new NotFoundException('Session not found.');
    if (session.endedAt)
      throw new ConflictException('This session has already ended.');
    const result = await this.commands.sendNow(
      session.chargerId,
      'remote-stop',
      {
        evseId: session.connector?.evse.evseId ?? 1,
        transactionId: session.transactionId,
      },
      `driver:${d.driverId}`,
    );
    if (result.outcome !== 'ACCEPTED') {
      throw new ConflictException(
        result.outcome === 'OFFLINE'
          ? 'The charger is offline. Stop it on the charger, or unplug.'
          : 'The charger did not stop. Try again, or stop it on the charger.',
      );
    }
    return { outcome: 'ACCEPTED' };
  }

  /** The driver's running session, or the latest one if it ended in the last minutes. */
  async live(d: DriverContext): Promise<LiveSessionDto | null> {
    const session = await this.prisma.session.findFirst({
      where: {
        driverId: d.driverId,
        OR: [
          { endedAt: null },
          { endedAt: { gt: new Date(Date.now() - 10 * 60_000) } },
        ],
      },
      orderBy: { startedAt: 'desc' },
      include: {
        charger: { include: { site: true } },
        connector: { include: { evse: true } },
        tariff: true,
        driver: { select: { autoStopKobo: true } },
        samples: { orderBy: { at: 'desc' }, take: 1 },
        workspace: { select: { timeZone: true } },
      },
    });
    if (!session) return null;
    const running = !session.endedAt;
    const minutes = (to: Date) =>
      Math.max(
        0,
        Math.round((to.getTime() - session.startedAt.getTime()) / 60_000),
      );
    const cost =
      running && session.tariff
        ? price(session.tariff, {
            energyWh: session.energyWh,
            chargingMinutes: minutes(session.chargingEndedAt ?? new Date()),
            pluggedMinutes: minutes(new Date()),
            atPeak: inPeakWindow(
              session.tariff,
              minuteOfDay(session.startedAt, session.workspace.timeZone),
            ),
          }).totalKobo
        : session.amountKobo;
    return {
      id: session.id,
      reference: session.reference,
      status: session.status,
      stationName: session.charger.site.name,
      chargePointId: session.charger.chargePointId,
      evseId: session.connector?.evse.evseId ?? 1,
      connectorType: session.connector?.type ?? null,
      startedAt: session.startedAt.toISOString(),
      endedAt: session.endedAt?.toISOString() ?? null,
      energyWh: session.energyWh,
      powerW: running ? this.state.powerOf(session.chargerId) : null,
      socPct: session.samples[0]?.socPct ?? null,
      costKobo: cost,
      autoStopKobo: session.driver?.autoStopKobo ?? null,
      idle: running && session.chargingEndedAt !== null,
    };
  }

  async history(d: DriverContext): Promise<HistoryDto> {
    const [sessions, workspace] = await Promise.all([
      this.prisma.session.findMany({
        where: { driverId: d.driverId },
        orderBy: { startedAt: 'desc' },
        take: 100,
        include: { charger: { include: { site: true } }, connector: true },
      }),
      this.prisma.workspace.findUniqueOrThrow({
        where: { id: d.workspaceId },
        select: { timeZone: true },
      }),
    ]);
    const monthOf = (date: Date) =>
      date.toLocaleDateString('en-GB', {
        month: 'long',
        year: 'numeric',
        timeZone: workspace.timeZone,
      });
    const thisMonth = monthOf(new Date());
    const inMonth = sessions.filter(
      (s) => s.endedAt && monthOf(s.startedAt) === thisMonth,
    );
    return {
      month: new Date().toLocaleDateString('en-GB', {
        month: 'long',
        timeZone: workspace.timeZone,
      }),
      monthEnergyWh: inMonth.reduce((a, s) => a + s.energyWh, 0),
      monthAmountKobo: inMonth
        .filter((s) => s.status !== 'REFUNDED')
        .reduce((a, s) => a + s.amountKobo, 0),
      sessions: sessions.map((s) => ({
        id: s.id,
        reference: s.reference,
        stationName: s.charger.site.name,
        connectorType: s.connector?.type ?? null,
        startedAt: s.startedAt.toISOString(),
        endedAt: s.endedAt?.toISOString() ?? null,
        energyWh: s.energyWh,
        amountKobo: s.amountKobo,
        status: s.status,
      })),
    };
  }

  /** Receipt: the console's session detail, for the driver's own sessions only. */
  async receipt(d: DriverContext, sessionId: string) {
    const own = await this.prisma.session.findFirst({
      where: { id: sessionId, driverId: d.driverId },
      select: { id: true },
    });
    if (!own) throw new NotFoundException('Session not found.');
    return this.sessions.detailInWorkspace(d.workspaceId, sessionId);
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  /** Each driver gets one app token (APP-…) that remote starts are sent with. */
  private async appToken(d: DriverContext) {
    const uid = `APP-${d.driverId.replace(/-/g, '').slice(0, 12).toUpperCase()}`;
    await this.prisma.idToken.upsert({
      where: { workspaceId_uid: { workspaceId: d.workspaceId, uid } },
      create: { workspaceId: d.workspaceId, uid, driverId: d.driverId },
      update: { active: true },
    });
    return uid;
  }

  private station(site: SiteWithChargers, fleetId: string | null): StationDto {
    const connectors = site.chargers.flatMap((c) =>
      c.evses.flatMap((e) =>
        e.connectors.map((k) => ({
          chargerId: c.id,
          chargePointId: c.chargePointId,
          evseId: e.evseId,
          type: k.type,
          maxKw: k.maxPowerW / 1000,
          // A charger that is offline or out of service makes all its connectors so
          status: ['OFFLINE', 'UNAVAILABLE', 'FAULTED'].includes(c.status)
            ? c.status
            : k.status,
        })),
      ),
    );
    const live = site.chargers.filter((c) => c.status !== 'OFFLINE');
    const lastSeen = Math.max(
      0,
      ...site.chargers.map((c) => c.lastSeenAt?.getTime() ?? 0),
    );
    const tariffs = site.tariffs
      .map((t) => t.tariff)
      .filter((t) => !t.archivedAt)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const tariff: Tariff | undefined =
      (fleetId ? tariffs.find((t) => t.fleetId === fleetId) : undefined) ??
      tariffs.find((t) => !t.fleetId);
    return {
      id: site.id,
      name: site.name,
      area: site.area,
      address: site.address,
      latitude: site.latitude,
      longitude: site.longitude,
      openingHours: site.openingHours,
      maxKw: Math.max(0, ...connectors.map((c) => c.maxKw)),
      free: connectors.filter((c) => c.status === 'AVAILABLE').length,
      offline: live.length === 0,
      offlineMinutes:
        live.length === 0 && lastSeen > 0
          ? Math.floor((Date.now() - lastSeen) / 60_000)
          : null,
      price: tariff
        ? {
            name: tariff.name,
            perKwhKobo: tariff.perKwhKobo,
            sessionFeeKobo: tariff.sessionFeeKobo,
            idleGraceMin: tariff.idleGraceMin,
            idlePerMinuteKobo: tariff.idlePerMinuteKobo,
            peakFrom: tariff.peakFrom,
            peakTo: tariff.peakTo,
            peakSurchargeBps: tariff.peakSurchargeBps,
          }
        : null,
      connectors,
    };
  }
}
