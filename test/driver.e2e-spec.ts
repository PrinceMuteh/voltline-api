import 'dotenv/config';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { startCharger } from '../scripts/sim/charger.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

// The driver app against a simulated charger: phone sign-in, stations, QR lookup, start,
// live view, auto-stop at the budget, stop, history and receipt.
describe.each(['ocpp2.0.1', 'ocpp1.6'] as const)(
  'Driver app over %s (e2e)',
  (protocol) => {
    let app: INestApplication<App>;
    let prisma: PrismaService;
    let operator: string[];
    let driver: string[];
    let chargerId: string;
    let siteId: string;
    let sim: ReturnType<typeof startCharger>;
    const stamp = `${Date.now()}${protocol === 'ocpp1.6' ? 1 : 2}`;
    const email = `driverapp-${stamp}@voltline.test`;
    const workspaceName = `Driver App E2E ${stamp}`;
    const phone = `80${stamp.slice(-8)}`;
    const chargePointId = `DRV-${stamp}`;
    const api = () => request(app.getHttpServer());
    const asDriver = (req: request.Test) => req.set('Cookie', driver);
    const asOperator = (req: request.Test) => req.set('Cookie', operator);

    const until = async (check: () => Promise<boolean>, ms = 8000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('condition not met in time');
    };
    const live = async () =>
      (await asDriver(api().get('/v1/app/sessions/live')).expect(200)).body
        .session;

    beforeAll(async () => {
      process.env.DRIVER_APP_WORKSPACE = workspaceName;
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = configureApp(moduleRef.createNestApplication());
      await app.listen(0);
      const { port } = (
        app.getHttpServer() as unknown as Server
      ).address() as AddressInfo;
      prisma = app.get(PrismaService);

      const res = await api()
        .post('/v1/auth/sign-up')
        .send({
          name: 'Driver App Admin',
          company: workspaceName,
          email,
          password: 'correct-horse-9',
          country: 'NG',
          chargerCount: 'ONE_TO_TEN',
        })
        .expect(204);
      operator = res.headers['set-cookie'] as unknown as string[];

      const created = await asOperator(api().post('/v1/console/chargers'))
        .send({
          chargePointId,
          newSiteName: 'Driver Site',
          connectors: [{ type: 'CCS2', maxKw: 60 }],
        })
        .expect(201);
      chargerId = created.body.charger.id;
      siteId = created.body.charger.siteId;
      await asOperator(api().patch(`/v1/console/sites/${siteId}`))
        .send({ latitude: 9.05, longitude: 7.49 })
        .expect(200);
      await asOperator(
        api().post(`/v1/console/chargers/${chargerId}/approve`),
      ).expect(200);
      // An expensive tariff, so the auto-stop budget is reached within seconds
      await asOperator(api().post('/v1/console/tariffs'))
        .send({
          name: 'Test',
          siteIds: [siteId],
          perKwhKobo: 5_000_000,
          perMinuteKobo: 0,
          sessionFeeKobo: 0,
          idleGraceMin: null,
          idlePerMinuteKobo: null,
          peakFrom: null,
          peakTo: null,
          peakSurchargeBps: null,
          vatIncluded: true,
          vatBps: 750,
        })
        .expect(201);
      sim = startCharger({
        url: `ws://localhost:${port}/ocpp`,
        id: chargePointId,
        password: created.body.password,
        protocol,
        vendor: 'E2E',
        model: 'DC60',
        firmware: '1.0',
        connectors: 1,
        maxKw: 60,
        state: 'available',
        meterEverySec: 1,
      });
      await until(async () => {
        const c = await asOperator(
          api().get(`/v1/console/chargers/${chargerId}`),
        ).expect(200);
        return c.body.status === 'AVAILABLE';
      });
    });

    afterAll(async () => {
      await sim?.stop().catch(() => undefined);
      delete process.env.DRIVER_APP_WORKSPACE;
      const user = await prisma.user.findUnique({
        where: { email },
        include: { memberships: true },
      });
      if (user) {
        const ids = user.memberships.map((m) => m.workspaceId);
        await prisma.session.deleteMany({
          where: { workspaceId: { in: ids } },
        });
        await prisma.workspace.deleteMany({ where: { id: { in: ids } } });
        await prisma.user.delete({ where: { id: user.id } });
      }
      await prisma.otpCode.deleteMany({ where: { phone: `+234${phone}` } });
      await app.close();
    });

    it('signs a driver in with a 6-digit code and keeps the two identities apart', async () => {
      await api()
        .post('/v1/app/auth/otp/send')
        .send({ phone: '12345' })
        .expect(400);
      const sent = await api()
        .post('/v1/app/auth/otp/send')
        .send({ phone: `0${phone}` })
        .expect(200);
      expect(sent.body.phone).toBe(`+234${phone}`);
      expect(sent.body.devCode).toMatch(/^\d{6}$/);
      // Too soon for another code
      await api().post('/v1/app/auth/otp/send').send({ phone }).expect(429);

      const wrong = sent.body.devCode === '000000' ? '111111' : '000000';
      await api()
        .post('/v1/app/auth/otp/verify')
        .send({ phone, code: wrong })
        .expect(401);
      const ok = await api()
        .post('/v1/app/auth/otp/verify')
        .send({ phone, code: sent.body.devCode })
        .expect(200);
      expect(ok.body.isNew).toBe(true);
      driver = ok.headers['set-cookie'] as unknown as string[];
      expect(
        driver.some(
          (c) => c.startsWith('vl_driver=') && c.includes('HttpOnly'),
        ),
      ).toBe(true);
      // A used code can't be replayed
      await api()
        .post('/v1/app/auth/otp/verify')
        .send({ phone, code: sent.body.devCode })
        .expect(401);

      await asDriver(api().get('/v1/console/me')).expect(401);
      await asOperator(api().get('/v1/app/me')).expect(401);
      const me = await asDriver(api().get('/v1/app/me')).expect(200);
      expect(me.body).toMatchObject({
        phone: `+234${phone}`,
        plugTypes: ['CCS2'],
        autoStopKobo: 1_500_000,
      });
    });

    it('lists stations with price and availability, and finds a charger by its QR code', async () => {
      const stations = await asDriver(api().get('/v1/app/stations')).expect(
        200,
      );
      expect(stations.body).toEqual([
        expect.objectContaining({
          id: siteId,
          name: 'Driver Site',
          free: 1,
          maxKw: 60,
          offline: false,
          price: expect.objectContaining({ perKwhKobo: 5_000_000 }),
        }),
      ]);
      const byCode = await asDriver(
        api().get(`/v1/app/chargers/by-code/${chargePointId.toLowerCase()}`),
      ).expect(200);
      expect(byCode.body.connectors).toEqual([
        expect.objectContaining({
          chargePointId,
          evseId: 1,
          type: 'CCS2',
          status: 'AVAILABLE',
        }),
      ]);
      await asDriver(api().get('/v1/app/chargers/by-code/CP-NOPE')).expect(404);
    });

    it('starts from the app, shows it live, and stops at the auto-stop budget', async () => {
      await asDriver(api().patch('/v1/app/me'))
        .send({ autoStopKobo: 100_000 })
        .expect(200);
      const start = await asDriver(api().post('/v1/app/sessions'))
        .send({ chargerId, evseId: 1 })
        .expect(200);
      expect(start.body).toMatchObject({
        outcome: 'ACCEPTED',
        title: 'Charging started',
      });

      await until(async () => (await live())?.status === 'ACTIVE');
      const running = await live();
      expect(running).toMatchObject({
        chargePointId,
        evseId: 1,
        connectorType: 'CCS2',
        autoStopKobo: 100_000,
      });
      await asDriver(api().post('/v1/app/sessions'))
        .send({ chargerId, evseId: 1 })
        .expect(409);

      // ₦50 per Wh: the ₦1,000 budget is crossed within a couple of readings
      await until(async () => (await live())?.endedAt !== null, 15000);
      const session = await prisma.session.findFirstOrThrow({
        where: { id: running.id },
        include: { events: true },
      });
      expect(session.stopReason).toBe('Remote');
      expect(session.events.map((e) => e.type)).toContain('BudgetReached');
    });

    it('stops a session from the app, then lists it in history with a receipt', async () => {
      await asDriver(api().patch('/v1/app/me'))
        .send({ autoStopKobo: null })
        .expect(200);
      // The charger needs a moment after the previous session before it is free again
      await until(async () => {
        const r = await asDriver(api().post('/v1/app/sessions')).send({
          chargerId,
          evseId: 1,
        });
        return r.status === 200 && r.body.outcome === 'ACCEPTED';
      });
      await until(
        async () =>
          (await live())?.status === 'ACTIVE' && (await live()).energyWh > 0,
      );
      const running = await live();
      await asDriver(api().post(`/v1/app/sessions/${running.id}/stop`)).expect(
        200,
      );
      await until(async () => (await live())?.endedAt !== null);

      const history = await asDriver(api().get('/v1/app/sessions')).expect(200);
      expect(history.body.sessions).toHaveLength(2);
      expect(history.body.sessions[0]).toMatchObject({
        id: running.id,
        stationName: 'Driver Site',
        status: 'COMPLETED',
      });
      const receipt = await asDriver(
        api().get(`/v1/app/sessions/${running.id}`),
      ).expect(200);
      expect(receipt.body.billing.final).toBe(true);
      expect(receipt.body.amountKobo).toBeGreaterThan(0);

      // Someone else's session is not found
      await asDriver(
        api().get('/v1/app/sessions/00000000-0000-4000-8000-000000000000'),
      ).expect(404);
    });

    it('links an RFID card, and refuses a card that belongs to someone else', async () => {
      const me = await asDriver(api().post('/v1/app/me/cards'))
        .send({ uid: '04e2e2aa' })
        .expect(200);
      expect(me.body.cards).toEqual(['04:E2:E2:AA']);
      const ws = await prisma.workspace.findFirstOrThrow({
        where: { name: workspaceName },
      });
      const other = await prisma.driver.create({
        data: {
          workspaceId: ws.id,
          phone: `+234${String(Number(phone) + 1)}`,
          idTokens: { create: { workspaceId: ws.id, uid: '04:E2:E2:BB' } },
        },
      });
      await asDriver(api().post('/v1/app/me/cards'))
        .send({ uid: '04:E2:E2:BB' })
        .expect(409);
      await prisma.idToken.deleteMany({ where: { driverId: other.id } });
    });
  },
);
