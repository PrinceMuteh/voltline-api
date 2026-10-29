// A development charger that speaks OCPP 2.0.1 or 1.6J to the gateway the way real hardware does:
// BootNotification (retrying while Pending), heartbeats, connector status, transactions with an
// energy register, and answers to TriggerMessage, Reset, UnlockConnector and remote start/stop.
// A "charging" charger runs real sessions: card tap, charge to a target, idle, unplug, repeat.
import { randomUUID } from 'node:crypto';
import { RPCClient } from 'ocpp-rpc';

export type SimState = 'available' | 'charging' | 'faulted';

export interface SimOptions {
  url: string;
  id: string;
  password: string;
  protocol: 'ocpp2.0.1' | 'ocpp1.6';
  vendor: string;
  model: string;
  firmware: string;
  connectors: number;
  maxKw: number;
  state: SimState;
  /** Power drawn while charging; defaults to 70% of maxKw. */
  powerKw?: number;
  /** Error code reported in the faulted state. */
  fault?: string;
  /** Seconds between meter readings while charging. */
  meterEverySec: number;
  /** RFID cards used for sessions it starts by itself, in turn; defaults to a remote-start tag. */
  idTags?: string[];
  /** Each session stops drawing power after this much energy; without it, it charges forever. */
  targetKwh?: number;
  /** Seconds plugged in after charging finishes (idle time), before unplugging. */
  idleSec?: number;
  /** Seconds before the next car plugs in; without it, one session only. */
  nextAfterSec?: number;
}

interface Evse {
  id: number;
  state: SimState;
  powerW: number;
  /** Lifetime energy register, Wh: it only ever grows. */
  energyWh: number;
  txId?: string | number;
  seqNo: number;
  /** The car is plugged in but no longer drawing power (SuspendedEV). */
  idle: boolean;
  sessionStartWh: number;
  /** Taken out of service with ChangeAvailability Inoperative. */
  inoperative: boolean;
  /** Battery %, reported by DC chargers (the car talks to them). */
  soc: number | null;
  /** Held for one card by ReserveNow until it expires or is cancelled. */
  reservation?: { id: number; idTag: string; timer: NodeJS.Timeout };
}

type Params = Record<string, any>;

