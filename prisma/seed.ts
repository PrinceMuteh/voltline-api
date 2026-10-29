// Demo workspace built from the sample data in the Flex Mobility design handoff.
// Safe to re-run: it deletes and recreates the demo workspace only.
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import argon2 from 'argon2';
import {
  ChargerStatus,
  ConnectorType,
  OcppProtocol,
  PrismaClient,
  Role,
} from '../src/generated/prisma/client.js';
import { inPeakWindow, minuteOfDay, price } from '../src/billing/pricing.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

const DEMO_PASSWORD = 'voltline-demo-123';
// Every demo charger gets this OCPP password so `npm run sim:fleet` can connect them (dev only)
const SIM_CHARGER_PASSWORD =
  process.env.SIM_CHARGER_PASSWORD ?? 'voltline-sim-charger-01';
// How long ago each demo charger was last heard from, as in the Overview design
const LAST_SEEN_MIN: Record<string, number> = { 'CP-0012': 14, 'CP-0031': 2 };
const kobo = (naira: number) => Math.round(naira * 100);

const team: { name: string; email: string; role: Role }[] = [
  { name: 'Demo Admin', email: 'admin@voltline.local', role: 'ADMIN' },
  { name: 'Bola Ojo', email: 'bola@voltline.local', role: 'OPERATOR' },
  { name: 'Grace Nwosu', email: 'grace@voltline.local', role: 'FINANCE' },
  { name: 'Field support', email: 'support@voltline.local', role: 'SUPPORT' },
];

const siteHosts = [
  { name: 'Wuse II Mall Ltd', shareBps: 2000, sites: ['Wuse II Mall'] },
  { name: 'Airport Road Hub', shareBps: 1500, sites: ['Airport Road Hub'] },
  { name: 'Lekki Estates', shareBps: 1800, sites: ['Lekki Phase 1'] },
  { name: 'Maitama Offices', shareBps: 2500, sites: ['Maitama Office'] },
];

const sites = [
  {
    name: 'Wuse II Mall',
    area: 'Wuse 2, Abuja',
    latitude: 9.0765,
    longitude: 7.4683,
  },
  {
    name: 'Airport Road Hub',
    area: 'Airport Rd, Abuja',
    latitude: 9.0079,
    longitude: 7.3986,
  },
  {
    name: 'Lekki Phase 1',
    area: 'Lekki, Lagos',
    latitude: 6.4474,
    longitude: 3.4726,
  },
  {
    name: 'Jabi Lake',
    area: 'Jabi, Abuja',
    latitude: 9.0726,
    longitude: 7.4232,
  },
  {
    name: 'Maitama Office',
    area: 'Maitama, Abuja',
    latitude: 9.0882,
    longitude: 7.4934,
  },
  {
    name: 'Garki Area 11',
    area: 'Garki, Abuja',
    latitude: 9.0333,
    longitude: 7.4891,
  },
];

const chargers: {
  id: string;
  model: string;
  site: string;
  status: ChargerStatus;
  connector: ConnectorType;
  kw: number;
  protocol: OcppProtocol;
  firmware: string;
}[] = [
  {
    id: 'CP-0007',
    model: 'AC22',
    site: 'Wuse II Mall',
    status: 'CHARGING',
    connector: 'TYPE2',
    kw: 22,
    protocol: 'OCPP201',
    firmware: '4.1.9',
  },
  {
    id: 'CP-0012',
    model: 'DC60',
    site: 'Jabi Lake',
    status: 'OFFLINE',
    connector: 'CCS2',
    kw: 60,
    protocol: 'OCPP16J',
    firmware: '3.8.0',
  },
  {
    id: 'CP-0018',
    model: 'AC22',
    site: 'Wuse II Mall',
    status: 'AVAILABLE',
    connector: 'TYPE2',
    kw: 22,
    protocol: 'OCPP201',
    firmware: '4.1.9',
  },
  {
    id: 'CP-0021',
    model: 'DC120',
    site: 'Airport Road Hub',
    status: 'CHARGING',
    connector: 'CCS2',
    kw: 120,
    protocol: 'OCPP201',
    firmware: '2.1.4',
  },
  {
    id: 'CP-0026',
    model: 'AC7',
    site: 'Maitama Office',
    status: 'AVAILABLE',
    connector: 'TYPE2',
    kw: 7,
    protocol: 'OCPP16J',
    firmware: '1.12',
  },
  {
    id: 'CP-0031',
    model: 'DC60',
    site: 'Lekki Phase 1',
    status: 'FAULTED',
    connector: 'CCS2',
    kw: 60,
    protocol: 'OCPP201',
    firmware: '3.8.0',
  },
  {
    id: 'CP-0035',
    model: 'DC60',
    site: 'Lekki Phase 1',
    status: 'CHARGING',
    connector: 'CCS2',
    kw: 60,
    protocol: 'OCPP201',
    firmware: '3.8.0',
  },
  {
    id: 'CP-0044',
    model: 'AC22',
    site: 'Garki Area 11',
    status: 'AVAILABLE',
    connector: 'TYPE2',
    kw: 22,
    protocol: 'OCPP16J',
    firmware: '4.1.9',
  },
];

