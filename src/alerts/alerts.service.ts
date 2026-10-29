import { Injectable, NotFoundException } from '@nestjs/common';
import type { AuthContext } from '../auth/auth.decorators.js';
import type { AlertType } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';
import { AlertDto } from './dto/alert.dto.js';

interface RaiseAlert {
  workspaceId: string;
  type: AlertType;
  chargerId?: string;
  title: string;
  detail?: string;
}

@Injectable()
export class AlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /** Opens an alert unless the same charger already has an open one of this type. */
  async raise(alert: RaiseAlert) {
    if (alert.chargerId) {
      const open = await this.prisma.alert.findFirst({
        where: {
          chargerId: alert.chargerId,
          type: alert.type,
          resolvedAt: null,
        },
      });
      if (open) {
        return open;
      }
    }
    const created = await this.prisma.alert.create({ data: alert });
    this.realtime.toWorkspace(alert.workspaceId, 'alert.changed', {
      id: created.id,
    });
    return created;
  }

  /** Closes the charger's open alerts of this type, e.g. when it reconnects. */
  async resolveFor(workspaceId: string, chargerId: string, type: AlertType) {
    const { count } = await this.prisma.alert.updateMany({
      where: { chargerId, type, resolvedAt: null },
      data: { resolvedAt: new Date() },
    });
    if (count > 0) {
      this.realtime.toWorkspace(workspaceId, 'alert.changed', { chargerId });
    }
  }

  async listOpen(auth: AuthContext): Promise<AlertDto[]> {
    const alerts = await this.prisma.alert.findMany({
      where: { workspaceId: auth.workspaceId, resolvedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    const chargerIds = alerts.flatMap((a) =>
      a.chargerId ? [a.chargerId] : [],
    );
    const chargers = await this.prisma.charger.findMany({
      where: { id: { in: chargerIds } },
      select: {
        id: true,
        chargePointId: true,
        lastSeenAt: true,
        site: { select: { name: true } },
      },
    });
    const byId = new Map(chargers.map((c) => [c.id, c]));

    return alerts.map((a) => {
      const charger = a.chargerId ? byId.get(a.chargerId) : undefined;
      let detail = a.detail ?? '';
      // Offline alerts read "No heartbeat for 14 min · Jabi Lake", counted from the last message
      if (a.type === 'CHARGER_OFFLINE' && charger?.lastSeenAt) {
        const minutes = Math.floor(
          (Date.now() - charger.lastSeenAt.getTime()) / 60_000,
        );
        detail = `No heartbeat for ${formatMinutes(minutes)} · ${charger.site.name}`;
      }
      return {
        id: a.id,
        type: a.type,
        title: a.title,
        detail,
        chargerId: a.chargerId,
        chargePointId: charger?.chargePointId ?? null,
        createdAt: a.createdAt.toISOString(),
      };
    });
  }

  async resolve(auth: AuthContext, id: string) {
    const { count } = await this.prisma.alert.updateMany({
      where: { id, workspaceId: auth.workspaceId, resolvedAt: null },
      data: { resolvedAt: new Date() },
    });
    if (count === 0) {
      throw new NotFoundException('This alert is already resolved.');
    }
    this.realtime.toWorkspace(auth.workspaceId, 'alert.changed', { id });
  }
}

function formatMinutes(minutes: number) {
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} days`;
}
