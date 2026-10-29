import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthContext } from '../auth/auth.decorators.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SiteDto, SiteInputDto, SiteUpdateDto } from './dto/site.dto.js';

@Injectable()
export class SitesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(auth: AuthContext): Promise<SiteDto[]> {
    const sites = await this.prisma.site.findMany({
      where: { workspaceId: auth.workspaceId },
      include: { _count: { select: { chargers: true } } },
      orderBy: { name: 'asc' },
    });
    return sites.map(toDto);
  }

  async create(auth: AuthContext, dto: SiteInputDto): Promise<SiteDto> {
    try {
      const site = await this.prisma.site.create({
        data: Object.assign({ workspaceId: auth.workspaceId }, dto),
        include: { _count: { select: { chargers: true } } },
      });
      return toDto(site);
    } catch (error) {
      throw duplicateName(error, dto.name);
    }
  }

  async update(
    auth: AuthContext,
    id: string,
    dto: SiteUpdateDto,
  ): Promise<SiteDto> {
    const site = await this.prisma.site.findFirst({
      where: { id, workspaceId: auth.workspaceId },
    });
    if (!site) {
      throw new NotFoundException('Site not found.');
    }
    try {
      const updated = await this.prisma.site.update({
        where: { id },
        data: dto,
        include: { _count: { select: { chargers: true } } },
      });
      return toDto(updated);
    } catch (error) {
      throw duplicateName(error, dto.name ?? site.name);
    }
  }
}

function duplicateName(error: unknown, name: string) {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  ) {
    return new ConflictException(`A site called ${name} already exists.`);
  }
  return error;
}

function toDto(
  s: Prisma.SiteGetPayload<{
    include: { _count: { select: { chargers: true } } };
  }>,
): SiteDto {
  return {
    id: s.id,
    name: s.name,
    area: s.area,
    address: s.address,
    latitude: s.latitude,
    longitude: s.longitude,
    openingHours: s.openingHours,
    gridLimitKw: s.gridLimitKw,
    chargerCount: s._count.chargers,
  };
}
