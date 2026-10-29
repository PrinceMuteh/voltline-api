import 'dotenv/config';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { RPCClient } from 'ocpp-rpc';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

// Phase 3's bar: a simulated session is priced exactly as the tariff preview says,
// even after the charger replays its messages on a reconnect.
describe('Sessions and billing (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let base: string;
  let cookies: string[];
  let siteId: string;
  let tariffId: string;
  const stamp = Date.now();
  const email = `billing-${stamp}@voltline.test`;
  const clients: RPCClient[] = [];

  const api = () => request(app.getHttpServer());
  const authed = (req: request.Test) => req.set('Cookie', cookies);

  // Standard DC from the Tariffs design
  const rates = {
    perKwhKobo: 30_000,
    perMinuteKobo: 0,
    sessionFeeKobo: 20_000,
    idleGraceMin: 15,
    idlePerMinuteKobo: 5_000,
    peakFrom: '18:00',
    peakTo: '22:00',
    peakSurchargeBps: 1_500,
    vatIncluded: true,
    vatBps: 750,
  };

  /** Registers, approves and connects a charger; returns the connected OCPP client. */
  const connectCharger = async (
    id: string,
    protocol: 'ocpp2.0.1' | 'ocpp1.6',
  ) => {
    const created = await authed(api().post('/v1/console/chargers'))
      .send({
        chargePointId: id,
        siteId,
        model: 'DC60',
        connectors: [{ type: 'CCS2', maxKw: 60 }],
      })
      .expect(201);
    await authed(
      api().post(`/v1/console/chargers/${created.body.charger.id}/approve`),
    ).expect(200);
    const dial = async () => {
      const client = new RPCClient({
        endpoint: `${base.replace('http', 'ws')}/ocpp`,
        identity: id,
        password: created.body.password,
        protocols: [protocol],
        strictMode: true,
        reconnect: false,
      } as never);
      clients.push(client);
      client.handle('TriggerMessage', () =>
        Promise.resolve({ status: 'Accepted' }),
      );
      await client.connect();
      return client;
    };
    return { chargerId: created.body.charger.id as string, dial };
  };

  const sessionFor = (chargerId: string) =>
    prisma.session.findFirstOrThrow({
      where: { chargerId },
      include: { _count: { select: { samples: true, events: true } } },
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.listen(0);
    const { port } = (
      app.getHttpServer() as unknown as Server
    ).address() as AddressInfo;
    base = `http://localhost:${port}`;
    prisma = app.get(PrismaService);

    const res = await api()
      .post('/v1/auth/sign-up')
      .send({
        name: 'Billing Admin',
        company: 'Billing E2E Ltd',
        email,
        password: 'correct-horse-9',
        country: 'NG',
        chargerCount: 'ONE_TO_TEN',
      })
      .expect(204);
    cookies = res.headers['set-cookie'] as unknown as string[];

    // A site (through a first charger) and the Standard DC tariff on it
    const first = await authed(api().post('/v1/console/chargers'))
      .send({
        chargePointId: `BIL-${stamp}-0`,
        newSiteName: 'Billing Site',
        connectors: [{ type: 'CCS2', maxKw: 60 }],
      })
      .expect(201);
    siteId = first.body.charger.siteId;
    const tariff = await authed(api().post('/v1/console/tariffs'))
      .send({ name: 'Standard DC', siteIds: [siteId], ...rates })
      .expect(201);
    tariffId = tariff.body.id;
  });

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close({ force: true })));
    const user = await prisma.user.findUnique({
      where: { email },
      include: { memberships: true },
    });
    if (user) {
      const ids = user.memberships.map((m) => m.workspaceId);
      await prisma.session.deleteMany({ where: { workspaceId: { in: ids } } });
      await prisma.workspace.deleteMany({ where: { id: { in: ids } } });
      await prisma.user.delete({ where: { id: user.id } });
    }
    await app.close();
  });

  it('previews the plan’s worked example: ₦11,000 with ₦767 VAT', async () => {
    const res = await authed(api().post('/v1/console/tariffs/preview'))
      .send({ rates, energyKwh: 30, pluggedMinutes: 60, atPeak: true })
      .expect(200);
    expect(res.body.chargingMinutes).toBe(36);
    expect(res.body.breakdown).toMatchObject({
      energyKobo: 900_000,
      peakKobo: 135_000,
      sessionFeeKobo: 20_000,
      idleMinutes: 9,
      idleKobo: 45_000,
      vatKobo: 76_744,
      totalKobo: 1_100_000,
    });
  });

  it('bills a 2.0.1 session exactly as previewed, even after a replayed reconnect', async () => {
    const { chargerId, dial } = await connectCharger(
      `BIL-${stamp}-201`,
      'ocpp2.0.1',
    );
    // 18:30 in Lagos (peak), 30 kWh over 36 minutes, unplugged at 60 minutes
    const start = Date.parse('2026-10-27T17:30:00Z');
    const at = (min: number) => new Date(start + min * 60_000).toISOString();
    const reg = (min: number, wh: number) => [
      {
        timestamp: at(min),
        sampledValue: [
          {
            value: wh,
            measurand: 'Energy.Active.Import.Register',
            unitOfMeasure: { unit: 'Wh' },
          },
          {
            value: 50_000,
            measurand: 'Power.Active.Import',
            unitOfMeasure: { unit: 'W' },
          },
        ],
      },
    ];
    const tx = `tx-${stamp}`;
    const messages = [
      {
        eventType: 'Started',
        timestamp: at(0),
        triggerReason: 'Authorized',
        seqNo: 0,
        transactionInfo: { transactionId: tx, chargingState: 'Charging' },
        idToken: { idToken: 'VOLTLINE-OPS', type: 'Central' },
        evse: { id: 1, connectorId: 1 },
        meterValue: reg(0, 500_000),
      },
      ...[12, 24, 36].map((min, i) => ({
        eventType: 'Updated',
        timestamp: at(min),
        triggerReason: 'MeterValuePeriodic',
        seqNo: i + 1,
        transactionInfo: { transactionId: tx, chargingState: 'Charging' },
        evse: { id: 1, connectorId: 1 },
        meterValue: reg(min, 500_000 + (min / 36) * 30_000),
      })),
      {
        eventType: 'Updated',
        timestamp: at(36),
        triggerReason: 'ChargingStateChanged',
        seqNo: 4,
        transactionInfo: { transactionId: tx, chargingState: 'SuspendedEV' },
        evse: { id: 1, connectorId: 1 },
      },
      {
        eventType: 'Ended',
        timestamp: at(60),
        triggerReason: 'EVDeparted',
        seqNo: 5,
        transactionInfo: {
          transactionId: tx,
          chargingState: 'Idle',
          stoppedReason: 'EVDisconnected',
        },
        evse: { id: 1, connectorId: 1 },
        meterValue: reg(60, 530_000),
      },
    ];

    let client = await dial();
    for (const m of messages) {
      await client.call('TransactionEvent', m);
    }
    const billed = await sessionFor(chargerId);
    expect(billed).toMatchObject({
      status: 'COMPLETED',
      energyWh: 30_000,
      amountKobo: 1_100_000,
      tariffId,
    });

    // The charger reconnects and replays its whole queue, out of order
    await client.close({ code: 1000 });
    client = await dial();
    for (const m of [...messages].reverse()) {
      await client.call('TransactionEvent', m);
    }
    const replayed = await sessionFor(chargerId);
    expect(replayed.amountKobo).toBe(1_100_000);
    expect(replayed.energyWh).toBe(30_000);
    expect(replayed._count).toEqual(billed._count);
    expect(await prisma.session.count({ where: { chargerId } })).toBe(1);

    const detail = await authed(
      api().get(`/v1/console/sessions/${billed.id}`),
    ).expect(200);
    expect(detail.body.timeline.map((t: { label: string }) => t.label)).toEqual(
      ['Authorized', 'Charging started', 'EV finished', 'Ended'],
    );
    expect(detail.body.billing).toMatchObject({
      totalKobo: 1_100_000,
      vatKobo: 76_744,
      final: true,
    });
    expect(detail.body.peakPowerW).toBe(50_000);
  });

  it('gives a replayed 1.6J StartTransaction the same id and bills a fault stop for energy only', async () => {
    const { chargerId, dial } = await connectCharger(
      `BIL-${stamp}-16`,
      'ocpp1.6',
    );
    const client = await dial();
    const start = {
      connectorId: 1,
      idTag: 'VOLTLINE-OPS',
      meterStart: 200_000,
      timestamp: '2026-10-27T05:48:00Z',
    };
    const first = (await client.call('StartTransaction', start)) as {
      transactionId: number;
    };
    const again = (await client.call('StartTransaction', start)) as {
      transactionId: number;
    };
    expect(again.transactionId).toBe(first.transactionId);

    const stop = {
      transactionId: first.transactionId,
      meterStop: 206_100,
      timestamp: '2026-10-27T06:00:00Z',
      reason: 'EmergencyStop',
    };
    await client.call('StopTransaction', stop);
    await client.call('StopTransaction', stop);

    const session = await sessionFor(chargerId);
    expect(session).toMatchObject({
      status: 'STOPPED_BY_FAULT',
      energyWh: 6_100,
      amountKobo: 183_000, // 6.1 kWh × ₦300: no session fee or idle on a fault stop
    });
  });

  it('versions a tariff whose prices change after it has billed sessions', async () => {
    const res = await authed(api().put(`/v1/console/tariffs/${tariffId}`))
      .send({
        name: 'Standard DC',
        siteIds: [siteId],
        ...rates,
        perKwhKobo: 32_000,
      })
      .expect(200);
    expect(res.body.id).not.toBe(tariffId);
    expect(res.body.version).toBe(2);

    // Sessions already billed keep the version they started on
    const old = await prisma.session.findMany({ where: { tariffId } });
    expect(old.map((s) => s.amountKobo)).toContain(1_100_000);
    const list = await authed(api().get('/v1/console/tariffs')).expect(200);
    expect(list.body.map((t: { id: string }) => t.id)).toEqual([res.body.id]);
  });

  it('lists the sessions with totals and exports them as CSV', async () => {
    const res = await authed(
      api().get('/v1/console/sessions?range=30d'),
    ).expect(200);
    expect(res.body.totals).toMatchObject({
      sessions: 2,
      energyWh: 36_100,
      billedKobo: 1_283_000,
      needsReview: 1,
    });
    expect(res.body.counts).toEqual({
      all: 2,
      active: 0,
      completed: 1,
      issues: 1,
    });
    expect(res.body.rows[0].driver).toBe('Operator remote start');

    // Search: a word that is not a card must not match every card UID
    const none = await authed(
      api().get('/v1/console/sessions?range=30d&q=zzz'),
    ).expect(200);
    expect(none.body.rows).toHaveLength(0);
    const byCharger = await authed(
      api().get(`/v1/console/sessions?range=30d&q=BIL-${stamp}-16`),
    ).expect(200);
    expect(byCharger.body.rows).toHaveLength(1);

    const csv = await authed(
      api().get('/v1/console/sessions/export.csv?range=30d&status=issues'),
    ).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.text.trim().split('\r\n');
    expect(lines[0]).toBe(
      'Session,Driver,Charger,Site,Started,Ended,Duration (min),Energy (kWh),Amount (NGN),Status,Tariff',
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('STOPPED_BY_FAULT');
    expect(lines[1]).toContain('1830.00');
  });
});
