import {
  ConflictException,
  Injectable,
  NotFoundException,
  RequestTimeoutException,
} from '@nestjs/common';
import type { AuthContext } from '../auth/auth.decorators.js';
import { Prisma } from '../generated/prisma/client.js';
import { ChargerStateService } from '../ocpp/charger-state.service.js';
import { ConnectionRegistry } from '../ocpp/connection-registry.js';
import { LocalListService } from '../ocpp/local-list.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  DriverRowDto,
  DriversPageDto,
  DriverStatusResultDto,
  FleetInputDto,
  FleetSummaryDto,
  IssueCardDto,
  IssuedCardDto,
  ReadCardResultDto,
} from './dto/drivers.dto.js';

/** How long "Read on a charger" waits for a tap. */
const READ_CARD_MS = 30_000;

const driverInclude = {
  fleet: { select: { name: true } },
  wallet: { select: { balanceKobo: true } },
  idTokens: { where: { active: true }, orderBy: { createdAt: 'asc' } },
  _count: { select: { sessions: true } },
} satisfies Prisma.DriverInclude;

type DriverWithAll = Prisma.DriverGetPayload<{ include: typeof driverInclude }>;

@Injectable()
export class DriversService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly localList: LocalListService,
    private readonly registry: ConnectionRegistry,
    private readonly state: ChargerStateService,
  ) {}

  async page(auth: AuthContext, q?: string): Promise<DriversPageDto> {
    const monthStart = await this.monthStart(auth);
    const [drivers, active, cardsIssued, fleets] = await Promise.all([
      this.prisma.driver.findMany({
        where: { workspaceId: auth.workspaceId, ...search(q) },
        include: driverInclude,
        // Fleet vehicles last, as in the design
        orderBy: [
          { fleetId: { sort: 'desc', nulls: 'first' } },
          { createdAt: 'asc' },
        ],
      }),
      this.prisma.session.groupBy({
        by: ['driverId'],
        where: {
          workspaceId: auth.workspaceId,
          driverId: { not: null },
          startedAt: { gte: monthStart },
        },
      }),
      this.prisma.idToken.count({
        where: { workspaceId: auth.workspaceId, active: true },
      }),
      this.fleets(auth, monthStart),
    ]);
    return {
      activeThisMonth: active.length,
      cardsIssued,
      fleets,
      drivers: drivers.map(toRow),
    };
  }

  async setBlocked(
    auth: AuthContext,
    id: string,
    blocked: boolean,
  ): Promise<DriverStatusResultDto> {
    const driver = await this.prisma.driver.findFirst({
      where: { id, workspaceId: auth.workspaceId },
    });
    if (!driver) throw new NotFoundException('Driver not found.');
    const updated = await this.prisma.driver.update({
      where: { id },
      data: { status: blocked ? 'BLOCKED' : 'ACTIVE' },
      include: driverInclude,
    });
    return {
      driver: toRow(updated),
      syncing: await this.localList.syncWorkspace(auth.workspaceId),
    };
  }

  async issueCard(
    auth: AuthContext,
    dto: IssueCardDto,
  ): Promise<IssuedCardDto> {
    const driver = dto.driverId
      ? await this.prisma.driver.findFirst({
          where: { id: dto.driverId, workspaceId: auth.workspaceId },
        })
      : null;
    if (dto.driverId && !driver)
      throw new NotFoundException('Driver not found.');
    const fleetId = driver ? driver.fleetId : (dto.fleetId ?? null);
    const fleet = fleetId
      ? await this.prisma.fleet.findFirst({
          where: { id: fleetId, workspaceId: auth.workspaceId },
        })
      : null;
    if (fleetId && !fleet) throw new NotFoundException('Fleet not found.');

    const existing = await this.prisma.idToken.findUnique({
      where: {
        workspaceId_uid: { workspaceId: auth.workspaceId, uid: dto.uid },
      },
      include: { driver: true, fleet: true },
    });
    if (existing?.active) {
      const holder = existing.driver?.name ?? existing.fleet?.name;
      throw new ConflictException(
        `${dto.uid} is already issued${holder ? ` to ${holder}` : ''}.`,
      );
    }
    const data = {
      driverId: driver?.id ?? null,
      fleetId,
      dailyLimitKobo: dto.dailyLimitKobo ?? null,
      active: true,
    };
    // A revoked card can be issued again
    const card = existing
      ? await this.prisma.idToken.update({ where: { id: existing.id }, data })
      : await this.prisma.idToken.create({
          data: { workspaceId: auth.workspaceId, uid: dto.uid, ...data },
        });
    return {
      id: card.id,
      uid: card.uid,
      holder: driver?.name ?? fleet?.name ?? null,
      syncing: await this.localList.syncWorkspace(auth.workspaceId),
    };
  }

  async createFleet(
    auth: AuthContext,
    dto: FleetInputDto,
  ): Promise<FleetSummaryDto> {
    const fleet = await this.prisma.fleet.create({
      data: { workspaceId: auth.workspaceId, ...dto },
    });
    return {
      id: fleet.id,
      name: fleet.name,
      cards: 0,
      monthKobo: 0,
      invoiceDay: fleet.invoiceDay,
    };
  }

  /** Waits for the next card tapped on the charger (its Authorize) and returns the UID. */
  async readCard(
    auth: AuthContext,
    chargerId: string,
  ): Promise<ReadCardResultDto> {
    const charger = await this.prisma.charger.findFirst({
      where: { id: chargerId, workspaceId: auth.workspaceId },
    });
    if (!charger) throw new NotFoundException('Charger not found.');
    if (!this.registry.has(chargerId)) {
      throw new ConflictException(`${charger.chargePointId} is not connected.`);
    }
    const uid = await this.state.nextCard(chargerId, READ_CARD_MS);
    if (!uid) {
      throw new RequestTimeoutException(
        `No card was tapped on ${charger.chargePointId} within 30 seconds.`,
      );
    }
    const known = await this.prisma.idToken.findUnique({
      where: { workspaceId_uid: { workspaceId: auth.workspaceId, uid } },
    });
    return { uid, known: Boolean(known?.active) };
  }

  private async fleets(auth: AuthContext, monthStart: Date) {
    const [fleets, billed] = await Promise.all([
      this.prisma.fleet.findMany({
        where: { workspaceId: auth.workspaceId },
        include: {
          _count: { select: { idTokens: { where: { active: true } } } },
        },
        orderBy: { name: 'asc' },
      }),
      this.prisma.session.groupBy({
        by: ['fleetId'],
        where: {
          workspaceId: auth.workspaceId,
          fleetId: { not: null },
          startedAt: { gte: monthStart },
        },
        _sum: { amountKobo: true },
      }),
    ]);
    return fleets.map((f) => ({
      id: f.id,
      name: f.name,
      cards: f._count.idTokens,
      monthKobo: billed.find((b) => b.fleetId === f.id)?._sum.amountKobo ?? 0,
      invoiceDay: f.invoiceDay,
    }));
  }

  /** The 1st of this month, in the workspace's time zone. */
  private async monthStart(auth: AuthContext) {
    const { timeZone } = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: auth.workspaceId },
      select: { timeZone: true },
    });
    const [{ start }] = await this.prisma.$queryRaw<{ start: Date }[]>`
      SELECT date_trunc('month', now() AT TIME ZONE ${timeZone}) AT TIME ZONE ${timeZone} AS start`;
    return start;
  }
}

