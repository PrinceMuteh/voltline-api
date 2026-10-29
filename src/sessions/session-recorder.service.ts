import { Injectable, Logger } from '@nestjs/common';
import { inPeakWindow, minuteOfDay, price } from '../billing/pricing.js';
import { Prisma, type Session } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';

/** Who and where, as the gateway knows it from the socket handshake. */
export interface ChargerRef {
  chargerId: string;
  workspaceId: string;
}

export interface MeterReading {
  at: Date;
  /** Raw energy register (Energy.Active.Import.Register), Wh. */
  registerWh?: number;
  powerW?: number;
  socPct?: number;
}

interface StartInput {
  transactionId: string;
  evseId?: number;
  at: Date;
  idTag?: string;
  meterStartWh?: number;
}

/** Stop reasons that mean the charger, not the driver, ended the session. */
const FAULT_REASONS = new Set([
  'EmergencyStop',
  'GroundFault',
  'OvercurrentFault',
  'OverheatFault',
  'PowerLoss',
  'PowerQuality',
  'ImmediateReset',
  'HardReset',
]);

/** First reference when the database has no sessions yet (the designs continue from here). */
const FIRST_REFERENCE = 10_474;

/**
 * Turns transaction traffic from either protocol into Session rows. Every write is
 * idempotent: events are keyed (2.0.1 seqNo, 1.6J timestamps), meter samples by time, and
 * a session is settled once. A charger replaying its queue after a reconnect changes nothing.
 */
type BudgetHandler = (session: Session, evseId: number) => Promise<void>;

@Injectable()
export class SessionRecorder {
  private readonly logger = new Logger(SessionRecorder.name);
  private budgetHandler?: BudgetHandler;
  /** Sessions already asked to stop for their budget, so the stop is sent once. */
  private readonly budgetStopped = new Set<string>();

