import 'dotenv/config';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { RPCClient } from 'ocpp-rpc';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { startCharger } from '../scripts/sim/charger.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

// Sites, Settings › OCPP, local authorization lists (OC-09) and reservations (OC-10).
describe('Sites, OCPP settings, local lists and reservations (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let cookies: string[];
  let port: number;
  let workspaceId: string;
  let siteId: string;
  let cardId: string;
  const stamp = Date.now();
  const email = `sites-${stamp}@voltline.test`;
  const sims: ReturnType<typeof startCharger>[] = [];
  const clients: RPCClient[] = [];
  const api = () => request(app.getHttpServer());
  const authed = (req: request.Test) => req.set('Cookie', cookies);

  const until = async (check: () => Promise<boolean>, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('condition not met in time');
  };

  const addCharger = async (id: string) => {
    const created = await authed(api().post('/v1/console/chargers'))
      .send({
        chargePointId: id,
        siteId,
        connectors: [{ type: 'CCS2', maxKw: 60 }],
      })
      .expect(201);
    await authed(
      api().post(`/v1/console/chargers/${created.body.charger.id}/approve`),
    ).expect(200);
    return {
      chargerId: created.body.charger.id as string,
      password: created.body.password as string,
    };
  };
  const detail = async (chargerId: string) =>
    (await authed(api().get(`/v1/console/chargers/${chargerId}`)).expect(200))
      .body as {
      status: string;
      localListVersion: number;
      reservations: {
        id: string;
        status: string;
        idTag: string;
        driver: string | null;
      }[];
    };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.listen(0);
    port = ((app.getHttpServer() as unknown as Server).address() as AddressInfo)
      .port;
    prisma = app.get(PrismaService);

    const res = await api()
      .post('/v1/auth/sign-up')
      .send({
        name: 'Sites Admin',
        company: 'Sites E2E Ltd',
        email,
        password: 'correct-horse-9',
        country: 'NG',
        chargerCount: 'ONE_TO_TEN',
      })
      .expect(204);
    cookies = res.headers['set-cookie'] as unknown as string[];
    const me = await authed(api().get('/v1/console/me')).expect(200);
    workspaceId = me.body.workspace.id;

    // A driver with an RFID card (driver management arrives with the driver app)
    const driver = await prisma.driver.create({
      data: {
        workspaceId,
        name: 'Ada Lovelace',
        phone: `+234800${String(stamp).slice(-7)}`,
        idTokens: { create: { workspaceId, uid: '04:E2:E2:01' } },
      },
      include: { idTokens: true },
    });
    cardId = driver.idTokens[0].id;
  });

  afterAll(async () => {
    await Promise.all(sims.map((s) => s.stop().catch(() => undefined)));
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

  it('creates and edits a site with its map position and grid limit', async () => {
    const created = await authed(api().post('/v1/console/sites'))
      .send({ name: 'Ikeja City Mall', area: 'Ikeja, Lagos' })
      .expect(201);
    siteId = created.body.id;
    const edited = await authed(api().patch(`/v1/console/sites/${siteId}`))
      .send({
        latitude: 6.6142,
        longitude: 3.3576,
        gridLimitKw: 250,
        address: 'Obafemi Awolowo Way',
      })
      .expect(200);
    expect(edited.body).toMatchObject({
      latitude: 6.6142,
      longitude: 3.3576,
      gridLimitKw: 250,
      chargerCount: 0,
    });

    const dup = await authed(api().post('/v1/console/sites'))
      .send({ name: 'Ikeja City Mall' })
      .expect(409);
    expect(dup.body.message).toBe(
      'A site called Ikeja City Mall already exists.',
    );
    await authed(api().patch(`/v1/console/sites/${siteId}`))
      .send({ latitude: 200 })
      .expect(400);
  });

  it('reads and changes Settings › OCPP', async () => {
    const before = await authed(api().get('/v1/console/ocpp-settings')).expect(
      200,
    );
    expect(before.body).toMatchObject({
      accept16J: true,
      accept201: true,
      accept21: false,
      syncLocalLists: true,
    });
    const after = await authed(api().patch('/v1/console/ocpp-settings'))
      .send({ heartbeatIntervalSec: 120, autoApproveChargers: true })
      .expect(200);
    expect(after.body).toMatchObject({
      heartbeatIntervalSec: 120,
      autoApproveChargers: true,
    });
    await authed(api().patch('/v1/console/ocpp-settings'))
      .send({ heartbeatIntervalSec: 5 })
      .expect(400);
  });

  describe.each(['ocpp2.0.1', 'ocpp1.6'] as const)('over %s', (protocol) => {
    let chargerId: string;

    beforeAll(async () => {
      const id = `RSV-${stamp}-${protocol.replace(/\W/g, '')}`;
      const added = await addCharger(id);
      chargerId = added.chargerId;
      sims.push(
        startCharger({
          url: `ws://localhost:${port}/ocpp`,
          id,
          password: added.password,
          protocol,
          vendor: 'E2E',
          model: 'DC60',
          firmware: '1.0',
          connectors: 1,
          maxKw: 60,
          state: 'available',
          meterEverySec: 1,
        }),
      );
      // On connect the gateway sends the current card list
      await until(async () => (await detail(chargerId)).localListVersion === 1);
    });

    it('sends the local authorization list on demand, with a new version', async () => {
      const res = await authed(
        api().post(`/v1/console/chargers/${chargerId}/local-list/sync`),
      ).expect(200);
      expect(res.body).toEqual({ status: 'Accepted', version: 2, entries: 1 });
    });

    it('reserves a connector for one card, refuses others, and cancels', async () => {
      const res = await authed(
        api().post(`/v1/console/chargers/${chargerId}/reservations`),
      )
        .send({ evseId: 1, idTokenId: cardId, minutes: 30 })
        .expect(200);
      expect(res.body.status).toBe('ACTIVE');
      await until(async () => (await detail(chargerId)).status === 'RESERVED');
      expect((await detail(chargerId)).reservations).toEqual([
        expect.objectContaining({
          status: 'ACTIVE',
          idTag: '04:E2:E2:01',
          driver: 'Ada Lovelace',
        }),
      ]);

      // A second reservation on the same connector is refused by the charger
      const second = await authed(
        api().post(`/v1/console/chargers/${chargerId}/reservations`),
      )
        .send({ evseId: 1, idTokenId: cardId, minutes: 30 })
        .expect(200);
      expect(second.body).toMatchObject({
        status: 'REJECTED',
        detail: 'Charger replied Occupied.',
      });

      // The console's own remote start is another card: refused while reserved
      const start = await authed(
        api().post(`/v1/console/chargers/${chargerId}/commands`),
      )
        .send({ kind: 'remote-start' })
        .expect(200);
      expect(start.body.status).toBe('REJECTED');

      const { reservations } = await detail(chargerId);
      await authed(
        api().post(
          `/v1/console/chargers/${chargerId}/reservations/${reservations[0].id}/cancel`,
        ),
      ).expect(204);
      await until(async () => (await detail(chargerId)).status === 'AVAILABLE');
      expect((await detail(chargerId)).reservations).toEqual([]);
    });
  });

  it('marks a reservation used when its card starts charging', async () => {
    // A hand-driven 2.0.1 charger, so the test controls the TransactionEvent
    const id = `RSV-${stamp}-raw`;
    const { chargerId, password } = await addCharger(id);
    const client = new RPCClient({
      endpoint: `ws://localhost:${port}/ocpp`,
      identity: id,
      password,
      protocols: ['ocpp2.0.1'],
      strictMode: true,
      reconnect: false,
    } as never);
    clients.push(client);
    let reservationId = 0;
    client.handle('ReserveNow', ({ params }) => {
      reservationId = (params as { id: number }).id;
      return Promise.resolve({ status: 'Accepted' });
    });
    client.handle('SendLocalList', () =>
      Promise.resolve({ status: 'Accepted' }),
    );
    client.handle('TriggerMessage', () =>
      Promise.resolve({ status: 'Accepted' }),
    );
    await client.connect();

    await authed(api().post(`/v1/console/chargers/${chargerId}/reservations`))
      .send({ evseId: 1, idTokenId: cardId, minutes: 30 })
      .expect(200);
    await client.call('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionInfo: {
        transactionId: `tx-rsv-${stamp}`,
        chargingState: 'Charging',
      },
      idToken: { idToken: '04:E2:E2:01', type: 'ISO14443' },
      evse: { id: 1, connectorId: 1 },
      reservationId,
    });
    const row = await prisma.reservation.findFirstOrThrow({
      where: { chargerId },
    });
    expect(row.status).toBe('USED');
  });
});
