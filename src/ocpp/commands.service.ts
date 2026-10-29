import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { createRequire } from 'node:module';
import type { AuthContext } from '../auth/auth.decorators.js';
import type { RemoteCommand } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';
import { SessionRecorder } from '../sessions/session-recorder.service.js';
import { ConnectionRegistry } from './connection-registry.js';
import { OPERATOR_ID_TAG, type ChargerClient } from './ocpp.types.js';

export const COMMAND_KINDS = [
  'remote-start',
  'remote-stop',
  'unlock',
  'soft-reset',
  'hard-reset',
  'set-available',
  'set-unavailable',
] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

interface CommandPayload {
  kind: CommandKind;
  evseId: number;
  /** remote-stop: the charger's id for the running transaction. */
  transactionId?: string;
  /** remote-start: the driver's token; the console uses its own tag. */
  idTag?: string;
}

/** What the driver app needs to know about a command it sent. */
export type DirectOutcome =
  | { outcome: 'ACCEPTED' }
  | { outcome: 'REJECTED'; reply: string }
  | { outcome: 'NO_RESPONSE' }
  | { outcome: 'OFFLINE' };

export interface CommandResult {
  id: string;
  status: RemoteCommand['status'];
  /** Toast title, e.g. "Connector unlocked" or "Reset rejected by CP-0031". */
  title: string;
  /** Toast body, e.g. "CP-0007 · UnlockConnector.conf Accepted". */
  detail: string;
}

// ocpp-rpc spreads its error classes into module.exports, which ESM named imports cannot see
const { TimeoutError } = createRequire(import.meta.url)(
  'ocpp-rpc',
) as typeof import('ocpp-rpc');

const TIMEOUT_MS = 30_000;
/** Queued commands older than this are dropped rather than sent on reconnect. */
const QUEUE_TTL_MS = 24 * 60 * 60_000;

/**
 * Remote commands from the console. Each one is a RemoteCommand row; if the charger does not
 * answer within 30 s, or is offline, it stays queued and is sent when the charger reconnects.
 */
