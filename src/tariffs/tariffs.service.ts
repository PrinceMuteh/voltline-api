import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { AuthContext } from '../auth/auth.decorators.js';
import { previewChargingMinutes, price } from '../billing/pricing.js';
import type { Prisma, Tariff } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  PreviewDto,
  PreviewResultDto,
  TariffDto,
  TariffInputDto,
} from './dto/tariff.dto.js';

const RATE_FIELDS = [
  'perKwhKobo',
  'perMinuteKobo',
  'sessionFeeKobo',
  'idleGraceMin',
  'idlePerMinuteKobo',
  'peakFrom',
  'peakTo',
  'peakSurchargeBps',
  'vatIncluded',
  'vatBps',
] as const;

const include = {
  sites: { include: { site: { select: { id: true, name: true } } } },
  fleet: { select: { id: true, name: true } },
  _count: { select: { sessions: true } },
} satisfies Prisma.TariffInclude;

type TariffWithRelations = Prisma.TariffGetPayload<{ include: typeof include }>;

@Injectable()
export class TariffsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(auth: AuthContext): Promise<TariffDto[]> {
    const tariffs = await this.prisma.tariff.findMany({
      where: { workspaceId: auth.workspaceId, archivedAt: null },
      include,
      orderBy: { createdAt: 'asc' },
    });
    return tariffs.map(toDto);
  }

  async create(auth: AuthContext, dto: TariffInputDto): Promise<TariffDto> {
    await this.checkRefs(auth, dto);
    const tariff = await this.prisma.tariff.create({
      data: {
        workspaceId: auth.workspaceId,
        name: dto.name,
        fleetId: dto.fleetId ?? null,
        ...rates(dto),
        sites: { create: dto.siteIds.map((siteId) => ({ siteId })) },
      },
      include,
    });
    return toDto(tariff);
  }

  /**
   * Saves an edit. Sessions keep the tariff version they started on, so when prices change on a
   * tariff that has already priced sessions, the edit becomes a new version and the old one is
   * archived. Name and site changes, or edits to an unused tariff, update it in place.
   */
  async update(
    auth: AuthContext,
    id: string,
    dto: TariffInputDto,
  ): Promise<TariffDto> {
    const current = await this.prisma.tariff.findFirst({
      where: { id, workspaceId: auth.workspaceId },
      include,
    });
    if (!current) {
      throw new NotFoundException('Tariff not found.');
    }
    if (current.archivedAt) {
      throw new UnprocessableEntityException(
        'This version was replaced by a newer one. Reload to edit the current version.',
      );
    }
    await this.checkRefs(auth, dto);

    const pricesChanged = RATE_FIELDS.some((f) => current[f] !== dto[f]);
    const versioned = pricesChanged && current._count.sessions > 0;

    const saved = await this.prisma.$transaction(async (tx) => {
      if (!versioned) {
        await tx.tariffSite.deleteMany({ where: { tariffId: id } });
        return tx.tariff.update({
          where: { id },
          data: {
            name: dto.name,
            fleetId: dto.fleetId ?? null,
            ...rates(dto),
            sites: { create: dto.siteIds.map((siteId) => ({ siteId })) },
          },
          include,
        });
      }
      await tx.tariffSite.deleteMany({ where: { tariffId: id } });
      await tx.tariff.update({
        where: { id },
        data: { archivedAt: new Date() },
      });
      return tx.tariff.create({
        data: {
          workspaceId: auth.workspaceId,
          name: dto.name,
          fleetId: dto.fleetId ?? null,
          ...rates(dto),
          version: current.version + 1,
          previousId: current.id,
          // Keeps its place among the site's tariffs (the oldest public one applies)
          createdAt: current.createdAt,
          sites: { create: dto.siteIds.map((siteId) => ({ siteId })) },
        },
        include,
      });
    });
    return toDto(saved);
  }

  /** The same function final billing uses, so the preview is what a driver pays. */
  preview(dto: PreviewDto): PreviewResultDto {
    const chargingMinutes = Math.min(
      previewChargingMinutes(dto.energyKwh),
      dto.pluggedMinutes,
    );
    return {
      chargingMinutes,
      breakdown: price(dto.rates, {
        energyWh: Math.round(dto.energyKwh * 1000),
        chargingMinutes,
        pluggedMinutes: dto.pluggedMinutes,
        atPeak: dto.atPeak,
      }),
    };
  }

  private async checkRefs(auth: AuthContext, dto: TariffInputDto) {
    const sites = await this.prisma.site.count({
      where: { id: { in: dto.siteIds }, workspaceId: auth.workspaceId },
    });
    if (sites !== new Set(dto.siteIds).size) {
      throw new UnprocessableEntityException('One of the sites was not found.');
    }
    if (dto.fleetId) {
      const fleet = await this.prisma.fleet.findFirst({
        where: { id: dto.fleetId, workspaceId: auth.workspaceId },
      });
      if (!fleet) {
        throw new UnprocessableEntityException('That fleet was not found.');
      }
    }
  }
}

function rates(dto: TariffInputDto) {
  const hasPeak = dto.peakSurchargeBps !== null;
  return {
    perKwhKobo: dto.perKwhKobo,
    perMinuteKobo: dto.perMinuteKobo,
    sessionFeeKobo: dto.sessionFeeKobo,
    idleGraceMin: dto.idlePerMinuteKobo === null ? null : dto.idleGraceMin,
    idlePerMinuteKobo: dto.idlePerMinuteKobo,
    peakFrom: hasPeak ? dto.peakFrom : null,
    peakTo: hasPeak ? dto.peakTo : null,
    peakSurchargeBps: dto.peakSurchargeBps,
    vatIncluded: dto.vatIncluded,
    vatBps: dto.vatBps,
  } satisfies Partial<Tariff>;
}

function toDto(t: TariffWithRelations): TariffDto {
  return {
    id: t.id,
    name: t.name,
    version: t.version,
    perKwhKobo: t.perKwhKobo,
    perMinuteKobo: t.perMinuteKobo,
    sessionFeeKobo: t.sessionFeeKobo,
    idleGraceMin: t.idleGraceMin,
    idlePerMinuteKobo: t.idlePerMinuteKobo,
    peakFrom: t.peakFrom,
    peakTo: t.peakTo,
    peakSurchargeBps: t.peakSurchargeBps,
    vatIncluded: t.vatIncluded,
    vatBps: t.vatBps,
    sites: t.sites.map((s) => s.site),
    fleet: t.fleet,
    sessionCount: t._count.sessions,
  };
}
