import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { AlertsService } from '../alerts/alerts.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';
import { ChargerStateService } from './charger-state.service.js';

const SWEEP_EVERY_MS = 30_000;
const PRUNE_EVERY_MS = 60 * 60_000;
/** OCPP message log retention (PRD OC-12: 90 days). */
const KEEP_MESSAGES_DAYS = 90;

/**
 * Marks approved chargers offline when nothing has arrived within the workspace's window
 * (Settings › OCPP, default 10 min) and raises a "Charger offline" alert.
 */
@Injectable()
export class LivenessService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LivenessService.name);
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertsService,
    private readonly realtime: RealtimeGateway,
    private readonly state: ChargerStateService,
  ) {}

  onModuleInit() {
    this.timers = [
      setInterval(() => void this.sweep().catch(this.warn), SWEEP_EVERY_MS),
      setInterval(() => void this.prune().catch(this.warn), PRUNE_EVERY_MS),
    ];
  }

  onModuleDestroy() {
    this.timers.forEach(clearInterval);
  }

  async sweep(now = new Date()) {
    const candidates = await this.prisma.charger.findMany({
      where: {
        approval: 'ACCEPTED',
        status: { not: 'OFFLINE' },
        lastSeenAt: { lt: new Date(now.getTime() - 60_000) },
      },
      include: {
        site: { select: { name: true } },
        workspace: { select: { ocppConfig: true } },
      },
    });
    for (const charger of candidates) {
      const windowMin =
        charger.workspace.ocppConfig?.offlineAlertAfterMin ?? 10;
      if (now.getTime() - charger.lastSeenAt!.getTime() < windowMin * 60_000) {
        continue;
      }
      await this.prisma.charger.update({
        where: { id: charger.id },
        data: { status: 'OFFLINE' },
      });
      this.state.markedOffline.add(charger.id);
      this.realtime.toWorkspace(charger.workspaceId, 'charger.status', {
        chargerId: charger.id,
        status: 'OFFLINE',
      });
      await this.alerts.raise({
        workspaceId: charger.workspaceId,
        type: 'CHARGER_OFFLINE',
        chargerId: charger.id,
        title: `${charger.chargePointId} offline`,
        detail: charger.site.name,
      });
      this.logger.log(`${charger.chargePointId} marked offline`);
    }
  }

  private async prune() {
    await this.prisma.ocppMessage.deleteMany({
      where: {
        at: { lt: new Date(Date.now() - KEEP_MESSAGES_DAYS * 86_400_000) },
      },
    });
  }

  private readonly warn = (error: unknown) => this.logger.warn(String(error));
}