const tariffs = [
  {
    name: 'Standard DC',
    perKwh: 300,
    sessionFee: 200,
    idle: true,
    peak: true,
    sites: ['Airport Road Hub', 'Lekki Phase 1', 'Jabi Lake'],
  },
  {
    name: 'Standard AC',
    perKwh: 220,
    sessionFee: 0,
    idle: true,
    peak: false,
    sites: ['Wuse II Mall', 'Maitama Office', 'Garki Area 11'],
  },
  {
    name: 'GreenRide fleet',
    perKwh: 260,
    sessionFee: 0,
    idle: false,
    peak: false,
    sites: ['Airport Road Hub'],
  },
  {
    name: 'Night saver',
    perKwh: 240,
    sessionFee: 0,
    idle: true,
    peak: false,
    sites: ['Wuse II Mall'],
  },
];

/** Finished sessions from the Sessions design. Active ones come from `npm run sim:fleet`. */
const pastSessions: {
  ref: number;
  phone?: string;
  card?: string;
  charger: string;
  tariff: string;
  day: 0 | 1;
  at: string;
  chargingMin: number;
  pluggedMin: number;
  kwh: number;
  status: 'COMPLETED' | 'STOPPED_BY_FAULT' | 'PAYMENT_FAILED' | 'REFUNDED';
  reason?: string;
}[] = [
  {
    ref: 10479,
    phone: '+2349000000012',
    card: '04:5C:88:A0',
    charger: 'CP-0021',
    tariff: 'GreenRide fleet',
    day: 0,
    at: '07:40',
    chargingMin: 38,
    pluggedMin: 41,
    kwh: 38.6,
    status: 'COMPLETED',
    reason: 'EVDisconnected',
  },
  {
    ref: 10478,
    phone: '+2348090007765',
    charger: 'CP-0018',
    tariff: 'Standard AC',
    day: 0,
    at: '07:02',
    chargingMin: 98,
    pluggedMin: 110,
    kwh: 19.9,
    status: 'COMPLETED',
    reason: 'EVDisconnected',
  },
  {
    ref: 10477,
    phone: '+2348020001180',
    card: '07:B1:3E:2C',
    charger: 'CP-0031',
    tariff: 'Standard DC',
    day: 0,
    at: '06:48',
    chargingMin: 12,
    pluggedMin: 12,
    kwh: 6.1,
    status: 'STOPPED_BY_FAULT',
    reason: 'GroundFault',
  },
  {
    ref: 10476,
    phone: '+2348150006630',
    charger: 'CP-0044',
    tariff: 'Standard AC',
    day: 1,
    at: '21:10',
    chargingMin: 118,
    pluggedMin: 125,
    kwh: 14.2,
    status: 'PAYMENT_FAILED',
    reason: 'EVDisconnected',
  },
  {
    ref: 10475,
    card: '07:B1:3E:2C',
    charger: 'CP-0026',
    tariff: 'Standard AC',
    day: 1,
    at: '19:30',
    chargingMin: 161,
    pluggedMin: 190,
    kwh: 18.8,
    status: 'REFUNDED',
    reason: 'EVDisconnected',
  },
  {
    ref: 10474,
    phone: '+2347010009024',
    card: '04:77:0D:51',
    charger: 'CP-0035',
    tariff: 'Standard DC',
    day: 1,
    at: '18:02',
    chargingMin: 34,
    pluggedMin: 38,
    kwh: 29.7,
    status: 'COMPLETED',
    reason: 'EVDisconnected',
  },
];

