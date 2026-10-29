import { Injectable, NotFoundException } from '@nestjs/common';
import type { AuthContext } from '../auth/auth.decorators.js';
import { ChargerStateService } from '../ocpp/charger-state.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeDto, OnboardingDto, OverviewDto } from './dto/console.dto.js';

@Injectable()
export class ConsoleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly state: ChargerStateService,
  ) {}

  async me(auth: AuthContext): Promise<MeDto> {
    const member = await this.prisma.member.findUnique({
      where: { id: auth.memberId },
      include: { user: true, workspace: true },
    });
    if (!member) {
      throw new NotFoundException('Member not found.');
    }
    return {
      user: {
        id: member.user.id,
        name: member.user.name,
        email: member.user.email,
      },
      role: member.role,
      workspace: {
        id: member.workspace.id,
        name: member.workspace.name,
        currency: member.workspace.currency,
        timeZone: member.workspace.timeZone,
      },
    };
  }

  /** The "Get your network live" checklist from the console's first-run state. */
  async onboarding(auth: AuthContext): Promise<OnboardingDto> {
    const where = { workspaceId: auth.workspaceId };
    const [chargers, tariffs, gateway] = await Promise.all([
      this.prisma.charger.count({ where }),
      this.prisma.tariff.count({ where: { ...where, archivedAt: null } }),
      this.prisma.paymentGatewayConfig.findUnique({ where }),
    ]);
    const steps = [
      { key: 'workspace', label: 'Create your workspace', done: true },
      { key: 'charger', label: 'Add your first charger', done: chargers > 0 },
      { key: 'tariff', label: 'Set a tariff', done: tariffs > 0 },
      {
        key: 'gateway',
        label: 'Connect a payment gateway',
        done: gateway?.connected ?? false,
      },
    ];
    return {
      steps,
      completed: steps.filter((s) => s.done).length,
      total: steps.length,
    };
  }

  /** "Today at a glance" and the energy chart, in the workspace's time zone. */
  async overview(auth: AuthContext): Promise<OverviewDto> {
    const workspace = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: auth.workspaceId },
      select: { timeZone: true },
    });
    const tz = workspace.timeZone;
    const [chargers, hours, revenue] = await Promise.all([
      this.prisma.charger.findMany({
        where: { workspaceId: auth.workspaceId },
        select: {
          id: true,
          status: true,
          approval: true,
          evses: { select: { connectors: { select: { status: true } } } },
        },
      }),
      // Energy per hour from consecutive meter readings of each session
      this.prisma.$queryRaw<{ hour: number; wh: bigint }[]>`
        WITH day AS (
          SELECT date_trunc('day', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz} AS start
        ), deltas AS (
          SELECT ms."at" AT TIME ZONE 'UTC' AS at,
                 ms."energyWh" - LAG(ms."energyWh") OVER (
                   PARTITION BY ms."sessionId" ORDER BY ms."at"
                 ) AS delta
          FROM "MeterSample" ms
          JOIN "Session" s ON s.id = ms."sessionId", day
          WHERE s."workspaceId" = ${auth.workspaceId}
            AND ms."at" AT TIME ZONE 'UTC' >= day.start - interval '1 hour'
        )
        SELECT EXTRACT(HOUR FROM deltas.at AT TIME ZONE ${tz})::int AS hour,
               SUM(GREATEST(delta, 0))::bigint AS wh
        FROM deltas, day
        WHERE delta IS NOT NULL AND deltas.at >= day.start
        GROUP BY 1`,
      this.prisma.$queryRaw<{ kobo: bigint | null }[]>`
        SELECT SUM("amountKobo")::bigint AS kobo
        FROM "Session"
        WHERE "workspaceId" = ${auth.workspaceId}
          AND status IN ('COMPLETED', 'STOPPED_BY_FAULT', 'PAYMENT_FAILED')
          AND "endedAt" AT TIME ZONE 'UTC'
              >= date_trunc('day', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz}`,
    ]);

    const approved = chargers.filter((c) => c.approval === 'ACCEPTED');
    const count = (status: string) =>
      approved.filter((c) => c.status === status).length;
    const currentHour = Number(
      new Intl.DateTimeFormat('en-GB', {
        hour: 'numeric',
        hourCycle: 'h23',
        timeZone: tz,
      }).format(new Date()),
    );
    const byHour = new Map(hours.map((h) => [h.hour, Number(h.wh)]));
    const energyByHourWh = Array.from({ length: 24 }, (_, h) =>
      h > currentHour ? null : (byHour.get(h) ?? 0),
    );

    return {
      chargers: {
        total: approved.length,
        // Usable by drivers right now, as on the Overview tile ("6 / 8 · 1 faulted · 1 offline")
        online: count('CHARGING') + count('AVAILABLE'),
        charging: count('CHARGING'),
        available: count('AVAILABLE'),
        faulted: count('FAULTED'),
        offline: count('OFFLINE'),
        unavailable: count('UNAVAILABLE'),
        pending: chargers.filter((c) => c.approval === 'PENDING').length,
      },
      activeSessions: approved
        .filter((c) => c.status !== 'OFFLINE')
        .flatMap((c) => c.evses.flatMap((e) => e.connectors))
        .filter((c) => c.status === 'CHARGING').length,
      powerW: approved.reduce(
        (sum, c) => sum + (this.state.powerOf(c.id) ?? 0),
        0,
      ),
      energyTodayWh: energyByHourWh.reduce<number>((a, b) => a + (b ?? 0), 0),
      revenueTodayKobo: Number(revenue[0]?.kobo ?? 0),
      energyByHourWh,
    };
  }
}
