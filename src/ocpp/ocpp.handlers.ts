import type { ChargerStatus } from '../generated/prisma/enums.js';
import type { SessionRecorder } from '../sessions/session-recorder.service.js';
import type { ChargerStateService } from './charger-state.service.js';
import { meterReadings, powerWatts } from './ocpp-messages.service.js';
import type { ChargerClient } from './ocpp.types.js';

type Params = Record<string, any>;
type Handler = (params: Params) => Promise<object>;

/** How long a Pending charger waits before sending BootNotification again. */
const PENDING_RETRY_SEC = 60;

/** 2.0.1 charging states (and 1.6J statuses) that mean the car stopped drawing power. */
const NOT_CHARGING = new Set([
  'SuspendedEV',
  'EVConnected',
  'Idle',
  'Finishing',
]);

/**
 * The two protocol adapters. Each translates its version's messages into the same calls on
 * ChargerStateService and SessionRecorder, so nothing past this file branches on 1.6J vs 2.0.1.
 * Frames are already validated against the official JSON schemas (ocpp-rpc strict mode).
 */
export function registerHandlers(
  client: ChargerClient,
  state: ChargerStateService,
  recorder: SessionRecorder,
  onPending: () => void,
) {
  const s = client.session;
  const now = () => new Date().toISOString();

  const boot = async (info: {
    vendor?: string;
    model?: string;
    firmware?: string;
  }) => {
    const status = await state.boot(s, info);
    if (status === 'Pending') {
      onPending();
    }
    return {
      status,
      currentTime: now(),
      interval:
        status === 'Accepted'
          ? await state.heartbeatInterval(s)
          : PENDING_RETRY_SEC,
    };
  };

  const handlers: Record<string, Handler> =
    s.protocol === 'ocpp2.0.1'
      ? {
          BootNotification: async (p) =>
            boot({
              vendor: p.chargingStation?.vendorName,
              model: p.chargingStation?.model,
              firmware: p.chargingStation?.firmwareVersion,
            }),
          Heartbeat: async () => ({ currentTime: now() }),
          StatusNotification: async (p) => {
            await state.connectorStatus(s, {
              evseId: p.evseId,
              connectorId: p.connectorId,
              status: STATUS_201[p.connectorStatus as string] ?? 'UNAVAILABLE',
            });
            return {};
          },
          NotifyEvent: async (p) => {
            for (const e of (p.eventData ?? []) as Params[]) {
              if (e.variable?.name === 'Problem' && e.actualValue === 'true') {
                await state.fault(s, e.techCode ?? 'Fault reported');
              }
            }
            return {};
          },
          MeterValues: async (p) => {
            const watts = powerWatts(p.meterValue);
            if (watts !== undefined) {
              state.meter(s, p.evseId, watts);
            }
            return {};
          },
          TransactionEvent: async (p) => {
            const evseId = p.evse?.id as number | undefined;
            const at = new Date(p.timestamp as string);
            const readings = meterReadings(p.meterValue);
            const watts = powerWatts(p.meterValue);
            if (p.eventType === 'Ended') {
              state.endTransaction(s, evseId);
            } else if (watts !== undefined && evseId !== undefined) {
              state.meter(s, evseId, watts);
            }
            const authorized = p.idToken
              ? await state.isAuthorized(
                  s.workspaceId,
                  p.idToken.idToken,
                  p.idToken.type,
                )
              : undefined;

            const info = p.transactionInfo as Params;
            let session = await recorder.ensure(s, {
              transactionId: info.transactionId,
              evseId,
              at,
              idTag: p.idToken?.idToken,
              meterStartWh:
                p.eventType === 'Started' ? readings[0]?.registerWh : undefined,
            });
            const key = `seq:${p.seqNo}`;
            if (p.eventType === 'Started') {
              await recorder.event(
                session,
                key,
                'Started',
                at,
                'TransactionEvent · Started',
              );
              if (p.idToken) {
                await recorder.event(
                  session,
                  `${key}:auth`,
                  'Authorized',
                  at,
                  `idToken ${authorized ? 'Accepted' : 'Invalid'}`,
                );
              }
            } else if (p.eventType === 'Ended') {
              await recorder.event(
                session,
                key,
                'Ended',
                at,
                `TransactionEvent · Ended · ${info.stoppedReason ?? 'Local'}`,
              );
            } else {
              await recorder.event(session, key, 'Updated', at);
            }

            session = await recorder.meter(s, session, readings);
            const chargingState = info.chargingState as string | undefined;
            // The final Idle on an Ended event is the unplug, not the end of charging
            if (
              chargingState &&
              NOT_CHARGING.has(chargingState) &&
              p.eventType !== 'Ended'
            ) {
              await recorder.event(
                session,
                `${key}:state`,
                'EVFinished',
                at,
                chargingState,
              );
              session = await recorder.chargingEnded(s, session, at);
            } else if (chargingState === 'Charging') {
              session = await recorder.chargingResumed(s, session, at);
            }
            if (p.eventType === 'Ended') {
              await recorder.end(s, session, at, info.stoppedReason ?? 'Local');
            }

            return authorized === undefined
              ? {}
              : {
                  idTokenInfo: { status: authorized ? 'Accepted' : 'Invalid' },
                };
          },
          Authorize: async (p) => {
            const ok = await state.isAuthorized(
              s.workspaceId,
              p.idToken.idToken,
              p.idToken.type,
            );
            return { idTokenInfo: { status: ok ? 'Accepted' : 'Invalid' } };
          },
          FirmwareStatusNotification: async () => ({}),
          SecurityEventNotification: async () => ({}),
          LogStatusNotification: async () => ({}),
          NotifyReport: async () => ({}),
          DataTransfer: async () => ({ status: 'UnknownVendorId' }),
        }
      : {
          BootNotification: async (p) =>
            boot({
              vendor: p.chargePointVendor,
              model: p.chargePointModel,
              firmware: p.firmwareVersion,
            }),
          Heartbeat: async () => ({ currentTime: now() }),
          StatusNotification: async (p) => {
            await state.connectorStatus(s, {
              // 1.6J has no EVSEs: connector N is EVSE N with a single connector
              evseId: p.connectorId,
              connectorId: 1,
              status: STATUS_16[p.status as string] ?? 'UNAVAILABLE',
              errorCode: p.errorCode === 'NoError' ? undefined : p.errorCode,
            });
            // Within a transaction, SuspendedEV / Finishing mark the end of charging (idle starts)
            if (p.connectorId > 0) {
              const active = await recorder.activeOn(
                s.chargerId,
                p.connectorId,
              );
              const at = p.timestamp
                ? new Date(p.timestamp as string)
                : new Date();
              if (active && NOT_CHARGING.has(p.status as string)) {
                await recorder.event(
                  active,
                  `status:${at.toISOString()}:${p.status}`,
                  'EVFinished',
                  at,
                  p.status,
                );
                await recorder.chargingEnded(s, active, at);
              } else if (active && p.status === 'Charging') {
                await recorder.chargingResumed(s, active, at);
              }
            }
            return {};
          },
          MeterValues: async (p) => {
            const watts = powerWatts(p.meterValue);
            if (watts !== undefined) {
              state.meter(s, p.connectorId, watts);
            }
            const session = p.transactionId
              ? await recorder.byTransaction(
                  s.chargerId,
                  String(p.transactionId),
                )
              : await recorder.activeOn(s.chargerId, p.connectorId);
            if (session) {
              await recorder.meter(s, session, meterReadings(p.meterValue));
            }
            return {};
          },
          Authorize: async (p) => ({
            idTagInfo: {
              status: (await state.isAuthorized(s.workspaceId, p.idTag))
                ? 'Accepted'
                : 'Invalid',
            },
          }),
          StartTransaction: async (p) => {
            const authorized = await state.isAuthorized(s.workspaceId, p.idTag);
            const idTagInfo = { status: authorized ? 'Accepted' : 'Invalid' };
            if (!authorized) {
              // The charger must not start; no session is opened for a refused card
              return { transactionId: 0, idTagInfo };
            }
            const at = new Date(p.timestamp as string);
            const session = await recorder.startTransaction16(s, {
              evseId: p.connectorId,
              at,
              idTag: p.idTag,
              meterStartWh: p.meterStart,
            });
            const key = `start:${at.toISOString()}`;
            await recorder.event(
              session,
              key,
              'Started',
              at,
              'StartTransaction',
            );
            await recorder.event(
              session,
              `${key}:auth`,
              'Authorized',
              at,
              'idTag Accepted',
            );
            await recorder.meter(s, session, [
              { at, registerWh: p.meterStart },
            ]);
            return { transactionId: Number(session.transactionId), idTagInfo };
          },
          StopTransaction: async (p) => {
            state.endTransaction(s, undefined);
            const session = await recorder.byTransaction(
              s.chargerId,
              String(p.transactionId),
            );
            if (session) {
              const at = new Date(p.timestamp as string);
              const reason = (p.reason as string | undefined) ?? 'Local';
              await recorder.event(
                session,
                `stop:${at.toISOString()}:${p.meterStop}`,
                'Ended',
                at,
                `StopTransaction · ${reason}`,
              );
              const updated = await recorder.meter(s, session, [
                ...meterReadings(p.transactionData),
                { at, registerWh: p.meterStop },
              ]);
              await recorder.end(s, updated, at, reason);
            }
            return {};
          },
          FirmwareStatusNotification: async () => ({}),
          DiagnosticsStatusNotification: async () => ({}),
          DataTransfer: async () => ({ status: 'UnknownVendorId' }),
        };

  for (const [method, handler] of Object.entries(handlers)) {
    client.handle(method, ({ params }) => handler((params ?? {}) as Params));
  }
}

const STATUS_201: Record<string, ChargerStatus> = {
  Available: 'AVAILABLE',
  Occupied: 'CHARGING',
  Reserved: 'AVAILABLE',
  Unavailable: 'UNAVAILABLE',
  Faulted: 'FAULTED',
};

const STATUS_16: Record<string, ChargerStatus> = {
  Available: 'AVAILABLE',
  Preparing: 'AVAILABLE',
  Charging: 'CHARGING',
  SuspendedEVSE: 'CHARGING',
  SuspendedEV: 'CHARGING',
  Finishing: 'AVAILABLE',
  Reserved: 'AVAILABLE',
  Unavailable: 'UNAVAILABLE',
  Faulted: 'FAULTED',
};