function search(q: string | undefined): Prisma.DriverWhereInput {
  if (!q) return {};
  const digits = q.replace(/\D/g, '').replace(/^0/, '');
  // Card UIDs are stored as 04:A2:1C:9F; people type "04A2" or "04:A2"
  const hex = q.replace(/[\s:]/g, '');
  const cardForms = /^[0-9A-Fa-f]{2,}$/.test(hex)
    ? [q, hex.match(/.{1,2}/g)!.join(':')]
    : [q];
  return {
    OR: [
      { name: { contains: q, mode: 'insensitive' } },
      ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : []),
      ...cardForms.map((form) => ({
        idTokens: {
          some: {
            active: true,
            uid: { contains: form, mode: 'insensitive' as const },
          },
        },
      })),
      { fleet: { name: { contains: q, mode: 'insensitive' } } },
    ],
  };
}

/** +2348030004412 → +234 803 ••• 4412 */
function maskPhone(phone: string) {
  const m = /^\+(234)(\d{3})\d*(\d{4})$/.exec(phone);
  return m ? `+${m[1]} ${m[2]} ••• ${m[3]}` : `${phone.slice(0, -4)}••••`;
}

function toRow(d: DriverWithAll): DriverRowDto {
  const fleetVehicle = Boolean(d.fleetId);
  return {
    id: d.id,
    name: d.name,
    phone: fleetVehicle ? null : maskPhone(d.phone),
    fleet: d.fleet?.name ?? null,
    app: !fleetVehicle && Boolean(d.wallet),
    cards: d.idTokens.map((t) => t.uid),
    sessions: d._count.sessions,
    billing: fleetVehicle ? 'INVOICE' : d.wallet ? 'WALLET' : 'PREPAID',
    walletKobo: d.wallet?.balanceKobo ?? null,
    status: d.status,
  };
}