/** A Lagos (UTC+1, no DST) wall-clock time, `day` days ago; "today" times not yet reached move back a day. */
function lagosTime(day: number, hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number);
  const lagosNow = new Date(Date.now() + 3_600_000);
  const at = new Date(
    Date.UTC(
      lagosNow.getUTCFullYear(),
      lagosNow.getUTCMonth(),
      lagosNow.getUTCDate() - day,
      h - 1,
      m,
    ),
  );
  return at.getTime() > Date.now() - 4 * 3_600_000
    ? new Date(at.getTime() - 86_400_000)
    : at;
}

/** One reading a minute: DC ramps up and tapers, AC holds steady; scaled to the session's energy. */
function powerCurve(chargingMin: number, kwh: number, dc: boolean) {
  const shape = Array.from({ length: chargingMin }, (_, i) => {
    if (!dc) return 1;
    if (i < 3) return (i + 1) / 3;
    const taperFrom = chargingMin * 0.7;
    return i < taperFrom
      ? 1
      : 1 - (0.65 * (i - taperFrom)) / (chargingMin - taperFrom);
  });
  const scale = (kwh * 1000 * 60) / shape.reduce((a, b) => a + b, 0);
  return shape.map((v) => Math.round(v * scale));
}

const drivers: {
  name: string;
  phone: string;
  wallet?: number;
  cards: string[];
  status?: 'ACTIVE' | 'PAYMENT_OVERDUE';
  fleet?: boolean;
}[] = [
  { name: 'Adaeze Okafor', phone: '+2348030004412', wallet: 18_500, cards: [] },
  {
    name: 'Tunde Bakare',
    phone: '+2348060000291',
    wallet: 2_150,
    cards: ['04:A2:1C:9F'],
  },
  { name: 'Ifeoma Kalu', phone: '+2348090007765', wallet: 41_000, cards: [] },
  { name: 'Musa Abdullahi', phone: '+2348020001180', cards: ['07:B1:3E:2C'] },
  {
    name: 'Chinedu Eze',
    phone: '+2348150006630',
    wallet: 0,
    cards: [],
    status: 'PAYMENT_OVERDUE',
  },
  {
    name: 'Kemi Adeyemi',
    phone: '+2347010009024',
    wallet: 9_800,
    cards: ['04:77:0D:51'],
  },
  {
    name: 'GreenRide fleet #12',
    phone: '+2349000000012',
    cards: ['04:5C:88:A0'],
    fleet: true,
  },
];

