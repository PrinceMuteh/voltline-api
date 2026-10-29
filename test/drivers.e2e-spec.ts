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

// Drivers and RFID cards: the list, issuing cards, blocking, and reading a UID on a charger.
describe('Drivers and RFID cards (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let cookies: string[];
  let port: number;
  let workspaceId: string;
  let driverId: string;
  let fleetId: string;
  let chargerId: string;
  let client: RPCClient;
  const lists: string[][] = [];
  const stamp = Date.now();
  const email = `drivers-${stamp}@voltline.test`;
  const phone = `+234803${String(stamp).slice(-7)}`;
  const api = () => request(app.getHttpServer());
  const authed = (req: request.Test) => req.set('Cookie', cookies);
  const until = async (check: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('condition not met in time');
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
        name: 'Drivers Admin',
        company: 'Drivers E2E Ltd',
        email,
        password: 'correct-horse-9',
        country: 'NG',
        chargerCount: 'ONE_TO_TEN',
      })
      .expect(204);
    cookies = res.headers['set-cookie'] as unknown as string[];
    const me = await authed(api().get('/v1/console/me')).expect(200);
    workspaceId = me.body.workspace.id;

    const driver = await prisma.driver.create({
      data: {
        workspaceId,
        name: 'Ada Lovelace',
        phone,
        wallet: { create: { balanceKobo: 1_850_000 } },
      },
    });
    driverId = driver.id;
    await prisma.driver.create({
      data: { workspaceId, name: 'Musa Card', phone: `${phone.slice(0, -1)}9` },
    });

    // A connected charger that records the local lists it is sent
    const site = await authed(api().post('/v1/console/sites'))
      .send({ name: 'Drivers Site' })
      .expect(201);
    const created = await authed(api().post('/v1/console/chargers'))
      .send({
        chargePointId: `CP-DRV-${stamp}`,
        siteId: site.body.id,
        connectors: [{ type: 'CCS2', maxKw: 60 }],
      })
      .expect(201);
    chargerId = created.body.charger.id;
    await authed(
      api().post(`/v1/console/chargers/${chargerId}/approve`),
    ).expect(200);
    client = new RPCClient({
      endpoint: `ws://localhost:${port}/ocpp`,
      identity: `CP-DRV-${stamp}`,
      password: created.body.password,
      protocols: ['ocpp2.0.1'],
      strictMode: true,
      reconnect: false,
    } as never);
    client.handle('SendLocalList', ({ params }) => {
      const p = params as {
        localAuthorizationList?: { idToken: { idToken: string } }[];
      };
      lists.push(
        (p.localAuthorizationList ?? []).map((e) => e.idToken.idToken),
      );
      return Promise.resolve({ status: 'Accepted' });
    });
    client.handle('TriggerMessage', () =>
      Promise.resolve({ status: 'Accepted' }),
    );
    await client.connect();
    await until(() => lists.length > 0);
  });

  afterAll(async () => {
    await client?.close({ force: true });
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

  it('lists drivers with masked phones, access and wallet', async () => {
    const res = await authed(api().get('/v1/console/drivers')).expect(200);
    expect(res.body).toMatchObject({ activeThisMonth: 0, cardsIssued: 0 });
    const ada = res.body.drivers.find((d: { id: string }) => d.id === driverId);
    expect(ada).toMatchObject({
      name: 'Ada Lovelace',
      phone: `+234 803 ••• ${phone.slice(-4)}`,
      app: true,
      billing: 'WALLET',
      walletKobo: 1_850_000,
      cards: [],
      status: 'ACTIVE',
    });
    const musa = res.body.drivers.find(
      (d: { name: string }) => d.name === 'Musa Card',
    );
    expect(musa).toMatchObject({ app: false, billing: 'PREPAID' });
  });

  it('issues a card, normalises the UID and sends the new list to chargers', async () => {
    const before = lists.length;
    const res = await authed(api().post('/v1/console/id-tokens'))
      .send({ uid: '04e35a71', driverId, dailyLimitKobo: 2_000_000 })
      .expect(201);
    expect(res.body).toMatchObject({
      uid: '04:E3:5A:71',
      holder: 'Ada Lovelace',
      syncing: 1,
    });
    await until(() => lists.length > before);
    expect(lists.at(-1)).toContain('04:E3:5A:71');

    const dup = await authed(api().post('/v1/console/id-tokens'))
      .send({ uid: '04:E3:5A:71' })
      .expect(409);
    expect(dup.body.message).toContain('Ada Lovelace');
    await authed(api().post('/v1/console/id-tokens'))
      .send({ uid: 'not-a-card' })
      .expect(400);
  });

  it('searches by name, phone and card UID', async () => {
    const names = async (q: string) =>
      (
        await authed(api().get('/v1/console/drivers').query({ q })).expect(200)
      ).body.drivers.map((d: { name: string }) => d.name);
    expect(await names('lovel')).toEqual(['Ada Lovelace']);
    expect(await names('04e3')).toEqual(['Ada Lovelace']);
    expect(await names(`0803${phone.slice(-7)}`)).toEqual(['Ada Lovelace']);
  });

  it('adds a fleet and issues it an unassigned card', async () => {
    const fleet = await authed(api().post('/v1/console/fleets'))
      .send({ name: 'GreenRide fleet' })
      .expect(201);
    fleetId = fleet.body.id;
    await authed(api().post('/v1/console/id-tokens'))
      .send({ uid: '04:5C:88:A0', fleetId })
      .expect(201);
    const res = await authed(api().get('/v1/console/drivers')).expect(200);
    expect(res.body.cardsIssued).toBe(2);
    expect(res.body.fleets).toEqual([
      {
        id: fleetId,
        name: 'GreenRide fleet',
        cards: 1,
        monthKobo: 0,
        invoiceDay: 1,
      },
    ]);
  });

  it('blocking a driver drops their cards from the local list; unblocking restores them', async () => {
    let before = lists.length;
    const blocked = await authed(
      api().post(`/v1/console/drivers/${driverId}/block`),
    ).expect(200);
    expect(blocked.body).toMatchObject({
      driver: { status: 'BLOCKED' },
      syncing: 1,
    });
    await until(() => lists.length > before);
    expect(lists.at(-1)).not.toContain('04:E3:5A:71');
    expect(lists.at(-1)).toContain('04:5C:88:A0');
    const auth = (await client.call('Authorize', {
      idToken: { idToken: '04:E3:5A:71', type: 'ISO14443' },
    })) as { idTokenInfo: { status: string } };
    expect(auth.idTokenInfo.status).toBe('Invalid');

    before = lists.length;
    await authed(api().post(`/v1/console/drivers/${driverId}/unblock`)).expect(
      200,
    );
    await until(() => lists.length > before);
    expect(lists.at(-1)).toContain('04:E3:5A:71');
  });

  it('reads a card UID tapped on a charger', async () => {
    const reading = authed(
      api().post(`/v1/console/chargers/${chargerId}/read-card`),
    ).expect(200);
    const tap = new Promise((r) => setTimeout(r, 300)).then(() =>
      client.call('Authorize', {
        idToken: { idToken: '04:77:0D:52', type: 'ISO14443' },
      }),
    );
    const [res] = await Promise.all([reading, tap]);
    expect(res.body).toEqual({ uid: '04:77:0D:52', known: false });
  });
});
