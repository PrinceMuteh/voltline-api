import { Injectable, NotFoundException } from '@nestjs/common';
import type { AuthContext } from '../auth/auth.decorators.js';
import {
  inPeakWindow,
  minuteOfDay,
  price,
  type PriceBreakdown,
} from '../billing/pricing.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { SessionStatus } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  SessionDetailDto,
  SessionListDto,
  SessionRowDto,
  SessionsQueryDto,
  type Filter,
  type Range,
} from './dto/session.dto.js';
import { OPERATOR_ID_TAG } from '../ocpp/ocpp.types.js';

const MAX_ROWS = 500;

const rowInclude = {
  driver: {
    select: { name: true, fleetId: true, wallet: { select: { id: true } } },
  },
  charger: {
    select: {
      chargePointId: true,
      site: { select: { name: true, address: true, area: true } },
    },
  },
  tariff: true,
} satisfies Prisma.SessionInclude;

type SessionWithRow = Prisma.SessionGetPayload<{ include: typeof rowInclude }>;
/** SessionRowDto as a plain object type, so spreading it keeps every field. */
type SessionRow = { [K in keyof SessionRowDto]: SessionRowDto[K] };

const STATUSES_OF: Record<Exclude<Filter, 'all'>, SessionStatus[]> = {
  active: ['ACTIVE'],
  completed: ['COMPLETED', 'REFUNDED'],
  issues: ['STOPPED_BY_FAULT', 'PAYMENT_FAILED'],
};
const BILLED: SessionStatus[] = [
  'COMPLETED',
  'STOPPED_BY_FAULT',
  'PAYMENT_FAILED',
];

const TIMELINE_ORDER = [
  'Authorized',
  'Started',
  'EVFinished',
  'Ended',
  'PaymentFailed',
  'Refunded',
];
const TIMELINE_LABEL: Record<string, string> = {
  Authorized: 'Authorized',
  Started: 'Charging started',
  EVFinished: 'EV finished',
  Ended: 'Ended',
  PaymentFailed: 'Payment failed',
  Refunded: 'Refunded',
};