export function startCharger(o: SimOptions) {
  const v201 = o.protocol === 'ocpp2.0.1';
  const log = (...args: unknown[]) => console.log(`[${o.id}]`, ...args);
  const now = () => new Date().toISOString();
  const chargingPower = () => Math.round((o.powerKw ?? o.maxKw * 0.7) * 1000);

  const evses: Evse[] = Array.from({ length: o.connectors }, (_, i) => ({
    id: i + 1,
    state: o.state,
    powerW: o.state === 'charging' ? chargingPower() : 0,
    energyWh: 1_000_000 + Math.floor(Math.random() * 500_000),
    seqNo: 0,
    idle: false,
    sessionStartWh: 0,
    inoperative: false,
    soc: null,
  }));
  /** The RFID cards the CSMS sent with SendLocalList (used while offline on real hardware). */
  let localList: { version: number; tags: string[] } = { version: 0, tags: [] };
  const dc = o.maxKw >= 50;
  let meterEvery = o.meterEverySec;
  /** Settings the console can read and change; meter intervals take effect at once. */
  const settings201: Record<string, string> = {
    'OCPPCommCtrlr/HeartbeatInterval': '300',
    'OCPPCommCtrlr/WebSocketPingInterval': '30',
    'SampledDataCtrlr/TxUpdatedInterval': String(o.meterEverySec),
    'SampledDataCtrlr/TxUpdatedMeasurands':
      'Energy.Active.Import.Register,Power.Active.Import,SoC',
    'AuthCtrlr/AuthorizeRemoteStart': 'false',
    'AuthCtrlr/LocalPreAuthorize': 'false',
    'AuthCacheCtrlr/Enabled': 'true',
    'LocalAuthListCtrlr/Enabled': 'true',
    'TxCtrlr/EVConnectionTimeOut': '120',
    'TxCtrlr/StopTxOnEVSideDisconnect': 'true',
  };
  const settings16: Record<string, { value: string; readonly: boolean }> = {
    HeartbeatInterval: { value: '300', readonly: false },
    MeterValueSampleInterval: {
      value: String(o.meterEverySec),
      readonly: false,
    },
    MeterValuesSampledData: {
      value: 'Energy.Active.Import.Register,Power.Active.Import',
      readonly: false,
    },
    ConnectionTimeOut: { value: '120', readonly: false },
    LocalAuthorizeOffline: { value: 'true', readonly: false },
    LocalPreAuthorize: { value: 'false', readonly: false },
    AuthorizeRemoteTxRequests: { value: 'false', readonly: false },
    NumberOfConnectors: { value: String(o.connectors), readonly: true },
    SupportedFeatureProfiles: {
      value: 'Core,RemoteTrigger,LocalAuthListManagement,Reservation',
      readonly: true,
    },
  };
  let tagTurn = 0;
  const nextTag = () => {
    const tags = o.idTags ?? [];
    return tags.length ? tags[tagTurn++ % tags.length] : undefined;
  };

  const client = new RPCClient({
    endpoint: o.url,
    identity: o.id,
    password: o.password,
    protocols: [o.protocol],
    strictMode: true,
    reconnect: true,
  } as never);

  let timers: NodeJS.Timeout[] = [];
  const clearTimers = () => {
    timers.forEach((t) => clearTimeout(t));
    timers = [];
  };
  const later = (ms: number, fn: () => Promise<unknown> | void) => {
    timers.push(
      setTimeout(() => {
        void Promise.resolve(fn()).catch((e: unknown) =>
          log('error', String(e)),
        );
      }, ms),
    );
  };
  const call = (method: string, params: Params) =>
    client.call(method, params) as Promise<Params>;

  // ─── Outbound ─────────────────────────────────────────────────────────────

  async function boot() {
    const res = v201
      ? await call('BootNotification', {
          reason: 'PowerUp',
          chargingStation: {
            vendorName: o.vendor,
            model: o.model,
            firmwareVersion: o.firmware,
          },
        })
      : await call('BootNotification', {
          chargePointVendor: o.vendor,
          chargePointModel: o.model,
          firmwareVersion: o.firmware,
        });
    log(
      `BootNotification → ${String(res.status)} (interval ${String(res.interval)} s)`,
    );
    if (res.status !== 'Accepted') {
      later(Number(res.interval) * 1000, boot);
      return;
    }
    clearTimers();
    for (const evse of evses) {
      await status(evse);
    }
    if (v201) {
      for (const evse of evses.filter((e) => e.state === 'faulted')) {
        await problem(evse);
      }
    }
    heartbeatLoop(Number(res.interval));
    meterLoop();
    // A charger that boots mid-charge has a car on it: open the session
    for (const evse of evses.filter((e) => e.state === 'charging' && !e.txId)) {
      await startTx(evse, nextTag());
    }
    // After a reconnect, a car that had finished charging still needs to unplug
    for (const evse of evses.filter((e) => e.idle && e.txId)) {
      later((o.idleSec ?? 60) * 1000, () => stopTx(evse, 'EVDisconnected'));
    }
  }

  function heartbeatLoop(intervalSec: number) {
    later(intervalSec * 1000, async () => {
      await call('Heartbeat', {});
      heartbeatLoop(intervalSec);
    });
  }

  function meterLoop() {
    later(meterEvery * 1000, async () => {
      for (const evse of evses.filter(
        (e) => e.state === 'charging' && !e.idle,
      )) {
        // ±3% wobble so the console shows a live number
        evse.powerW = Math.round(
          chargingPower() * (0.97 + Math.random() * 0.06),
        );
        const addedWh = Math.round((evse.powerW * meterEvery) / 3600);
        evse.energyWh += addedWh;
        // A 60 kWh battery filling up
        if (evse.soc !== null) {
          evse.soc = Math.min(100, evse.soc + (addedWh / 60_000) * 100);
        }
        await meter(evse);
        if (
          o.targetKwh &&
          evse.txId &&
          evse.energyWh - evse.sessionStartWh >= o.targetKwh * 1000
        ) {
          await finishCharging(evse);
        }
      }
      meterLoop();
    });
  }

  async function status(evse: Evse) {
    if (v201) {
      await call('StatusNotification', {
        timestamp: now(),
        connectorStatus:
          evse.inoperative && evse.state !== 'charging'
            ? 'Unavailable'
            : evse.reservation && evse.state === 'available'
              ? 'Reserved'
              : {
                  available: 'Available',
                  charging: 'Occupied',
                  faulted: 'Faulted',
                }[evse.state],
        evseId: evse.id,
        connectorId: 1,
      });
    } else {
      await call('StatusNotification', {
        connectorId: evse.id,
        errorCode:
          evse.state === 'faulted' ? (o.fault ?? 'GroundFailure') : 'NoError',
        status: evse.idle
          ? 'SuspendedEV'
          : evse.inoperative && evse.state !== 'charging'
            ? 'Unavailable'
            : evse.reservation && evse.state === 'available'
              ? 'Reserved'
              : {
                  available: 'Available',
                  charging: 'Charging',
                  faulted: 'Faulted',
                }[evse.state],
        timestamp: now(),
      });
    }
  }

  /** 2.0.1 has no errorCode in StatusNotification; the fault code travels in NotifyEvent. */
  async function problem(evse: Evse) {
    await call('NotifyEvent', {
      generatedAt: now(),
      seqNo: 0,
      eventData: [
        {
          eventId: Math.floor(Math.random() * 1e6),
          timestamp: now(),
          trigger: 'Delta',
          actualValue: 'true',
          techCode: o.fault ?? 'GroundFailure',
          eventNotificationType: 'HardWiredNotification',
          component: {
            name: 'Connector',
            evse: { id: evse.id, connectorId: 1 },
          },
          variable: { name: 'Problem' },
        },
      ],
    });
  }

  function sampled(evse: Evse) {
    const soc =
      evse.soc === null || !evse.txId
        ? []
        : [
            v201
              ? {
                  value: Math.round(evse.soc),
                  measurand: 'SoC',
                  location: 'EV',
                  unitOfMeasure: { unit: 'Percent' },
                }
              : {
                  value: String(Math.round(evse.soc)),
                  measurand: 'SoC',
                  location: 'EV',
                  unit: 'Percent',
                },
          ];
    return [...soc, ...readings(evse)];
  }

  function readings(evse: Evse) {
    return v201
      ? [
          {
            value: evse.powerW,
            measurand: 'Power.Active.Import',
            unitOfMeasure: { unit: 'W' },
          },
          {
            value: evse.energyWh,
            measurand: 'Energy.Active.Import.Register',
            unitOfMeasure: { unit: 'Wh' },
          },
        ]
      : [
          {
            value: String(evse.powerW),
            measurand: 'Power.Active.Import',
            unit: 'W',
          },
          {
            value: String(evse.energyWh),
            measurand: 'Energy.Active.Import.Register',
            unit: 'Wh',
          },
        ];
  }

  async function meter(evse: Evse) {
    const meterValue = [{ timestamp: now(), sampledValue: sampled(evse) }];
    if (v201 && evse.txId) {
      await call('TransactionEvent', {
        eventType: 'Updated',
        timestamp: now(),
        triggerReason: 'MeterValuePeriodic',
        seqNo: ++evse.seqNo,
        transactionInfo: {
          transactionId: String(evse.txId),
          chargingState: evse.idle ? 'SuspendedEV' : 'Charging',
        },
        evse: { id: evse.id, connectorId: 1 },
        meterValue,
      });
    } else if (v201) {
      await call('MeterValues', { evseId: evse.id, meterValue });
    } else {
      await call('MeterValues', {
        connectorId: evse.id,
        ...(evse.txId ? { transactionId: evse.txId } : {}),
        meterValue,
      });
    }
  }

  /** A card tap (or remote start) on a free connector opens a transaction. */
  async function startTx(
    evse: Evse,
    idTag: string | undefined,
    remoteStartId?: number,
  ) {
    // A reserved connector is for its card: the reserved driver is the one who arrives
    const reservationId = evse.reservation?.id;
    if (evse.reservation) {
      clearTimeout(evse.reservation.timer);
      idTag = evse.reservation.idTag;
      evse.reservation = undefined;
    }
    const idToken = idTag ?? 'VOLTLINE-OPS';
    evse.state = 'charging';
    evse.idle = false;
    evse.powerW = chargingPower();
    evse.seqNo = 0;
    evse.sessionStartWh = evse.energyWh;
    evse.soc = dc ? 15 + Math.floor(Math.random() * 25) : null;
    const begin = [
      {
        timestamp: now(),
        sampledValue: [
          {
            value: evse.energyWh,
            measurand: 'Energy.Active.Import.Register',
            context: 'Transaction.Begin',
            unitOfMeasure: { unit: 'Wh' },
          },
        ],
      },
    ];
    if (v201) {
      evse.txId = randomUUID();
      await status(evse);
      await call('TransactionEvent', {
        eventType: 'Started',
        timestamp: now(),
        triggerReason:
          remoteStartId === undefined ? 'Authorized' : 'RemoteStart',
        seqNo: evse.seqNo,
        transactionInfo: {
          transactionId: evse.txId,
          chargingState: 'Charging',
          remoteStartId,
        },
        idToken: {
          idToken,
          type: remoteStartId === undefined && idTag ? 'ISO14443' : 'Central',
        },
        evse: { id: evse.id, connectorId: 1 },
        meterValue: begin,
        ...(reservationId !== undefined ? { reservationId } : {}),
      });
    } else {
      await status(evse);
      const res = await call('StartTransaction', {
        connectorId: evse.id,
        idTag: idToken,
        meterStart: evse.energyWh,
        timestamp: now(),
        ...(reservationId !== undefined ? { reservationId } : {}),
      });
      evse.txId = res.transactionId as number;
    }
    log(`Charging on EVSE ${evse.id} for ${idToken}`);
  }

  /** The car is full: power drops to zero and idle time starts, still plugged in. */
  async function finishCharging(evse: Evse) {
    evse.idle = true;
    evse.powerW = 0;
    if (v201) {
      await call('TransactionEvent', {
        eventType: 'Updated',
        timestamp: now(),
        triggerReason: 'ChargingStateChanged',
        seqNo: ++evse.seqNo,
        transactionInfo: {
          transactionId: String(evse.txId),
          chargingState: 'SuspendedEV',
        },
        evse: { id: evse.id, connectorId: 1 },
      });
    } else {
      await status(evse);
    }
    log(`EVSE ${evse.id} finished charging; idle`);
    later((o.idleSec ?? 60) * 1000, async () => {
      await stopTx(evse, 'EVDisconnected');
      if (o.nextAfterSec !== undefined) {
        later(o.nextAfterSec * 1000, () => startTx(evse, nextTag()));
      }
    });
  }

  async function stopTx(evse: Evse, reason: string) {
    const end = [
      {
        timestamp: now(),
        sampledValue: [
          {
            value: evse.energyWh,
            measurand: 'Energy.Active.Import.Register',
            context: 'Transaction.End',
            unitOfMeasure: { unit: 'Wh' },
          },
        ],
      },
    ];
    if (v201 && evse.txId) {
      await call('TransactionEvent', {
        eventType: 'Ended',
        timestamp: now(),
        triggerReason: reason === 'Remote' ? 'RemoteStop' : 'EVDeparted',
        seqNo: ++evse.seqNo,
        transactionInfo: {
          transactionId: String(evse.txId),
          chargingState: 'Idle',
          stoppedReason: reason,
        },
        evse: { id: evse.id, connectorId: 1 },
        meterValue: end,
      });
    } else if (evse.txId) {
      await call('StopTransaction', {
        transactionId: evse.txId,
        meterStop: evse.energyWh,
        timestamp: now(),
        reason,
      });
    }
    evse.txId = undefined;
    evse.state = 'available';
    evse.idle = false;
    evse.powerW = 0;
    await status(evse);
  }

  // ─── Inbound ──────────────────────────────────────────────────────────────

  const evseFor = (id: unknown) => evses.find((e) => e.id === Number(id ?? 1));
  const on = (method: string, fn: (params: Params) => object) =>
    client.handle(method, ({ params }) =>
      Promise.resolve(fn((params ?? {}) as Params)),
    );

  on('TriggerMessage', (params) => {
    const what = params.requestedMessage as string;
    log(`TriggerMessage ${what}`);
    later(100, async () => {
      if (what === 'BootNotification') {
        await boot();
      } else if (what === 'StatusNotification') {
        const target = params.evse?.id ?? params.connectorId;
        for (const evse of target ? [evseFor(target)!] : evses) {
          await status(evse);
        }
      } else if (what === 'Heartbeat') {
        await call('Heartbeat', {});
      }
    });
    return { status: 'Accepted' };
  });

  on('Reset', (params) => {
    const hard = params.type === 'Immediate' || params.type === 'Hard';
    log(`Reset ${String(params.type)}`);
    if (evses.some((e) => e.state === 'faulted') && !hard) {
      return v201
        ? { status: 'Rejected', statusInfo: { reasonCode: 'FaultActive' } }
        : { status: 'Rejected' };
    }
    later(500, async () => {
      for (const evse of evses.filter((e) => e.state === 'charging' && hard)) {
        await stopTx(evse, 'HardReset');
      }
      // Simulate the reboot: drop the socket and dial in again
      clearTimers();
      await client.close({ code: 1000, reason: 'Rebooting' });
      later(3000, () => client.connect());
    });
    return { status: 'Accepted' };
  });

  on('ChangeAvailability', (params) => {
    const operative = (params.operationalStatus ?? params.type) === 'Operative';
    const target = params.evse?.id ?? params.connectorId;
    const targets = target
      ? evses.filter((e) => e.id === Number(target))
      : evses;
    log(`ChangeAvailability ${operative ? 'Operative' : 'Inoperative'}`);
    // A car is charging: take it out of service once it leaves
    const busy = targets.some((e) => e.txId);
    later(100, async () => {
      for (const evse of targets) {
        evse.inoperative = !operative;
        if (!evse.txId) await status(evse);
      }
    });
    return { status: busy && !operative ? 'Scheduled' : 'Accepted' };
  });

  on('GetVariables', (params) => ({
    getVariableResult: (params.getVariableData as Params[]).map((d) => {
      const key = `${d.component.name}/${d.variable.name}`;
      const value = settings201[key];
      return value === undefined
        ? {
            attributeStatus: 'UnknownVariable',
            component: d.component,
            variable: d.variable,
          }
        : {
            attributeStatus: 'Accepted',
            attributeValue: value,
            component: d.component,
            variable: d.variable,
          };
    }),
  }));

  on('SetVariables', (params) => ({
    setVariableResult: (params.setVariableData as Params[]).map((d) => {
      const key = `${d.component.name}/${d.variable.name}`;
      if (settings201[key] === undefined) {
        return {
          attributeStatus: 'UnknownVariable',
          component: d.component,
          variable: d.variable,
        };
      }
      settings201[key] = String(d.attributeValue);
      if (
        key === 'SampledDataCtrlr/TxUpdatedInterval' &&
        Number(d.attributeValue) > 0
      ) {
        meterEvery = Number(d.attributeValue);
      }
      log(`SetVariables ${key} = ${String(d.attributeValue)}`);
      return {
        attributeStatus: 'Accepted',
        component: d.component,
        variable: d.variable,
      };
    }),
  }));

  on('GetConfiguration', (params) => {
    const wanted =
      (params.key as string[] | undefined) ?? Object.keys(settings16);
    return {
      configurationKey: wanted
        .filter((k) => settings16[k])
        .map((k) => ({
          key: k,
          readonly: settings16[k].readonly,
          value: settings16[k].value,
        })),
      unknownKey: wanted.filter((k) => !settings16[k]),
    };
  });

  on('ChangeConfiguration', (params) => {
    const item = settings16[params.key as string];
    if (!item) return { status: 'NotSupported' };
    if (item.readonly) return { status: 'Rejected' };
    item.value = String(params.value);
    if (params.key === 'MeterValueSampleInterval' && Number(params.value) > 0) {
      meterEvery = Number(params.value);
    }
    log(`ChangeConfiguration ${String(params.key)} = ${String(params.value)}`);
    return { status: 'Accepted' };
  });

  on('ReserveNow', (params) => {
    const evse = evseFor(params.evseId ?? params.connectorId);
    const id = Number(params.id ?? params.reservationId);
    const idTag = String(params.idToken?.idToken ?? params.idTag);
    const expires = Date.parse(
      String(params.expiryDateTime ?? params.expiryDate),
    );
    if (!evse) return { status: 'Rejected' };
    if (evse.state === 'faulted') return { status: 'Faulted' };
    if (evse.inoperative) return { status: 'Unavailable' };
    if (evse.state === 'charging' || evse.reservation)
      return { status: 'Occupied' };
    const timer = setTimeout(
      () => {
        if (evse.reservation?.id !== id) return;
        evse.reservation = undefined;
        log(`Reservation ${id} expired`);
        void (async () => {
          if (v201) {
            await call('ReservationStatusUpdate', {
              reservationId: id,
              reservationUpdateStatus: 'Expired',
            });
          }
          await status(evse);
        })().catch(() => undefined);
      },
      Math.max(0, expires - Date.now()),
    );
    evse.reservation = { id, idTag, timer };
    log(`Reserved EVSE ${evse.id} for ${idTag} (reservation ${id})`);
    later(100, () => status(evse));
    return { status: 'Accepted' };
  });

  on('CancelReservation', (params) => {
    const evse = evses.find(
      (e) => e.reservation?.id === Number(params.reservationId),
    );
    if (!evse?.reservation) return { status: 'Rejected' };
    clearTimeout(evse.reservation.timer);
    evse.reservation = undefined;
    log(`Reservation ${String(params.reservationId)} cancelled`);
    later(100, () => status(evse));
    return { status: 'Accepted' };
  });

  on('SendLocalList', (params) => {
    const entries = (params.localAuthorizationList ?? []) as Params[];
    localList = {
      version: Number(params.versionNumber ?? params.listVersion),
      tags: entries.map((e) => String(e.idToken?.idToken ?? e.idTag)),
    };
    log(`Local list v${localList.version}: ${localList.tags.length} cards`);
    return { status: 'Accepted' };
  });

  on('GetLocalListVersion', () =>
    v201
      ? { versionNumber: localList.version }
      : { listVersion: localList.version },
  );

  on('UnlockConnector', () => {
    log('UnlockConnector');
    return { status: 'Unlocked' };
  });

  const remoteStart = (
    evse: Evse | undefined,
    idToken: string,
    remoteStartId?: number,
  ) => {
    if (
      !evse ||
      evse.state !== 'available' ||
      evse.inoperative ||
      // Reserved for another card
      (evse.reservation && evse.reservation.idTag !== idToken)
    ) {
      return { status: 'Rejected' };
    }
    later(200, () => startTx(evse, idToken, remoteStartId));
    return { status: 'Accepted' };
  };
  on('RequestStartTransaction', (params) =>
    remoteStart(
      evseFor(params.evseId),
      params.idToken.idToken,
      params.remoteStartId,
    ),
  );
  on('RemoteStartTransaction', (params) =>
    remoteStart(evseFor(params.connectorId), params.idTag),
  );

  const remoteStop = (txId: unknown) => {
    const evse = evses.find(
      (e) => e.txId !== undefined && String(e.txId) === String(txId),
    );
    if (!evse) {
      return { status: 'Rejected' };
    }
    later(200, () => stopTx(evse, 'Remote'));
    return { status: 'Accepted' };
  };
  on('RequestStopTransaction', (params) => remoteStop(params.transactionId));
  on('RemoteStopTransaction', (params) => remoteStop(params.transactionId));

  client.on('open', () => {
    log(`connected over ${o.protocol}`);
    void boot().catch((e: unknown) => log('boot failed', String(e)));
  });
  client.on('close', ({ code, reason }: { code: number; reason: string }) => {
    clearTimers();
    log(`disconnected (${code}${reason ? ` ${reason}` : ''})`);
  });

  // Keep dialing until the gateway answers, like a charger waiting for its CSMS
  const dial = () => {
    client.connect().catch((e: unknown) => {
      log(
        `could not connect (${e instanceof Error ? e.message || e.name : String(e)}), retrying in 5 s`,
      );
      setTimeout(dial, 5000);
    });
  };
  dial();

  return {
    /** Unplugs any car first, so no session is left open on the server. */
    stop: async () => {
      clearTimers();
      // Give up after 3 s if the gateway is gone (the transaction stays open there)
      const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
      for (const evse of evses.filter((e) => e.txId)) {
        await Promise.race([stopTx(evse, 'Local'), timeout]).catch(
          () => undefined,
        );
      }
      await client.close({ code: 1000, reason: 'Simulator stopped' });
    },
  };
}