@Injectable()
export class CommandsService implements OnModuleInit {
  private readonly logger = new Logger(CommandsService.name);
  private remoteStartId = Math.floor(Date.now() / 1000) % 1_000_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectionRegistry,
    private readonly realtime: RealtimeGateway,
    private readonly recorder: SessionRecorder,
  ) {}

  onModuleInit() {
    // A driver's budget reached: stop the session, as if they had tapped stop
    this.recorder.onBudgetReached(async (session, evseId) => {
      const result = await this.sendNow(
        session.chargerId,
        'remote-stop',
        { evseId, transactionId: session.transactionId },
        'auto-stop',
      );
      this.logger.log(`Auto-stop ${session.reference}: ${result.outcome}`);
    });
  }

  /**
   * For the driver app: sent at once or not at all. Nothing is queued, because a driver
   * standing at the charger must hear "offline" or "no response" now, not later.
   */
  async sendNow(
    chargerId: string,
    kind: CommandKind,
    extra: { evseId: number; transactionId?: string; idTag?: string },
    requestedBy: string,
  ): Promise<DirectOutcome> {
    const client = this.registry.get(chargerId);
    if (!client) {
      return { outcome: 'OFFLINE' };
    }
    const payload: CommandPayload = { kind, ...extra };
    const command = await this.prisma.remoteCommand.create({
      data: {
        chargerId,
        action: actionName(kind),
        payload: { ...payload },
        requestedBy,
        status: 'SENT',
      },
    });
    const method =
      client.session.protocol === 'ocpp1.6'
        ? (ACTION_16[kind] ?? actionName(kind))
        : actionName(kind);
    try {
      const response = (await client.call(
        method,
        this.params(client, payload),
        { callTimeoutMs: TIMEOUT_MS },
      )) as { status?: string };
      const status = response.status ?? 'Accepted';
      const ok = ['Accepted', 'Scheduled', 'Unlocked'].includes(status);
      await this.prisma.remoteCommand.update({
        where: { id: command.id },
        data: {
          status: ok ? 'ACCEPTED' : 'REJECTED',
          response,
          completedAt: new Date(),
        },
      });
      return ok
        ? { outcome: 'ACCEPTED' }
        : { outcome: 'REJECTED', reply: status };
    } catch (error) {
      await this.prisma.remoteCommand.update({
        where: { id: command.id },
        data: {
          status: 'CANCELLED',
          response: {
            error: error instanceof Error ? error.message : String(error),
          },
          completedAt: new Date(),
        },
      });
      return error instanceof TimeoutError
        ? { outcome: 'NO_RESPONSE' }
        : { outcome: 'REJECTED', reply: 'Error' };
    }
  }

  async run(
    auth: AuthContext,
    chargerId: string,
    kind: CommandKind,
    evseId = 1,
  ): Promise<CommandResult> {
    const charger = await this.prisma.charger.findFirst({
      where: { id: chargerId, workspaceId: auth.workspaceId },
      include: { evses: true },
    });
    if (!charger) {
      throw new NotFoundException('Charger not found.');
    }
    if (kind === 'hard-reset' && auth.role === 'SUPPORT') {
      throw new ForbiddenException(
        'Hard resets need an Operator or Admin. You are a Support member.',
      );
    }
    if (charger.approval !== 'ACCEPTED') {
      throw new ConflictException(
        `Approve ${charger.chargePointId} before sending it commands.`,
      );
    }
    if (!charger.evses.some((e) => e.evseId === evseId)) {
      throw new NotFoundException(
        `${charger.chargePointId} has no EVSE ${evseId}.`,
      );
    }

    const payload: CommandPayload = { kind, evseId };
    if (kind === 'remote-stop') {
      const active = await this.prisma.session.findFirst({
        where: {
          chargerId,
          endedAt: null,
          connector: { evse: { evseId } },
        },
        orderBy: { startedAt: 'desc' },
      });
      if (!active) {
        throw new ConflictException(
          `No session is running on ${charger.chargePointId} EVSE ${evseId}.`,
        );
      }
      payload.transactionId = active.transactionId;
    }
    const command = await this.prisma.remoteCommand.create({
      data: {
        chargerId,
        action: actionName(kind),
        payload: { ...payload },
        requestedBy: auth.memberId,
      },
    });
    return this.dispatch(command, charger.chargePointId, auth.workspaceId);
  }

  /** Stop from the session drawer: RequestStopTransaction / RemoteStopTransaction for its EVSE. */
  async stopSession(auth: AuthContext, sessionId: string) {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, workspaceId: auth.workspaceId },
      include: { connector: { include: { evse: true } } },
    });
    if (!session) {
      throw new NotFoundException('Session not found.');
    }
    if (session.endedAt) {
      throw new ConflictException(`${session.reference} has already ended.`);
    }
    return this.run(
      auth,
      session.chargerId,
      'remote-stop',
      session.connector?.evse.evseId ?? 1,
    );
  }

  async cancel(auth: AuthContext, chargerId: string, commandId: string) {
    const { count } = await this.prisma.remoteCommand.updateMany({
      where: {
        id: commandId,
        chargerId,
        charger: { workspaceId: auth.workspaceId },
        status: { in: ['QUEUED', 'TIMED_OUT'] },
      },
      data: { status: 'CANCELLED', completedAt: new Date() },
    });
    if (count === 0) {
      throw new NotFoundException(
        'This command was already sent or cancelled.',
      );
    }
  }

  /** Sends what piled up while the charger was away, oldest first. */
  async flush(chargerId: string) {
    const queued = await this.prisma.remoteCommand.findMany({
      where: {
        chargerId,
        status: { in: ['QUEUED', 'TIMED_OUT'] },
        createdAt: { gt: new Date(Date.now() - QUEUE_TTL_MS) },
      },
      orderBy: { createdAt: 'asc' },
      include: { charger: true },
    });
    for (const command of queued) {
      await this.dispatch(
        command,
        command.charger.chargePointId,
        command.charger.workspaceId,
      );
    }
  }

  private async dispatch(
    command: RemoteCommand,
    chargePointId: string,
    workspaceId: string,
  ): Promise<CommandResult> {
    const client = this.registry.get(command.chargerId);
    const payload = command.payload as unknown as CommandPayload;
    const { kind } = payload;
    const method =
      client?.session.protocol === 'ocpp1.6'
        ? (ACTION_16[kind] ?? actionName(kind))
        : actionName(kind);

    if (!client) {
      return this.finish(command, workspaceId, 'QUEUED', null, {
        title: `${chargePointId} is offline`,
        detail: `${method} is queued and sent the moment it reconnects.`,
      });
    }

    await this.prisma.remoteCommand.update({
      where: { id: command.id },
      data: { status: 'SENT' },
    });
    try {
      const response = (await client.call(
        method,
        this.params(client, payload),
        { callTimeoutMs: TIMEOUT_MS },
      )) as { status?: string; statusInfo?: { reasonCode?: string } };
      const status = response.status ?? 'Accepted';
      const ok = ['Accepted', 'Scheduled', 'Unlocked'].includes(status);
      return this.finish(
        command,
        workspaceId,
        ok ? 'ACCEPTED' : 'REJECTED',
        response,
        ok
          ? {
              title: SUCCESS_TITLE[kind],
              detail: `${chargePointId} · ${method}.conf ${status}`,
            }
          : {
              title: `${REJECT_NOUN[kind]} rejected by ${chargePointId}`,
              detail: `Charger replied ${status}${reasonText(response.statusInfo?.reasonCode)}`,
            },
      );
    } catch (error) {
      if (error instanceof TimeoutError) {
        return this.finish(command, workspaceId, 'TIMED_OUT', null, {
          title: `No response from ${chargePointId} after 30 s`,
          detail: `${method} is queued and will be sent when it reconnects.`,
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`${method} to ${chargePointId} failed: ${message}`);
      return this.finish(
        command,
        workspaceId,
        'REJECTED',
        { error: message },
        {
          title: `${REJECT_NOUN[kind]} failed on ${chargePointId}`,
          detail: `Charger answered with an error: ${message}`,
        },
      );
    }
  }

  private params(client: ChargerClient, payload: CommandPayload) {
    const v201 = client.session.protocol === 'ocpp2.0.1';
    const { kind, evseId } = payload;
    switch (kind) {
      case 'remote-start':
        return v201
          ? {
              idToken: {
                idToken: payload.idTag ?? OPERATOR_ID_TAG,
                type: 'Central',
              },
              remoteStartId: ++this.remoteStartId,
              evseId,
            }
          : { idTag: payload.idTag ?? OPERATOR_ID_TAG, connectorId: evseId };
      case 'unlock':
        return v201 ? { evseId, connectorId: 1 } : { connectorId: evseId };
      case 'soft-reset':
        return { type: v201 ? 'OnIdle' : 'Soft' };
      case 'hard-reset':
        return { type: v201 ? 'Immediate' : 'Hard' };
      case 'remote-stop':
        return v201
          ? { transactionId: payload.transactionId }
          : { transactionId: Number(payload.transactionId) };
      case 'set-available':
      case 'set-unavailable': {
        const status = kind === 'set-available' ? 'Operative' : 'Inoperative';
        return v201
          ? { operationalStatus: status, evse: { id: evseId } }
          : { connectorId: evseId, type: status };
      }
    }
  }

  private async finish(
    command: RemoteCommand,
    workspaceId: string,
    status: RemoteCommand['status'],
    response: object | null,
    text: { title: string; detail: string },
  ): Promise<CommandResult> {
    const settled = status !== 'QUEUED' && status !== 'TIMED_OUT';
    await this.prisma.remoteCommand.update({
      where: { id: command.id },
      data: {
        status,
        response: response ?? undefined,
        completedAt: settled ? new Date() : null,
      },
    });
    const result = { id: command.id, status, ...text };
    this.realtime.toWorkspace(workspaceId, 'command.result', {
      chargerId: command.chargerId,
      ...result,
    });
    return result;
  }
}

/** The OCPP 2.0.1 action name. */
function actionName(kind: CommandKind) {
  return {
    'remote-start': 'RequestStartTransaction',
    'remote-stop': 'RequestStopTransaction',
    unlock: 'UnlockConnector',
    'soft-reset': 'Reset',
    'hard-reset': 'Reset',
    'set-available': 'ChangeAvailability',
    'set-unavailable': 'ChangeAvailability',
  }[kind];
}

/** Where 1.6J names an action differently. */
const ACTION_16: Partial<Record<CommandKind, string>> = {
  'remote-start': 'RemoteStartTransaction',
  'remote-stop': 'RemoteStopTransaction',
};

const SUCCESS_TITLE: Record<CommandKind, string> = {
  'remote-start': 'Remote start accepted',
  'remote-stop': 'Stop accepted',
  'set-available': 'Set to available',
  'set-unavailable': 'Set to unavailable',
  unlock: 'Connector unlocked',
  'soft-reset': 'Soft reset accepted',
  'hard-reset': 'Hard reset accepted',
};

const REJECT_NOUN: Record<CommandKind, string> = {
  'remote-start': 'Remote start',
  'remote-stop': 'Stop',
  'set-available': 'Availability change',
  'set-unavailable': 'Availability change',
  unlock: 'Unlock',
  'soft-reset': 'Reset',
  'hard-reset': 'Reset',
};

function reasonText(reasonCode: string | undefined) {
  if (!reasonCode) {
    return '.';
  }
  if (reasonCode === 'FaultActive') {
    return ': a fault is active. Clear the fault first.';
  }
  return `: ${reasonCode}.`;
}