@Injectable()
export class SessionsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    auth: AuthContext,
    query: SessionsQueryDto,
  ): Promise<SessionListDto> {
    const timeZone = await this.timeZone(auth);
    const where = await this.whereFor(
      auth,
      query.range ?? '7d',
      timeZone,
      query.q,
    );

    const [inRange, rows] = await Promise.all([
      this.prisma.session.findMany({
        where,
        select: { status: true, energyWh: true, amountKobo: true },
      }),
      this.prisma.session.findMany({
        where: {
          ...where,
          ...(query.status && query.status !== 'all'
            ? { status: { in: STATUSES_OF[query.status] } }
            : {}),
        },
        include: rowInclude,
        orderBy: { startedAt: 'desc' },
        take: MAX_ROWS + 1,
      }),
    ]);

    const countOf = (statuses: SessionStatus[]) =>
      inRange.filter((s) => statuses.includes(s.status)).length;
    return {
      totals: {
        sessions: inRange.length,
        energyWh: inRange.reduce((sum, s) => sum + s.energyWh, 0),
        billedKobo: inRange
          .filter((s) => BILLED.includes(s.status))
          .reduce((sum, s) => sum + s.amountKobo, 0),
        needsReview: countOf(STATUSES_OF.issues),
      },
      counts: {
        all: inRange.length,
        active: countOf(STATUSES_OF.active),
        completed: countOf(STATUSES_OF.completed),
        issues: countOf(STATUSES_OF.issues),
      },
      rows: rows.slice(0, MAX_ROWS).map((s) => this.row(s, timeZone)),
      truncated: rows.length > MAX_ROWS,
    };
  }

  detail(auth: AuthContext, id: string): Promise<SessionDetailDto> {
    return this.detailInWorkspace(auth.workspaceId, id);
  }

  /** Also used by the driver app, which checks the session is the driver's own. */
  async detailInWorkspace(
    workspaceId: string,
    id: string,
  ): Promise<SessionDetailDto> {
    const session = await this.prisma.session.findFirst({
      where: { id, workspaceId },
      include: {
        ...rowInclude,
        samples: { orderBy: { at: 'asc' } },
        events: { orderBy: { at: 'asc' } },
        workspace: {
          select: { name: true, registeredCompanyName: true, timeZone: true },
        },
      },
    });
    if (!session) {
      throw new NotFoundException('Session not found.');
    }
    const timeZone = session.workspace.timeZone;
    const row = this.row(session, timeZone);

    // Power from the readings, or from energy deltas when a charger only reports the register
    const power = session.samples.map((sample, i) => {
      const prev = session.samples[i - 1];
      const derived =
        prev && sample.at > prev.at
          ? Math.round(
              ((sample.energyWh - prev.energyWh) * 3_600_000) /
                (sample.at.getTime() - prev.at.getTime()),
            )
          : 0;
      return {
        at: sample.at.toISOString(),
        powerW: Math.max(0, sample.powerW ?? derived),
        socPct: sample.socPct,
      };
    });

    const stored = session.billing as PriceBreakdown | null;
    const estimate = stored ? null : this.estimate(session, timeZone);
    const billing = stored
      ? { ...stored, final: true }
      : estimate
        ? { ...estimate, final: false }
        : null;

    const paymentFailure = session.events.find(
      (e) => e.type === 'PaymentFailed',
    );
    const issue =
      session.status === 'STOPPED_BY_FAULT'
        ? {
            kind: 'fault',
            title: 'Stopped by fault',
            text: `The charger stopped this session. ${session.charger.chargePointId} reported ${article(session.stopReason)}. Only the ${(session.energyWh / 1000).toFixed(1)} kWh delivered was billed.`,
          }
        : session.status === 'PAYMENT_FAILED'
          ? {
              kind: 'payment',
              title: 'Payment failed',
              text: `Card capture declined. ${paymentFailure?.detail ?? 'The payment gateway refused the capture.'} Retry, or the amount goes to collections after 3 attempts.`,
            }
          : null;

    return {
      ...row,
      stopReason: session.stopReason,
      chargingEndedAt: session.chargingEndedAt?.toISOString() ?? null,
      issue,
      power,
      peakPowerW: Math.max(0, ...power.map((p) => p.powerW)),
      timeline: session.events
        .filter((e) => TIMELINE_LABEL[e.type])
        // Same-second events keep their natural order: authorized, started, finished, ended
        .sort(
          (a, b) =>
            a.at.getTime() - b.at.getTime() ||
            TIMELINE_ORDER.indexOf(a.type) - TIMELINE_ORDER.indexOf(b.type),
        )
        .map((e) => ({
          at: e.at.toISOString(),
          label: TIMELINE_LABEL[e.type],
          detail: e.detail,
        })),
      billing,
      tariff: session.tariff
        ? {
            name: session.tariff.name,
            version: session.tariff.version,
            perKwhKobo: session.tariff.perKwhKobo,
            vatBps: session.tariff.vatBps,
            peakSurchargeBps: session.tariff.peakSurchargeBps,
          }
        : null,
      paymentMethod: session.fleetId
        ? 'Fleet invoice'
        : session.driver?.wallet
          ? 'Wallet'
          : 'Prepaid account',
      siteAddress: session.charger.site.address ?? session.charger.site.area,
      workspaceName: session.workspace.name,
      registeredCompanyName: session.workspace.registeredCompanyName,
    };
  }

  /** CSV of the same rows the table shows (range, filter and search applied), uncapped. */
  async csv(auth: AuthContext, query: SessionsQueryDto) {
    const timeZone = await this.timeZone(auth);
    const where = await this.whereFor(
      auth,
      query.range ?? '7d',
      timeZone,
      query.q,
    );
    const sessions = await this.prisma.session.findMany({
      where: {
        ...where,
        ...(query.status && query.status !== 'all'
          ? { status: { in: STATUSES_OF[query.status] } }
          : {}),
      },
      include: rowInclude,
      orderBy: { startedAt: 'desc' },
    });
    const local = (d: Date | null) =>
      d
        ? new Intl.DateTimeFormat('sv-SE', {
            dateStyle: 'short',
            timeStyle: 'short',
            timeZone,
          }).format(d)
        : '';
    const header = [
      'Session',
      'Driver',
      'Charger',
      'Site',
      'Started',
      'Ended',
      'Duration (min)',
      'Energy (kWh)',
      'Amount (NGN)',
      'Status',
      'Tariff',
    ];
    const lines = sessions.map((s) => {
      const row = this.row(s, timeZone);
      const end = s.endedAt ?? new Date();
      return [
        s.reference,
        row.driver,
        row.chargePointId,
        row.siteName,
        local(s.startedAt),
        local(s.endedAt),
        Math.round((end.getTime() - s.startedAt.getTime()) / 60_000),
        (s.energyWh / 1000).toFixed(1),
        (row.amountKobo / 100).toFixed(2),
        s.status,
        s.tariff ? `${s.tariff.name} v${s.tariff.version}` : '',
      ];
    });
    return (
      [header, ...lines]
        .map((cells) => cells.map(csvCell).join(','))
        .join('\r\n') + '\r\n'
    );
  }

  private row(s: SessionWithRow, timeZone: string): SessionRow {
    return {
      id: s.id,
      reference: s.reference,
      driver: driverLabel(s),
      chargerId: s.chargerId,
      chargePointId: s.charger.chargePointId,
      siteName: s.charger.site.name,
      startedAt: s.startedAt.toISOString(),
      endedAt: s.endedAt?.toISOString() ?? null,
      energyWh: s.energyWh,
      amountKobo:
        s.status === 'ACTIVE'
          ? (this.estimate(s, timeZone)?.totalKobo ?? 0)
          : s.amountKobo,
      status: s.status,
    };
  }

  /** What an active session would cost if it ended now, from the same pricing function. */
  private estimate(s: SessionWithRow, timeZone: string) {
    if (!s.tariff) return null;
    const now = s.endedAt ?? new Date();
    const minutes = (to: Date) =>
      Math.max(0, Math.round((to.getTime() - s.startedAt.getTime()) / 60_000));
    return price(s.tariff, {
      energyWh: s.energyWh,
      chargingMinutes: minutes(s.chargingEndedAt ?? now),
      pluggedMinutes: minutes(now),
      atPeak: inPeakWindow(s.tariff, minuteOfDay(s.startedAt, timeZone)),
      stoppedByFault: s.status === 'STOPPED_BY_FAULT',
    });
  }

  private async whereFor(
    auth: AuthContext,
    range: Range,
    timeZone: string,
    q: string | undefined,
  ): Promise<Prisma.SessionWhereInput> {
    const [unit, days] = {
      today: ['day', 0],
      '7d': ['day', 6],
      '30d': ['day', 29],
      month: ['month', 0],
    }[range] as ['day' | 'month', number];
    // Start of the range in the workspace's time zone
    const [{ start }] = await this.prisma.$queryRaw<{ start: Date }[]>`
      SELECT (date_trunc(${unit}, now() AT TIME ZONE ${timeZone}) - make_interval(days => ${days}::int))
             AT TIME ZONE ${timeZone} AS start`;
    // Card UIDs are stored as 04:A2:1C:9F; people type "04A2" or "04:A2", so search both forms
    const hex = q?.replace(/[\s:…]/g, '') ?? '';
    const cardForms = /^[0-9A-Fa-f]{2,}$/.test(hex)
      ? [q!, hex.match(/.{1,2}/g)!.join(':')]
      : [];
    const search = q
      ? {
          OR: [
            { reference: { contains: q, mode: 'insensitive' as const } },
            ...cardForms.map((form) => ({
              idTag: { contains: form, mode: 'insensitive' as const },
            })),
            { driver: { name: { contains: q, mode: 'insensitive' as const } } },
            { fleet: { name: { contains: q, mode: 'insensitive' as const } } },
            {
              charger: {
                chargePointId: { contains: q, mode: 'insensitive' as const },
              },
            },
          ],
        }
      : {};
    return {
      workspaceId: auth.workspaceId,
      startedAt: { gte: start },
      ...search,
    };
  }

  private async timeZone(auth: AuthContext) {
    const workspace = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: auth.workspaceId },
      select: { timeZone: true },
    });
    return workspace.timeZone;
  }
}

/** "Adaeze O.", "GreenRide fleet #12", "RFID 04A2…9F" or "Operator remote start". */
function driverLabel(s: SessionWithRow) {
  if (s.driver?.name) {
    if (s.driver.fleetId) return s.driver.name;
    const [first, ...rest] = s.driver.name.split(/\s+/);
    const last = rest.at(-1);
    return last ? `${first} ${last[0]}.` : first;
  }
  if (s.idTag === OPERATOR_ID_TAG) return 'Operator remote start';
  if (s.idTag) {
    const hex = s.idTag.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    return hex.length > 6
      ? `RFID ${hex.slice(0, 4)}…${hex.slice(-2)}`
      : `RFID ${hex}`;
  }
  return 'Unknown driver';
}

/** "a GroundFailure" / "an EmergencyStop" for the fault banner. */
function article(reason: string | null) {
  const r = reason ?? 'fault';
  return `${/^[AEIOU]/i.test(r) ? 'an' : 'a'} ${r}`;
}

/** Quotes a cell when needed, and defuses spreadsheet formulas (=, +, -, @). */
function csvCell(value: string | number) {
  let text = String(value);
  if (/^[=+\-@]/.test(text) && typeof value === 'string') text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
