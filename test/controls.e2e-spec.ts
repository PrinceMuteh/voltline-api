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

// The console's charger controls against the development simulator, in both protocols:
// settings (Get/SetVariables, Get/ChangeConfiguration), stop a session, ChangeAvailability.
describe.each(['ocpp2.0.1', 'ocpp1.6'] as const)(
  'Charger controls over %s (e2e)',
  (protocol) => {
    let app: INestApplication<App>;
    let prisma: PrismaService;
    let cookies: string[];
    let chargerId: string;
    let sim: ReturnType<typeof startCharger>;
    const stamp = `${Date.now()}-${protocol.replace(/\W/g, '')}`;
    const email = `controls-${stamp}@voltline.test`;
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
    const detail = async () =>
      (await authed(api().get(`/v1/console/chargers/${chargerId}`)).expect(200))
        .body as {
        status: string;
        activeSessions: { id: string }[];
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
      prisma = app.get(PrismaService);

      const res = await api()
        .post('/v1/auth/sign-up')
        .send({
          name: 'Controls Admin',
          company: 'Controls E2E Ltd',
          email,
          password: 'correct-horse-9',
          country: 'NG',
          chargerCount: 'ONE_TO_TEN',
        })
        .expect(204);
      cookies = res.headers['set-cookie'] as unknown as string[];

      const id = `CTL-${stamp}`;
      const created = await authed(api().post('/v1/console/chargers'))
        .send({
          chargePointId: id,
          newSiteName: 'Controls Site',
          connectors: [{ type: 'CCS2', maxKw: 60 }],
        })
        .expect(201);
      chargerId = created.body.charger.id;
      await authed(
        api().post(`/v1/console/chargers/${chargerId}/approve`),
      ).expect(200);

      // A DC charger with a car already charging
      sim = startCharger({
        url: `ws://localhost:${port}/ocpp`,
        id,
        password: created.body.password,
        protocol,
        vendor: 'E2E',
        model: 'DC60',
        firmware: '1.0',
        connectors: 1,
        maxKw: 60,
        state: 'charging',
        meterEverySec: 1,
      });
      await until(async () => (await detail()).activeSessions.length === 1);
    });

    afterAll(async () => {
      await sim?.stop().catch(() => undefined);
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
      await app.close();
    });

    it('reads the charger’s settings and changes one', async () => {
      const read = await authed(
        api().get(`/v1/console/chargers/${chargerId}/configuration`),
      ).expect(200);
      const key =
        protocol === 'ocpp1.6'
          ? 'MeterValueSampleInterval'
          : 'TxUpdatedInterval';
      const item = (
        read.body as { key: string; component: string | null; value: string }[]
      ).find((i) => i.key === key);
      expect(item?.value).toBe('1');

      const write = await authed(
        api().put(`/v1/console/chargers/${chargerId}/configuration`),
      )
        .send({ component: item!.component, key, value: '2' })
        .expect(200);
      expect(write.body.status).toBe('Accepted');
      const again = await authed(
        api().get(`/v1/console/chargers/${chargerId}/configuration`),
      ).expect(200);
      expect(
        (again.body as { key: string; value: string }[]).find(
          (i) => i.key === key,
        )?.value,
      ).toBe('2');
    });

    it('reports battery % on a DC session', async () => {
      const { activeSessions } = await detail();
      await until(async () => {
        const s = await authed(
          api().get(`/v1/console/sessions/${activeSessions[0].id}`),
        ).expect(200);
        return (s.body.power as { socPct: number | null }[]).some(
          (p) => p.socPct !== null,
        );
      });
    });

    it('stops the running session from the console', async () => {
      const { activeSessions } = await detail();
      const res = await authed(
        api().post(`/v1/console/sessions/${activeSessions[0].id}/stop`),
      ).expect(200);
      expect(res.body).toMatchObject({
        status: 'ACCEPTED',
        title: 'Stop accepted',
      });
      await until(async () => {
        const s = await prisma.session.findUniqueOrThrow({
          where: { id: activeSessions[0].id },
        });
        return s.status === 'COMPLETED' && s.stopReason === 'Remote';
      });
      await authed(
        api().post(`/v1/console/sessions/${activeSessions[0].id}/stop`),
      ).expect(409);
    });

    it('takes the charger out of service and back with ChangeAvailability', async () => {
      const off = await authed(
        api().post(`/v1/console/chargers/${chargerId}/commands`),
      )
        .send({ kind: 'set-unavailable' })
        .expect(200);
      expect(off.body.status).toBe('ACCEPTED');
      await until(async () => (await detail()).status === 'UNAVAILABLE');

      await authed(api().post(`/v1/console/chargers/${chargerId}/commands`))
        .send({ kind: 'set-available' })
        .expect(200);
      await until(async () => (await detail()).status === 'AVAILABLE');
    });
  },
);
