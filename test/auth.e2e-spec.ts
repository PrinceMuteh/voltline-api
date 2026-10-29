import 'dotenv/config';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

// Runs against the docker-compose database. Each run uses a fresh email and cleans up after itself.
describe('Auth and console (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const email = `e2e-${Date.now()}@voltline.test`;
  const password = 'correct-horse-9';

  const signUp = () =>
    request(app.getHttpServer()).post('/v1/auth/sign-up').send({
      name: 'E2E Operator',
      company: 'E2E Charging Ltd',
      email,
      password,
      country: 'NG',
      chargerCount: 'ONE_TO_TEN',
    });

  const cookiesOf = (res: request.Response) =>
    res.headers['set-cookie'] as unknown as string[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
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

  it('signs up, sets httpOnly cookies and returns no tokens in the body', async () => {
    const res = await signUp().expect(204);
    const cookies = cookiesOf(res);
    expect(
      cookies.some((c) => c.startsWith('vl_access=') && c.includes('HttpOnly')),
    ).toBe(true);
    expect(
      cookies.some(
        (c) => c.startsWith('vl_refresh=') && c.includes('HttpOnly'),
      ),
    ).toBe(true);
    expect(res.text).toBe('');
  });

  it('rejects a second account with the same email', async () => {
    const res = await signUp().expect(409);
    expect(res.body.message).toBe(
      'An account with this email already exists. Sign in instead.',
    );
  });

  it('returns the member and a first-run checklist with 1 of 4 done', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/auth/sign-in')
      .send({ email: email.toUpperCase(), password })
      .expect(204);
    const cookies = cookiesOf(res);

    const me = await request(app.getHttpServer())
      .get('/v1/console/me')
      .set('Cookie', cookies)
      .expect(200);
    expect(me.body).toMatchObject({
      role: 'ADMIN',
      user: { email },
      workspace: {
        name: 'E2E Charging Ltd',
        currency: 'NGN',
        timeZone: 'Africa/Lagos',
      },
    });

    const onboarding = await request(app.getHttpServer())
      .get('/v1/console/onboarding')
      .set('Cookie', cookies)
      .expect(200);
    expect(onboarding.body).toMatchObject({ completed: 1, total: 4 });
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const wrong = await request(app.getHttpServer())
      .post('/v1/auth/sign-in')
      .send({ email, password: 'not-the-password' })
      .expect(401);
    const unknown = await request(app.getHttpServer())
      .post('/v1/auth/sign-in')
      .send({ email: 'nobody@voltline.test', password })
      .expect(401);
    expect(wrong.body.message).toBe(unknown.body.message);
  });

  it('uses the design wording for an invalid email', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/auth/sign-in')
      .send({ email: 'not-an-email', password })
      .expect(400);
    expect(res.body.message).toContain(
      'Enter an email address like name@company.com.',
    );
  });

  it('rotates the refresh token and revokes the family when an old one is replayed', async () => {
    const signIn = await request(app.getHttpServer())
      .post('/v1/auth/sign-in')
      .send({ email, password })
      .expect(204);
    const original = cookiesOf(signIn);

    const rotated = await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .set('Cookie', original)
      .expect(204);
    const fresh = cookiesOf(rotated);

    // Replaying the first token signals theft: it fails, and so does the fresh one
    await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .set('Cookie', original)
      .expect(401);
    await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .set('Cookie', fresh)
      .expect(401);
  });

  it('blocks console routes without a session', async () => {
    await request(app.getHttpServer()).get('/v1/console/me').expect(401);
  });

  it('reports health without a session', async () => {
    await request(app.getHttpServer())
      .get('/v1/health')
      .expect(200, { status: 'ok', database: 'up' });
  });
});
