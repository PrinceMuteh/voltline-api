import { Injectable } from '@nestjs/common';
import { AlertsService } from '../alerts/alerts.service.js';
import type { ChargerStatus } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';
import { ConnectionRegistry } from './connection-registry.js';
import {
  OPERATOR_ID_TAG,
  PROTOCOL_OF,
  type ChargerSession,
  type ConnectorReport,
} from './ocpp.types.js';

export type BootResult = 'Accepted' | 'Pending' | 'Rejected';

export type CheckState = 'waiting' | 'done' | 'failed';
export interface ConnectCheckItem {
  state: CheckState;
  detail: string | null;
}
export interface ConnectCheck {
  socket: ConnectCheckItem;
  credentials: ConnectCheckItem;
  boot: ConnectCheckItem;
  connectors: ConnectCheckItem;
}

/** lastSeenAt is written at most this often per charger; liveness works in minutes. */
const TOUCH_EVERY_MS = 30_000;

/**
 * The single place where charger traffic, already translated out of OCPP 1.6J or 2.0.1,
 * becomes database state, alerts and live events.
 */
@Injectable()
export class ChargerStateService {
  /** Power now, by charger and EVSE, from the latest MeterValues. */
  private readonly power = new Map<string, Map<number, number>>();
  private readonly lastTouch = new Map<string, number>();
  /** Chargers the liveness sweep marked offline while their socket stayed open. */
  readonly markedOffline = new Set<string>();
  /** Why the last connection attempt failed, for the Add a charger checklist. */
  private readonly failures = new Map<
    string,
    { key: 'socket' | 'credentials'; detail: string }
  >();
  private readonly authDetails = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertsService,
    private readonly realtime: RealtimeGateway,
    private readonly registry: ConnectionRegistry,
  ) {}

  // ─── Connection ───────────────────────────────────────────────────────────

  failed(
    charger: { id: string; workspaceId: string },
    key: 'socket' | 'credentials',
    detail: string,
  ) {
    this.failures.set(charger.id, { key, detail });
    this.emitCheck(charger.workspaceId, charger.id);
  }

  async connected(s: ChargerSession) {
    this.failures.delete(s.chargerId);
    this.authDetails.set(s.chargerId, s.authDetail);
    await this.prisma.charger.update({
      where: { id: s.chargerId },
      data: { protocol: PROTOCOL_OF[s.protocol], lastSeenAt: new Date() },
    });
    this.lastTouch.set(s.chargerId, Date.now());
    await this.bringOnline(s);
    this.emitCheck(s.workspaceId, s.chargerId);
  }

  disconnected(s: ChargerSession) {
    this.power.delete(s.chargerId);
    this.realtime.toWorkspace(s.workspaceId, 'charger.status', {
      chargerId: s.chargerId,
    });
    this.emitCheck(s.workspaceId, s.chargerId);
  }

  /** When each charger last sent anything; lastSeenAt in the database trails it by up to 30 s. */
  private readonly lastMessage = new Map<string, Date>();

  lastMessageAt(chargerId: string) {
    return this.lastMessage.get(chargerId);
  }

  /** Any inbound frame counts as a sign of life. */
  async touch(s: ChargerSession) {
    this.lastMessage.set(s.chargerId, new Date());
    if (this.markedOffline.has(s.chargerId)) {
      await this.bringOnline(s);
    }
    const last = this.lastTouch.get(s.chargerId) ?? 0;
    if (Date.now() - last < TOUCH_EVERY_MS) {
      return;
    }
    this.lastTouch.set(s.chargerId, Date.now());
    await this.prisma.charger.update({
      where: { id: s.chargerId },
      data: { lastSeenAt: new Date() },
    });
  }

  // ─── Messages ─────────────────────────────────────────────────────────────

  async boot(
    s: ChargerSession,
    info: { vendor?: string; model?: string; firmware?: string },
  ): Promise<BootResult> {
    const charger = await this.prisma.charger.findUniqueOrThrow({
      where: { id: s.chargerId },
      include: { workspace: { include: { ocppConfig: true } } },
    });
    let approval = charger.approval;
    if (
      approval === 'PENDING' &&
      charger.workspace.ocppConfig?.autoApproveChargers
    ) {
      approval = 'ACCEPTED';
    }
    await this.prisma.charger.update({
      where: { id: s.chargerId },
      data: {
        approval,
        vendor: info.vendor ?? charger.vendor,
        model: info.model ?? charger.model,
        firmwareVersion: info.firmware ?? 'unknown',
        lastSeenAt: new Date(),
      },
    });
    this.emitCheck(s.workspaceId, s.chargerId);
    this.realtime.toWorkspace(s.workspaceId, 'charger.status', {
      chargerId: s.chargerId,
    });
    if (approval === 'REJECTED') {
      return 'Rejected';
    }
    return approval === 'ACCEPTED' ? 'Accepted' : 'Pending';
  }

  async heartbeatInterval(s: ChargerSession) {
    const settings = await this.prisma.ocppSettings.findUnique({
      where: { workspaceId: s.workspaceId },
    });
    return settings?.heartbeatIntervalSec ?? 300;
  }

  async connectorStatus(s: ChargerSession, report: ConnectorReport) {
    const charger = await this.prisma.charger.findUniqueOrThrow({
      where: { id: s.chargerId },
      include: { evses: { include: { connectors: true } } },
    });

    // OCPP 1.6 connector 0 is the charger as a whole; only a fault there matters
    if (report.evseId === 0) {
      if (report.status === 'FAULTED') {
        await this.setChargerStatus(
          s,
          charger.status,
          'FAULTED',
          report.errorCode,
        );
      }
      return;
    }

    const evse = charger.evses.find((e) => e.evseId === report.evseId);
    const connector = evse?.connectors.find(
      (c) => c.connectorId === report.connectorId,
    );
    if (!connector) {
      // Not declared in Add a charger; ignored until the operator adds it
      return;
    }
    await this.prisma.connector.update({
      where: { id: connector.id },
      data: { status: report.status },
    });
    if (report.status !== 'CHARGING') {
      this.power.get(s.chargerId)?.delete(report.evseId);
    }

    const statuses = charger.evses.flatMap((e) =>
      e.connectors.map((c) =>
        c.id === connector.id ? report.status : c.status,
      ),
    );
    await this.setChargerStatus(
      s,
      charger.status,
      aggregate(statuses),
      report.errorCode,
    );
    this.emitCheck(s.workspaceId, s.chargerId);
  }

  /** A fault reported outside StatusNotification (2.0.1 NotifyEvent "Problem"). */
  async fault(s: ChargerSession, code: string) {
    const charger = await this.prisma.charger.findUniqueOrThrow({
      where: { id: s.chargerId },
    });
    await this.setChargerStatus(s, charger.status, 'FAULTED', code);
  }

  meter(s: ChargerSession, evseId: number, watts: number) {
    let byEvse = this.power.get(s.chargerId);
    if (!byEvse) {
      byEvse = new Map();
      this.power.set(s.chargerId, byEvse);
    }
    byEvse.set(evseId, watts);
    this.realtime.toWorkspace(s.workspaceId, 'charger.power', {
      chargerId: s.chargerId,
      powerW: this.powerOf(s.chargerId),
    });
  }

  endTransaction(s: ChargerSession, evseId: number | undefined) {
    const byEvse = this.power.get(s.chargerId);
    if (evseId === undefined) {
      byEvse?.clear();
    } else {
      byEvse?.delete(evseId);
    }
  }

  /** Sum over EVSEs, or null when nothing is metering. */
  powerOf(chargerId: string): number | null {
    const byEvse = this.power.get(chargerId);
    if (!byEvse || byEvse.size === 0) {
      return null;
    }
    return [...byEvse.values()].reduce((a, b) => a + b, 0);
  }

  /**
   * RFID cards and app tokens of this workspace, plus the console's remote-start tag.
   * Sessions are recorded and billed from phase 3; until then this only gates access.
   */
  async isAuthorized(workspaceId: string, token: string, type?: string) {
    if (type === 'Central' || token === OPERATOR_ID_TAG) {
      return true;
    }
    const card = await this.prisma.idToken.findUnique({
      where: { workspaceId_uid: { workspaceId, uid: token } },
      include: { driver: { select: { status: true } } },
    });
    return Boolean(
      card?.active && (!card.driver || card.driver.status === 'ACTIVE'),
    );
  }

  // ─── Add a charger checklist ──────────────────────────────────────────────

  async connectCheck(chargerId: string): Promise<ConnectCheck> {
    const charger = await this.prisma.charger.findUniqueOrThrow({
      where: { id: chargerId },
      include: {
        evses: { include: { connectors: true }, orderBy: { evseId: 'asc' } },
      },
    });
    const client = this.registry.get(chargerId);
    const failure = this.failures.get(chargerId);
    const waiting: ConnectCheckItem = { state: 'waiting', detail: null };

    const socket: ConnectCheckItem = client
      ? { state: 'done', detail: client.session.protocol }
      : failure?.key === 'socket'
        ? { state: 'failed', detail: failure.detail }
        : waiting;
    const credentials: ConnectCheckItem = client
      ? {
          state: 'done',
          detail: this.authDetails.get(chargerId) ?? 'Basic Auth',
        }
      : failure?.key === 'credentials'
        ? { state: 'failed', detail: failure.detail }
        : waiting;
    const boot: ConnectCheckItem = charger.firmwareVersion
      ? {
          state: 'done',
          detail: [charger.model, `fw ${charger.firmwareVersion}`]
            .filter(Boolean)
            .join(' · '),
        }
      : waiting;
    const connectors = charger.evses.flatMap((e) =>
      e.connectors.map((c) => ({ evseId: e.evseId, status: c.status })),
    );
    const reported =
      connectors.length > 0 && connectors.every((c) => c.status !== 'OFFLINE');
    return {
      socket,
      credentials,
      boot,
      connectors: reported
        ? {
            state: 'done',
            detail: connectors
              .map((c) => `EVSE ${c.evseId} · ${titleCase(c.status)}`)
              .join(', '),
          }
        : waiting,
    };
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  /** After a reconnect, or a message from a charger the sweep had marked offline. */
  private async bringOnline(s: ChargerSession) {
    this.markedOffline.delete(s.chargerId);
    const charger = await this.prisma.charger.findUniqueOrThrow({
      where: { id: s.chargerId },
      include: { evses: { include: { connectors: true } } },
    });
    if (charger.status === 'OFFLINE') {
      const known = charger.evses
        .flatMap((e) => e.connectors.map((c) => c.status))
        .filter((st) => st !== 'OFFLINE');
      const status = known.length > 0 ? aggregate(known) : 'UNAVAILABLE';
      await this.setChargerStatus(s, 'OFFLINE', status);
    }
    await this.alerts.resolveFor(s.workspaceId, s.chargerId, 'CHARGER_OFFLINE');
  }

  private async setChargerStatus(
    s: ChargerSession,
    previous: ChargerStatus,
    next: ChargerStatus,
    errorCode?: string,
  ) {
    if (previous !== next) {
      await this.prisma.charger.update({
        where: { id: s.chargerId },
        data: { status: next },
      });
    }
    this.realtime.toWorkspace(s.workspaceId, 'charger.status', {
      chargerId: s.chargerId,
      status: next,
    });

    if (next === 'FAULTED') {
      const charger = await this.prisma.charger.findUniqueOrThrow({
        where: { id: s.chargerId },
        select: { approval: true },
      });
      if (charger.approval === 'ACCEPTED') {
        await this.alerts.raise({
          workspaceId: s.workspaceId,
          type: 'CHARGER_FAULTED',
          chargerId: s.chargerId,
          title: `${s.chargePointId} faulted`,
          detail: `${errorCode ?? 'Fault reported'} · ${s.siteName}`,
        });
      }
    } else if (previous === 'FAULTED') {
      await this.alerts.resolveFor(
        s.workspaceId,
        s.chargerId,
        'CHARGER_FAULTED',
      );
    }
  }

  private emitCheck(workspaceId: string, chargerId: string) {
    this.realtime.toWorkspace(workspaceId, 'charger.connect_check', {
      chargerId,
    });
  }
}

/** One status for the whole charger: a fault wins, then charging, reserved, available. */
export function aggregate(statuses: ChargerStatus[]): ChargerStatus {
  for (const s of [
    'FAULTED',
    'CHARGING',
    'RESERVED',
    'AVAILABLE',
    'UNAVAILABLE',
  ] as const) {
    if (statuses.includes(s)) {
      return s;
    }
  }
  return 'OFFLINE';
}

const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();
