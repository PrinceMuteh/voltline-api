import 'dotenv/config';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { RPCClient } from 'ocpp-rpc';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { LivenessService } from '../src/ocpp/liveness.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

// A real OCPP 2.0.1 client against the gateway: the Add a charger flow, commands and liveness.
describe('OCPP gateway (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let base: string;
  let cookies: string[];
  let chargerId: string;
  let password: string;
  const stamp = Date.now();
  const email = `ocpp-${stamp}@voltline.test`;
  const chargePointId = `E2E-${stamp}`;
  const clients: RPCClient[] = [];

  const api = () => request(app.getHttpServer());
  const authed = (req: request.Test) => req.set('Cookie', cookies);

  const charger = (pw: string) => {
    const client = new RPCClient({
      endpoint: `${base.replace('http', 'ws')}/ocpp`,
      identity: chargePointId,
      password: pw,
      protocols: ['ocpp2.0.1'],
      strictMode: true,
      reconnect: false,
    } as never);
    clients.push(client);
    return client;
  };

  const boot = (client: RPCClient) =>
    client.call('BootNotification', {
      reason: 'PowerUp',
      chargingStation: {
        vendorName: 'E2E',
        model: 'DC60',
        firmwareVersion: '4.2.1',
      },
    }) as Promise<{ status: string; interval: number }>;

  const until = async (check: () => Promise<boolean>, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('condition not met in time');
  };

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
        name: 'OCPP Operator',
        company: 'OCPP E2E Ltd',
        email,
        password: 'correct-horse-9',
        country: 'NG',
        chargerCount: 'ONE_TO_TEN',
      })
      .expect(204);
    cookies = res.headers['set-cookie'] as unknown as string[];
  });

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close({ force: true })));
    const user = await prisma.user.findUnique({
      where: { email },
      include: { memberships: true },
    });
    if (user) {
      await prisma.workspace.deleteMany({
        where: { id: { in: user.memberships.map((m) => m.workspaceId) } },
      });
      await prisma.user.delete({ where: { id: user.id } });
    }
    await app.close();
  });

  it('registers a charger with a new site and returns its password once', async () => {
    const res = await authed(api().post('/v1/console/chargers'))
      .send({
        chargePointId,
        newSiteName: 'E2E Site',
        model: 'DC60',
        connectors: [{ type: 'CCS2', maxKw: 60 }],
      })
      .expect(201);
    chargerId = res.body.charger.id;
    password = res.body.password;
    expect(password).toHaveLength(32);
    expect(res.body.charger.approval).toBe('PENDING');
    expect(res.body.charger.ocppUrl).toMatch(
      new RegExp(`/ocpp/${chargePointId}$`),
    );

    const detail = await authed(
      api().get(`/v1/console/chargers/${chargerId}`),
    ).expect(200);
    expect(JSON.stringify(detail.body)).not.toContain(password);
  });

  it('refuses a wrong password at the handshake and says so in the checklist', async () => {
    await expect(charger('not-the-right-password').connect()).rejects.toThrow();
    const check = await authed(
      api().get(`/v1/console/chargers/${chargerId}/connect-check`),
    ).expect(200);
    expect(check.body.credentials.state).toBe('failed');
    expect(check.body.socket.state).toBe('waiting');
  });

  it('holds a new charger as Pending, then accepts it after approval', async () => {
    const client = charger(password);
    let triggered: string[] = [];
    client.handle('TriggerMessage', ({ params }) => {
      triggered.push((params as { requestedMessage: string }).requestedMessage);
      return Promise.resolve({ status: 'Accepted' });
    });
    client.handle('UnlockConnector', () =>
      Promise.resolve({ status: 'Unlocked' }),
    );
    await client.connect();

    expect((await boot(client)).status).toBe('Pending');
    // While Pending the gateway asks for connector status itself
    await until(async () => triggered.includes('StatusNotification'));
    await client.call('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Available',
      evseId: 1,
      connectorId: 1,
    });

    const check = await authed(
      api().get(`/v1/console/chargers/${chargerId}/connect-check`),
    ).expect(200);
    expect(check.body).toEqual({
      socket: { state: 'done', detail: 'ocpp2.0.1' },
      credentials: {
        state: 'done',
        detail: 'Basic Auth · no TLS (development)',
      },
      boot: { state: 'done', detail: 'DC60 · fw 4.2.1' },
      connectors: { state: 'done', detail: 'EVSE 1 · Available' },
    });

    triggered = [];
    await authed(
      api().post(`/v1/console/chargers/${chargerId}/approve`),
    ).expect(200);
    await until(async () => triggered.includes('BootNotification'));
    expect((await boot(client)).status).toBe('Accepted');
  });

  it('sends a remote command and returns the charger answer', async () => {
    const res = await authed(
      api().post(`/v1/console/chargers/${chargerId}/commands`),
    )
      .send({ kind: 'unlock' })
      .expect(200);
    expect(res.body).toMatchObject({
      status: 'ACCEPTED',
      title: 'Connector unlocked',
      detail: `${chargePointId} · UnlockConnector.conf Unlocked`,
    });
  });

  it('pushes live events to the workspace room and reports power now', async () => {
    const { body } = await authed(
      api().post('/v1/console/realtime/ticket'),
    ).expect(200);
    const socket: Socket = io(`${base}/console`, {
      auth: { ticket: body.ticket },
      transports: ['websocket'],
    });
    await new Promise<void>((resolve) => socket.on('connect', () => resolve()));
    const power = new Promise<{ powerW: number }>((resolve) =>
      socket.on('charger.power', resolve),
    );
    // The room join happens in handleConnection; give it a moment before metering
    await new Promise((r) => setTimeout(r, 100));

    const client = clients.at(-1)!;
    await client.call('MeterValues', {
      evseId: 1,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [
            {
              value: 41000,
              measurand: 'Power.Active.Import',
              unitOfMeasure: { unit: 'W' },
            },
          ],
        },
      ],
    });
    expect((await power).powerW).toBe(41000);
    socket.close();

    const list = await authed(api().get('/v1/console/chargers')).expect(200);
    expect(list.body[0]).toMatchObject({
      chargePointId,
      powerW: 41000,
      connected: true,
    });
  });

  it('does not accept a realtime ticket as an HTTP access token', async () => {
    const { body } = await authed(
      api().post('/v1/console/realtime/ticket'),
    ).expect(200);
    await api()
      .get('/v1/console/me')
      .set('Authorization', `Bearer ${body.ticket}`)
      .expect(401);
  });

  it('marks a silent charger offline with an alert, and clears it when it talks again', async () => {
    // Pretend the last message was 11 minutes ago (the default window is 10)
    await prisma.charger.update({
      where: { id: chargerId },
      data: { lastSeenAt: new Date(Date.now() - 11 * 60_000) },
    });
    await app.get(LivenessService).sweep();

    const offline = await authed(api().get('/v1/console/alerts')).expect(200);
    expect(offline.body).toEqual([
      expect.objectContaining({
        type: 'CHARGER_OFFLINE',
        title: `${chargePointId} offline`,
      }),
    ]);

    await clients.at(-1)!.call('Heartbeat', {});
    await until(async () => {
      const res = await authed(api().get('/v1/console/alerts'));
      return res.body.length === 0;
    });
    const row = await authed(
      api().get(`/v1/console/chargers/${chargerId}`),
    ).expect(200);
    expect(row.body.status).toBe('AVAILABLE');
  });

  it('searches the OCPP log by text, action and direction', async () => {
    const page = (query: string) =>
      authed(
        api().get(`/v1/console/chargers/${chargerId}/messages/search?${query}`),
      ).expect(200);

    const text = await page('q=Available');
    expect(text.body.messages.length).toBeGreaterThan(0);
    expect(
      text.body.messages.every((m: { payload: object }) =>
        JSON.stringify(m.payload).includes('Available'),
      ),
    ).toBe(true);
    expect(text.body.actions).toEqual(
      expect.arrayContaining(['BootNotification', 'StatusNotification']),
    );

    const ours = await page('action=UnlockConnector');
    expect(ours.body.messages.map((m: { action: string }) => m.action)).toEqual(
      ['UnlockConnector.conf', 'UnlockConnector'],
    );
    const outbound = await page('direction=OUTBOUND');
    expect(
      outbound.body.messages.every(
        (m: { direction: string }) => m.direction === 'OUTBOUND',
      ),
    ).toBe(true);
    // Wildcards in the search are literal
    expect((await page('q=%25')).body.messages).toHaveLength(0);
  });

  it('closes unknown charge points before upgrading', async () => {
    const stranger = new RPCClient({
      endpoint: `${base.replace('http', 'ws')}/ocpp`,
      identity: 'NOBODY-HERE',
      password: 'whatever-password-1',
      protocols: ['ocpp2.0.1'],
      reconnect: false,
    } as never);
    clients.push(stranger);
    await expect(stranger.connect()).rejects.toThrow();
  });
});