async function main() {
  const existing = await prisma.workspace.findFirst({
    where: { name: 'Voltline Demo' },
  });
  if (existing) {
    // Chargers are unique platform-wide, so clear the demo ones before recreating
    await prisma.workspace.delete({ where: { id: existing.id } });
  }
  await prisma.user.deleteMany({
    where: { email: { in: team.map((t) => t.email) } },
  });

  const passwordHash = await argon2.hash(DEMO_PASSWORD);
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Voltline Demo',
      registeredCompanyName: 'Flex Mobility Limited',
      chargerCountBand: 'ONE_TO_TEN',
      ocppConfig: { create: {} },
      gateway: { create: {} },
    },
  });

  for (const person of team) {
    await prisma.user.create({
      data: {
        name: person.name,
        email: person.email,
        passwordHash,
        memberships: {
          create: { workspaceId: workspace.id, role: person.role },
        },
      },
    });
  }

  const siteIds = new Map<string, string>();
  for (const site of sites) {
    const host = siteHosts.find((h) => h.sites.includes(site.name));
    const hostId = host
      ? (
          await prisma.siteHost.create({
            data: {
              workspaceId: workspace.id,
              name: host.name,
              revenueShareBps: host.shareBps,
            },
          })
        ).id
      : undefined;
    const created = await prisma.site.create({
      data: { workspaceId: workspace.id, siteHostId: hostId, ...site },
    });
    siteIds.set(site.name, created.id);
  }

  const simHash = await argon2.hash(SIM_CHARGER_PASSWORD);
  const chargerIds = new Map<string, string>();
  for (const c of chargers) {
    const created = await prisma.charger.create({
      data: {
        workspaceId: workspace.id,
        siteId: siteIds.get(c.site)!,
        chargePointId: c.id,
        vendor: '[Vendor]',
        model: c.model,
        firmwareVersion: c.firmware,
        protocol: c.protocol,
        approval: 'ACCEPTED',
        status: c.status,
        lastSeenAt: new Date(Date.now() - (LAST_SEEN_MIN[c.id] ?? 0) * 60_000),
        credentials: { create: { passwordHash: simHash } },
        evses: {
          create: {
            evseId: 1,
            connectors: {
              create: {
                connectorId: 1,
                type: c.connector,
                maxPowerW: c.kw * 1000,
                status: c.status,
              },
            },
          },
        },
      },
    });
    chargerIds.set(c.id, created.id);
  }

  const fleet = await prisma.fleet.create({
    data: { workspaceId: workspace.id, name: 'GreenRide fleet' },
  });
  const tariffIds = new Map<string, string>();
  for (const t of tariffs) {
    const created = await prisma.tariff.create({
      data: {
        workspaceId: workspace.id,
        name: t.name,
        fleetId: t.name === 'GreenRide fleet' ? fleet.id : undefined,
        perKwhKobo: kobo(t.perKwh),
        sessionFeeKobo: kobo(t.sessionFee),
        ...(t.idle ? { idleGraceMin: 15, idlePerMinuteKobo: kobo(50) } : {}),
        ...(t.peak
          ? { peakFrom: '18:00', peakTo: '22:00', peakSurchargeBps: 1500 }
          : {}),
        sites: {
          create: t.sites.map((name) => ({ siteId: siteIds.get(name)! })),
        },
      },
    });
    tariffIds.set(t.name, created.id);
  }

  for (const d of drivers) {
    await prisma.driver.create({
      data: {
        workspaceId: workspace.id,
        name: d.name,
        phone: d.phone,
        plugTypes: ['CCS2'],
        status: d.status ?? 'ACTIVE',
        fleetId: d.fleet ? fleet.id : undefined,
        wallet:
          d.wallet !== undefined
            ? { create: { balanceKobo: kobo(d.wallet) } }
            : undefined,
        idTokens: {
          create: d.cards.map((uid) => ({
            workspaceId: workspace.id,
            uid,
            fleetId: d.fleet ? fleet.id : undefined,
            dailyLimitKobo: kobo(20_000),
          })),
        },
      },
    });
  }

  // Past sessions with readings, timelines and prices from the real pricing function
  const tariffRows = await prisma.tariff.findMany({
    where: { workspaceId: workspace.id },
  });
  for (const ps of pastSessions) {
    const charger = await prisma.charger.findUniqueOrThrow({
      where: { chargePointId: ps.charger },
      include: { evses: { include: { connectors: true } } },
    });
    const driver = ps.phone
      ? await prisma.driver.findUnique({
          where: {
            workspaceId_phone: { workspaceId: workspace.id, phone: ps.phone },
          },
        })
      : null;
    const token = ps.card
      ? await prisma.idToken.findUnique({
          where: {
            workspaceId_uid: { workspaceId: workspace.id, uid: ps.card },
          },
        })
      : null;
    const tariff = tariffRows.find((t) => t.name === ps.tariff)!;
    const startedAt = lagosTime(ps.day, ps.at);
    const minute = (n: number) => new Date(startedAt.getTime() + n * 60_000);
    const curve = powerCurve(
      ps.chargingMin,
      ps.kwh,
      (charger.model ?? '').startsWith('DC'),
    );
    const meterStart = 1_250_000 + ps.ref; // a charger's lifetime register
    let register = meterStart;
    const samples = [{ at: minute(0), energyWh: register, powerW: curve[0] }];
    curve.forEach((w, i) => {
      register += Math.round(w / 60);
      samples.push({
        at: minute(i + 1),
        energyWh: register,
        powerW: i + 1 < curve.length ? curve[i + 1] : 0,
      });
    });
    const energyWh = register - meterStart;
    const fault = ps.status === 'STOPPED_BY_FAULT';
    const billing = price(tariff, {
      energyWh,
      chargingMinutes: ps.chargingMin,
      pluggedMinutes: ps.pluggedMin,
      atPeak: inPeakWindow(tariff, minuteOfDay(startedAt, 'Africa/Lagos')),
      stoppedByFault: fault,
    });
    const idTag = token?.uid;
    const events = [
      {
        idempotencyKey: 'seed:auth',
        type: 'Authorized',
        at: minute(0),
        detail: idTag ? 'Authorize · idToken Accepted' : 'App start · Accepted',
      },
      {
        idempotencyKey: 'seed:start',
        type: 'Started',
        at: minute(0),
        detail: 'TransactionEvent · Started',
      },
      ...(ps.pluggedMin > ps.chargingMin
        ? [
            {
              idempotencyKey: 'seed:ev',
              type: 'EVFinished',
              at: minute(ps.chargingMin),
              detail: 'SuspendedEV',
            },
          ]
        : []),
      {
        idempotencyKey: 'seed:end',
        type: 'Ended',
        at: minute(ps.pluggedMin),
        detail: `TransactionEvent · Ended · ${ps.reason}`,
      },
      ...(ps.status === 'PAYMENT_FAILED'
        ? [
            {
              idempotencyKey: 'seed:pay',
              type: 'PaymentFailed',
              at: minute(ps.pluggedMin + 1),
              detail: 'Insufficient funds on card ··1180.',
            },
          ]
        : []),
      ...(ps.status === 'REFUNDED'
        ? [
            {
              idempotencyKey: 'seed:refund',
              type: 'Refunded',
              at: minute(ps.pluggedMin + 600),
              detail: 'Charger fault during session',
            },
          ]
        : []),
    ];
    await prisma.session.create({
      data: {
        workspaceId: workspace.id,
        reference: `S-${ps.ref}`,
        chargerId: charger.id,
        connectorId: charger.evses[0].connectors[0].id,
        transactionId: `seed-${ps.ref}`,
        driverId: driver?.id,
        idTokenId: token?.id,
        idTag,
        fleetId: driver?.fleetId ?? token?.fleetId,
        tariffId: tariff.id,
        status: ps.status,
        startedAt,
        chargingEndedAt: minute(ps.chargingMin),
        endedAt: minute(ps.pluggedMin),
        stopReason: ps.reason,
        meterStartWh: meterStart,
        energyWh,
        amountKobo: billing.totalKobo,
        billing: {
          ...billing,
          usage: {
            energyWh,
            chargingMinutes: ps.chargingMin,
            pluggedMinutes: ps.pluggedMin,
          },
        },
        samples: { create: samples },
        events: { create: events },
      },
    });
  }

  await prisma.alert.createMany({
    data: [
      {
        workspaceId: workspace.id,
        type: 'CHARGER_FAULTED',
        chargerId: chargerIds.get('CP-0031'),
        title: 'CP-0031 faulted',
        detail: 'GroundFailure · Lekki Phase 1',
      },
      {
        workspaceId: workspace.id,
        type: 'CHARGER_OFFLINE',
        chargerId: chargerIds.get('CP-0012'),
        title: 'CP-0012 offline',
        detail: 'Jabi Lake',
      },
      {
        workspaceId: workspace.id,
        type: 'FIRMWARE_AVAILABLE',
        title: 'Firmware 4.2.1 ready',
        detail: '3 AC22 chargers can update tonight',
      },
    ],
  });

  console.log(
    `Seeded "Voltline Demo". Sign in as admin@voltline.local / ${DEMO_PASSWORD}`,
  );
  console.log('Run `npm run sim:fleet` to connect the demo chargers.');
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