  /** The commands service registers how to stop a session (it owns the sockets). */
  onBudgetReached(handler: BudgetHandler) {
    this.budgetHandler = handler;
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /** Finds the session for this transaction, or opens it (also for events that arrive before Started). */
  async ensure(c: ChargerRef, input: StartInput): Promise<Session> {
    const existing = await this.prisma.session.findUnique({
      where: {
        chargerId_transactionId: {
          chargerId: c.chargerId,
          transactionId: input.transactionId,
        },
      },
    });
    if (existing) {
      // An earlier-timestamped event (offline replay out of order) moves the start back
      if (input.at < existing.startedAt) {
        return this.prisma.session.update({
          where: { id: existing.id },
          data: { startedAt: input.at },
        });
      }
      return existing;
    }

    const charger = await this.prisma.charger.findUniqueOrThrow({
      where: { id: c.chargerId },
      include: { evses: { include: { connectors: true } } },
    });
    const connector = charger.evses
      .find((e) => e.evseId === (input.evseId ?? 1))
      ?.connectors.at(0);
    const token = input.idTag
      ? await this.prisma.idToken.findUnique({
          where: {
            workspaceId_uid: { workspaceId: c.workspaceId, uid: input.idTag },
          },
          include: { driver: { select: { fleetId: true } } },
        })
      : null;
    const fleetId = token?.fleetId ?? token?.driver?.fleetId ?? null;
    const tariff = await this.tariffFor(c.workspaceId, charger.siteId, fleetId);

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const session = await this.prisma.session.create({
          data: {
            workspaceId: c.workspaceId,
            reference: await this.nextReference(),
            chargerId: c.chargerId,
            connectorId: connector?.id,
            transactionId: input.transactionId,
            startedAt: input.at,
            idTag: input.idTag,
            idTokenId: token?.id,
            driverId: token?.driverId,
            fleetId,
            tariffId: tariff?.id,
            meterStartWh: input.meterStartWh,
          },
        });
        this.changed(c, session.id);
        await this.closeSuperseded(c, session);
        return session;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // Either the same transaction raced in, or the reference was taken: look again
        const raced = await this.prisma.session.findUnique({
          where: {
            chargerId_transactionId: {
              chargerId: c.chargerId,
              transactionId: input.transactionId,
            },
          },
        });
        if (raced) return raced;
      }
    }
    throw new Error(`Could not open a session for ${input.transactionId}`);
  }

  /** Stores an event once. Returns false when this key was already recorded (a replay). */
  async event(
    session: Session,
    key: string,
    type: string,
    at: Date,
    detail?: string,
  ): Promise<boolean> {
    try {
      await this.prisma.sessionEvent.create({
        data: { sessionId: session.id, idempotencyKey: key, type, at, detail },
      });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  /** Stores meter readings (one per timestamp) and recomputes the session's energy. */
  async meter(c: ChargerRef, session: Session, readings: MeterReading[]) {
    // Samples are kept by their energy register; power and SoC ride along when present
    const withRegister = readings.filter((r) => r.registerWh !== undefined);
    if (withRegister.length === 0) {
      return session;
    }
    const { count } = await this.prisma.meterSample.createMany({
      data: withRegister.map((r) => ({
        sessionId: session.id,
        at: r.at,
        energyWh: r.registerWh!,
        powerW: r.powerW,
        socPct: r.socPct,
      })),
      skipDuplicates: true,
    });
    if (count === 0) {
      return session;
    }
    const updated = await this.recomputeEnergy(session);
    this.realtime.toWorkspace(c.workspaceId, 'session.meter', {
      sessionId: session.id,
      energyWh: updated.energyWh,
    });
    if (!updated.endedAt && updated.driverId) {
      await this.checkBudget(c, updated);
    }
    // A late reading for a session that already ended (out-of-order replay) re-prices it
    return updated.endedAt ? this.settle(c, updated) : updated;
  }

  /** The car stopped drawing power (SuspendedEV, EVConnected): idle time starts here. */
  async chargingEnded(c: ChargerRef, session: Session, at: Date) {
    if (session.chargingEndedAt && session.chargingEndedAt <= at)
      return session;
    const updated = await this.prisma.session.update({
      where: { id: session.id },
      data: { chargingEndedAt: at },
    });
    this.changed(c, session.id);
    return updated;
  }

  /** Charging resumed after a pause: the earlier "finished" time no longer applies. */
  async chargingResumed(c: ChargerRef, session: Session, at: Date) {
    if (
      !session.chargingEndedAt ||
      session.chargingEndedAt > at ||
      session.endedAt
    ) {
      return session;
    }
    return this.prisma.session.update({
      where: { id: session.id },
      data: { chargingEndedAt: null },
    });
  }

  /** The transaction ended. Settles once; a replayed end changes nothing. */
  async end(
    c: ChargerRef,
    session: Session,
    at: Date,
    reason: string | undefined,
  ) {
    if (session.endedAt) return session;
    const ended = await this.prisma.session.update({
      where: { id: session.id },
      data: {
        endedAt: at,
        stopReason: reason ?? 'Local',
        status:
          reason && FAULT_REASONS.has(reason)
            ? 'STOPPED_BY_FAULT'
            : 'COMPLETED',
      },
    });
    return this.settle(c, ended);
  }

  /** The active session on a charger's EVSE, for 1.6J status changes and meter values without a tx id. */
  async activeOn(chargerId: string, evseId: number) {
    return this.prisma.session.findFirst({
      where: {
        chargerId,
        endedAt: null,
        connector: { evse: { evseId } },
      },
      orderBy: { startedAt: 'desc' },
    });
  }

  async byTransaction(chargerId: string, transactionId: string) {
    return this.prisma.session.findUnique({
      where: { chargerId_transactionId: { chargerId, transactionId } },
    });
  }

  /** 1.6J: the charger asks us for a transaction id. A replayed StartTransaction gets the same one. */
  async startTransaction16(
    c: ChargerRef,
    input: Omit<StartInput, 'transactionId'> & { evseId: number },
  ) {
    const replay = await this.prisma.session.findFirst({
      where: {
        chargerId: c.chargerId,
        startedAt: input.at,
        connector: { evse: { evseId: input.evseId } },
      },
    });
    if (replay) return replay;
    const [{ next }] = await this.prisma.$queryRaw<{ next: number }[]>`
      SELECT COALESCE(MAX("transactionId"::int), 0) + 1 AS next
      FROM "Session"
      WHERE "chargerId" = ${c.chargerId} AND "transactionId" ~ '^[0-9]{1,9}$'`;
    return this.ensure(c, { ...input, transactionId: String(next) });
  }

  /**
   * An EVSE runs one transaction at a time, so an older session still open on it lost its end
   * (the charger rebooted or was replaced). Close it at its last reading and bill what it delivered.
   */
  private async closeSuperseded(c: ChargerRef, session: Session) {
    if (!session.connectorId) return;
    const stale = await this.prisma.session.findMany({
      where: {
        chargerId: c.chargerId,
        connectorId: session.connectorId,
        endedAt: null,
        id: { not: session.id },
        startedAt: { lt: session.startedAt },
      },
      include: { samples: { orderBy: { at: 'desc' }, take: 1 } },
    });
    for (const old of stale) {
      const at = old.samples[0]?.at ?? old.startedAt;
      await this.event(
        old,
        'superseded',
        'Ended',
        at,
        `Closed: ${session.reference} started on this EVSE without this one ending`,
      );
      await this.end(c, old, at, 'Other');
      this.logger.warn(
        `${old.reference} closed: superseded by ${session.reference}`,
      );
    }
  }

  /** Auto-stop: once the running cost reaches the driver's budget, ask the charger to stop. */
  private async checkBudget(c: ChargerRef, session: Session) {
    if (!this.budgetHandler || this.budgetStopped.has(session.id)) return;
    const [driver, tariff, workspace, connector] = await Promise.all([
      this.prisma.driver.findUnique({
        where: { id: session.driverId! },
        select: { autoStopKobo: true },
      }),
      session.tariffId
        ? this.prisma.tariff.findUnique({ where: { id: session.tariffId } })
        : null,
      this.prisma.workspace.findUniqueOrThrow({
        where: { id: c.workspaceId },
        select: { timeZone: true },
      }),
      session.connectorId
        ? this.prisma.connector.findUnique({
            where: { id: session.connectorId },
            include: { evse: true },
          })
        : null,
    ]);
    if (!driver?.autoStopKobo || !tariff) return;
    const minutes = Math.round(
      (Date.now() - session.startedAt.getTime()) / 60_000,
    );
    const cost = price(tariff, {
      energyWh: session.energyWh,
      chargingMinutes: minutes,
      pluggedMinutes: minutes,
      atPeak: inPeakWindow(
        tariff,
        minuteOfDay(session.startedAt, workspace.timeZone),
      ),
    }).totalKobo;
    if (cost < driver.autoStopKobo) return;
    this.budgetStopped.add(session.id);
    await this.event(
      session,
      'budget',
      'BudgetReached',
      new Date(),
      `Auto-stop at ₦${(driver.autoStopKobo / 100).toLocaleString('en-NG')}`,
    );
    await this.budgetHandler(session, connector?.evse.evseId ?? 1).catch(
      (error: unknown) =>
        this.logger.warn(`Auto-stop ${session.reference}: ${String(error)}`),
    );
  }

  /** Prices an ended session with its tariff version and stores the breakdown. */
  private async settle(c: ChargerRef, session: Session) {
    const [tariff, workspace] = await Promise.all([
      session.tariffId
        ? this.prisma.tariff.findUnique({ where: { id: session.tariffId } })
        : null,
      this.prisma.workspace.findUniqueOrThrow({
        where: { id: c.workspaceId },
        select: { timeZone: true },
      }),
    ]);
    const endedAt = session.endedAt!;
    const minutes = (to: Date) =>
      Math.max(
        0,
        Math.round((to.getTime() - session.startedAt.getTime()) / 60_000),
      );
    const usage = {
      energyWh: session.energyWh,
      chargingMinutes: minutes(session.chargingEndedAt ?? endedAt),
      pluggedMinutes: minutes(endedAt),
      atPeak: tariff
        ? inPeakWindow(
            tariff,
            minuteOfDay(session.startedAt, workspace.timeZone),
          )
        : false,
      stoppedByFault: session.status === 'STOPPED_BY_FAULT',
    };
    const billing = tariff ? price(tariff, usage) : null;
    if (!tariff) {
      this.logger.warn(`Session ${session.reference} has no tariff; billed ₦0`);
    }
    const settled = await this.prisma.session.update({
      where: { id: session.id },
      data: {
        amountKobo: billing?.totalKobo ?? 0,
        billing: billing ? { ...billing, usage } : Prisma.DbNull,
      },
    });
    this.changed(c, session.id);
    return settled;
  }

  private async recomputeEnergy(session: Session) {
    const agg = await this.prisma.meterSample.aggregate({
      where: { sessionId: session.id },
      _min: { energyWh: true },
      _max: { energyWh: true },
    });
    const start = session.meterStartWh ?? agg._min.energyWh ?? 0;
    const energyWh = Math.max(0, (agg._max.energyWh ?? start) - start);
    return this.prisma.session.update({
      where: { id: session.id },
      data: { energyWh },
    });
  }

  /**
   * The fleet's own tariff if one covers this site, otherwise the site's public tariff.
   * Versions keep their tariff's original createdAt, so the oldest public tariff stays first.
   */
  private async tariffFor(
    workspaceId: string,
    siteId: string,
    fleetId: string | null,
  ) {
    const candidates = await this.prisma.tariff.findMany({
      where: {
        workspaceId,
        archivedAt: null,
        sites: { some: { siteId } },
        OR: [{ fleetId: null }, ...(fleetId ? [{ fleetId }] : [])],
      },
      orderBy: { createdAt: 'asc' },
    });
    return (
      candidates.find((t) => t.fleetId === fleetId && fleetId) ??
      candidates.find((t) => !t.fleetId)
    );
  }

  private async nextReference() {
    const [{ max }] = await this.prisma.$queryRaw<{ max: number | null }[]>`
      SELECT MAX(SUBSTRING(reference FROM 3)::int) AS max FROM "Session" WHERE reference ~ '^S-[0-9]+$'`;
    return `S-${(max ?? FIRST_REFERENCE - 1) + 1}`;
  }

  private changed(c: ChargerRef, sessionId: string) {
    this.realtime.toWorkspace(c.workspaceId, 'session.updated', { sessionId });
  }
}

function isUniqueViolation(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
