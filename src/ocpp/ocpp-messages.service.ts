import { Injectable, Logger } from '@nestjs/common';
import type { OcppMessage } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';
import type { ChargerSession } from './ocpp.types.js';

export interface OcppMessageView {
  id: string;
  at: string;
  direction: 'INBOUND' | 'OUTBOUND';
  action: string;
  /** "Power.Active.Import 7.2 kW", "EVSE 1 · Available", "UnlockConnector.conf Accepted" … */
  summary: string;
  /** The OCPP payload as the charger sent it (or as we sent it). */
  payload: Record<string, unknown>;
}

export interface MessageSearch {
  /** Free text over the action and the raw payload, e.g. "GroundFailure" or a transaction id. */
  q?: string;
  /** One action; its responses (Action.conf) are included. */
  action?: string;
  direction?: 'INBOUND' | 'OUTBOUND';
  /** Cursor: only messages older than this ISO time. */
  before?: string;
  limit?: number;
}

type Json = Record<string, unknown>;

/**
 * Keeps the raw frames for the charger drawer's live log: every CALL in both directions,
 * and the charger's answers to our calls. Our answers to its calls are left out as noise.
 */
@Injectable()
export class OcppMessagesService {
  private readonly logger = new Logger(OcppMessagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /** Returns a recorder bound to one socket, which remembers what each of our calls was. */
  recorder(session: ChargerSession) {
    const ourCalls = new Map<string, string>();
    return (raw: unknown, outbound: boolean) => {
      let frame: unknown[];
      try {
        frame = JSON.parse(String(raw)) as unknown[];
      } catch {
        return;
      }
      if (!Array.isArray(frame)) {
        return;
      }
      const [type, id] = frame as [number, string];
      if (type === 2) {
        const action = String(frame[2]);
        if (outbound) {
          ourCalls.set(id, action);
        }
        this.save(session, outbound, action, (frame[3] ?? {}) as Json);
      } else if (!outbound && (type === 3 || type === 4)) {
        const action = ourCalls.get(id);
        ourCalls.delete(id);
        if (action) {
          const payload =
            type === 3
              ? ((frame[2] ?? {}) as Json)
              : { errorCode: frame[2], errorDescription: frame[3] };
          this.save(session, false, `${action}.conf`, payload);
        }
      }
    };
  }

  async recent(chargerId: string, limit = 50): Promise<OcppMessageView[]> {
    const rows = await this.prisma.ocppMessage.findMany({
      where: { chargerId },
      orderBy: { at: 'desc' },
      take: limit,
    });
    return rows.map(toView);
  }

  /** The searchable log (OC-12): newest first, 100 at a time, with a cursor for older pages. */
  async search(chargerId: string, f: MessageSearch) {
    const limit = Math.min(f.limit ?? 100, 200);
    const like = f.q ? `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const rows = await this.prisma.$queryRaw<OcppMessage[]>`
      SELECT * FROM "OcppMessage"
      WHERE "chargerId" = ${chargerId}
        AND (${like}::text IS NULL OR action ILIKE ${like} OR payload::text ILIKE ${like})
        AND (${f.action ?? null}::text IS NULL OR action = ${f.action ?? null} OR action = ${f.action ?? null} || '.conf')
        AND (${f.direction ?? null}::text IS NULL OR direction::text = ${f.direction ?? null})
        AND (${f.before ?? null}::timestamp IS NULL OR at < ${f.before ? new Date(f.before) : null}::timestamp)
      ORDER BY at DESC
      LIMIT ${limit + 1}`;
    const page = rows.slice(0, limit);
    const actions = f.before
      ? []
      : (
          await this.prisma.ocppMessage.findMany({
            where: { chargerId, NOT: { action: { endsWith: '.conf' } } },
            distinct: ['action'],
            select: { action: true },
            orderBy: { action: 'asc' },
          })
        ).map((a) => a.action);
    return {
      messages: page.map(toView),
      nextBefore: rows.length > limit ? page.at(-1)!.at.toISOString() : null,
      actions,
    };
  }

  private save(
    session: ChargerSession,
    outbound: boolean,
    action: string,
    payload: Json,
  ) {
    this.prisma.ocppMessage
      .create({
        data: {
          chargerId: session.chargerId,
          direction: outbound ? 'OUTBOUND' : 'INBOUND',
          action,
          payload: payload as object,
        },
      })
      .then((row) =>
        this.realtime.toWorkspace(session.workspaceId, 'charger.message', {
          chargerId: session.chargerId,
          message: toView(row),
        }),
      )
      .catch((error: unknown) =>
        this.logger.warn(`Could not store ${action}: ${String(error)}`),
      );
  }
}

function toView(row: OcppMessage): OcppMessageView {
  return {
    id: row.id,
    at: row.at.toISOString(),
    direction: row.direction,
    action: row.action,
    summary: summarize(row.action, (row.payload ?? {}) as Json),
    payload: (row.payload ?? {}) as Json,
  };
}

/** Text of a scalar JSON value; objects and missing values become ''. */
const str = (v: unknown) =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
    ? String(v)
    : '';

export function summarize(action: string, p: Json): string {
  if (action.endsWith('.conf')) {
    if (typeof p.errorCode === 'string') {
      return [p.errorCode, str(p.errorDescription)].filter(Boolean).join(' · ');
    }
    const reason = (p.statusInfo as Json | undefined)?.reasonCode;
    return [p.status, reason].filter(Boolean).join(' · ');
  }
  switch (action) {
    case 'BootNotification': {
      const cs = (p.chargingStation ?? {}) as Json;
      const model = cs.model ?? p.chargePointModel;
      const fw = cs.firmwareVersion ?? p.firmwareVersion;
      return [str(model), str(fw) && `fw ${str(fw)}`]
        .filter(Boolean)
        .join(' · ');
    }
    case 'StatusNotification':
      if ('connectorStatus' in p) {
        return `EVSE ${str(p.evseId)} · ${str(p.connectorStatus)}`;
      }
      return [
        `Connector ${str(p.connectorId)} · ${str(p.status)}`,
        p.errorCode !== 'NoError' && p.errorCode,
      ]
        .filter(Boolean)
        .join(' · ');
    case 'MeterValues':
      return powerText(p.meterValue) ?? '';
    case 'TransactionEvent': {
      const tx = str((p.transactionInfo as Json | undefined)?.transactionId);
      return [
        `${str(p.eventType)} · tx ${tx.slice(0, 4)}`,
        powerText(p.meterValue),
      ]
        .filter(Boolean)
        .join(' · ');
    }
    case 'StartTransaction':
      return `Connector ${str(p.connectorId)} · ${str(p.idTag)}`;
    case 'StopTransaction':
      return [`tx ${str(p.transactionId)}`, str(p.reason)]
        .filter(Boolean)
        .join(' · ');
    case 'RequestStartTransaction':
      return `EVSE ${str(p.evseId)} · ${str((p.idToken as Json | undefined)?.idToken)}`;
    case 'RemoteStartTransaction':
      return `Connector ${str(p.connectorId)} · ${str(p.idTag)}`;
    case 'TriggerMessage':
      return str(p.requestedMessage);
    case 'Reset':
      return str(p.type);
    case 'UnlockConnector':
      return 'evseId' in p
        ? `EVSE ${str(p.evseId)}`
        : `Connector ${str(p.connectorId)}`;
    case 'Authorize':
      return str((p.idToken as Json | undefined)?.idToken ?? p.idTag);
    default:
      return '';
  }
}

/** Reads Power.Active.Import out of either protocol's meterValue array. */
export function powerWatts(meterValue: unknown): number | undefined {
  if (!Array.isArray(meterValue)) {
    return undefined;
  }
  for (const mv of meterValue as Json[]) {
    for (const sv of (mv.sampledValue ?? []) as Json[]) {
      if (sv.measurand !== 'Power.Active.Import') {
        continue;
      }
      const value = Number(sv.value);
      const unit =
        (sv.unitOfMeasure as Json | undefined)?.unit ?? sv.unit ?? 'W';
      if (Number.isFinite(value)) {
        return Math.round(unit === 'kW' ? value * 1000 : value);
      }
    }
  }
  return undefined;
}

/** Every reading in either protocol's meterValue array: time, energy register, power, SoC. */
export function meterReadings(meterValue: unknown) {
  if (!Array.isArray(meterValue)) {
    return [];
  }
  return (meterValue as Json[]).map((mv) => {
    const reading: {
      at: Date;
      registerWh?: number;
      powerW?: number;
      socPct?: number;
    } = { at: new Date(str(mv.timestamp)) };
    for (const sv of (mv.sampledValue ?? []) as Json[]) {
      const value = Number(sv.value);
      if (!Number.isFinite(value)) continue;
      const unit = str((sv.unitOfMeasure as Json | undefined)?.unit ?? sv.unit);
      const measurand = sv.measurand ?? 'Energy.Active.Import.Register';
      if (measurand === 'Energy.Active.Import.Register') {
        reading.registerWh = Math.round(unit === 'kWh' ? value * 1000 : value);
      } else if (measurand === 'Power.Active.Import') {
        reading.powerW = Math.round(unit === 'kW' ? value * 1000 : value);
      } else if (measurand === 'SoC') {
        reading.socPct = Math.round(value);
      }
    }
    return reading;
  });
}

function powerText(meterValue: unknown) {
  const watts = powerWatts(meterValue);
  return watts === undefined
    ? undefined
    : `Power.Active.Import ${(watts / 1000).toFixed(1)} kW`;
}
