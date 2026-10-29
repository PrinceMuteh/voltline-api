# voltline-api

Backend for the Voltline Charging Platform (Flex Mobility Limited): REST API for the operator console and driver app, the OCPP 1.6J / 2.0.1 charger gateway, and live updates for the console.

NestJS 12 (ESM) · PostgreSQL + Prisma 7 · Redis · Vitest. The frontend lives in [`../voltline-web`](../voltline-web).

## Run it

```bash
cp .env.example .env          # then set JWT_ACCESS_SECRET / JWT_REFRESH_SECRET (openssl rand -base64 48)
npm install                   # also generates the Prisma client
npm run db:up                 # PostgreSQL on :5435, Redis on :6380 (docker compose)
npm run db:migrate            # apply migrations
npm run db:seed               # demo workspace from the design handoff
npm run start:dev             # http://localhost:4000
npm run sim:fleet             # optional: connects the 7 demo chargers (CP-0012 stays offline on purpose)
```

Demo sign-in after seeding: `admin@voltline.local` / `voltline-demo-123` (also `bola@`, `grace@`, `support@` with Operator, Finance and Support roles).

- API docs: http://localhost:4000/docs · spec: http://localhost:4000/openapi.json
- Health: `GET /v1/health`
- OCPP endpoint: `ws://localhost:4000/ocpp/{chargePointId}` (production: `wss://ocpp.voltline.example/ocpp/…`, TLS terminated in front)
- Console live updates: Socket.IO namespace `/console`

## Chargers and the simulator

Chargers connect with Security Profile 2: HTTP Basic Auth (username = charge point ID, password from Add a charger) checked during the WebSocket upgrade. Both `ocpp2.0.1` and `ocpp1.6` subprotocols are accepted (preferring 2.0.1) unless the workspace switches one off, and every frame is validated against the official OCPP JSON schemas.

A new charger boots as **Pending** until an operator approves it in the console; the gateway then sends `TriggerMessage BootNotification` so it gets Accepted straight away.

`scripts/sim/` is a development charger that speaks either protocol:

```bash
npm run sim -- --id CP-0045 --password <password>   # one charger, e.g. after Add a charger
npm run sim -- --id CP-0045 --password <pw> --protocol 1.6 --state charging
npm run sim:fleet                                     # the seeded demo chargers (password SIM_CHARGER_PASSWORD)
```

It answers TriggerMessage, Reset (a soft reset is rejected while faulted), UnlockConnector, remote start/stop, ChangeAvailability, Get/SetVariables and Get/ChangeConfiguration, ReserveNow/CancelReservation (with expiry) and SendLocalList. DC chargers report battery %. Charging chargers run real sessions: an RFID tap, metering to a target, idle (SuspendedEV), unplug, then the next car. In the fleet, CP-0007, CP-0021 and CP-0035 do this continuously, so Sessions, Overview energy and revenue fill up live.

## Sessions and billing

- `src/billing/pricing.ts` is the one pricing function (energy, peak surcharge, time, session fee, idle after grace, VAT). It prices the tariff preview, the console's live estimates and final billing. voltline-web keeps a byte-identical copy: after changing it run `npm run sync:pricing`; a unit test fails if the copies differ.
- `src/sessions/session-recorder.service.ts` turns 2.0.1 `TransactionEvent` and 1.6J `StartTransaction` / `MeterValues` / `StopTransaction` into sessions. Events are keyed (2.0.1 seqNo, 1.6J timestamps) and meter samples are unique per time, so a charger replaying its queue after a reconnect changes nothing; a replayed 1.6J StartTransaction gets the same transaction id back.
- A session is priced once, when it ends, by the tariff version in force when it started. Editing prices of a tariff that already priced sessions saves a new version.
- A fault stop (EmergencyStop, GroundFault, PowerLoss, …) bills only the metered energy.
- Payment capture, retries and refunds arrive with the payment gateway (phase 4); until then a session's amount is what it will be charged.

## Scripts

| Script | Does |
| --- | --- |
| `npm run start:dev` | API with watch mode |
| `npm run build` / `start:prod` | Compile to `dist/` and run it |
| `npm run test:e2e` | End-to-end tests against the docker-compose database |
| `npm test` | Unit tests |
| `npm run lint` / `format` | oxlint / Prettier |
| `npm run db:migrate` | `prisma migrate dev` (creates a migration when the schema changed) |
| `npm run db:studio` | Browse the database |
| `npm run sim` / `sim:fleet` | Simulated chargers (see above) |
| `npm run sync:pricing` | Copy the pricing function to voltline-web |

## Layout

One folder per feature, each with its module, controller, service and `dto/`:

```
src/
  auth/        sign-up, sign-in, refresh rotation, sign-out; global AuthGuard, @Public, @Roles, @CurrentAuth
  console/     me, onboarding checklist, overview tiles and energy chart
  chargers/    console charger endpoints: list, detail, create (Add a charger), approve,
               password rotation, connect checklist, message log, remote commands, sites, network
  ocpp/        the gateway: handshake and auth, 1.6J and 2.0.1 adapters (ocpp.handlers.ts),
               charger state, remote command queue, liveness (offline alerts), message log
  alerts/      offline and fault alerts
  billing/     pricing.ts: the one pricing function (shared with voltline-web)
  sessions/    session recorder (OCPP → sessions), Sessions list, detail and CSV export
  tariffs/     tariffs with versioning, and the price preview
  realtime/    Socket.IO /console namespace; browsers join with a 60 s ticket
  sites/       sites (address, map position, grid limit)
  settings/    Settings › OCPP
  driver/      the driver app API (/v1/app/*): phone sign-in, stations, QR lookup,
               start/stop sent straight to the charger, live session, history, cards
  health/      GET /v1/health
  prisma/      PrismaService (pg driver adapter)
  config/      environment validation
  generated/   Prisma client (git-ignored, from `prisma generate`)
prisma/
  schema.prisma   data model v1 (tenancy, sites, chargers, sessions, tariffs, money, ops)
  seed.ts
scripts/sim/      development charger simulator
```

## Conventions

- Every route needs a session unless marked `@Public()`. Restrict by role with `@Roles('ADMIN', 'FINANCE')`.
- Every operator-owned row has `workspaceId`; always filter by `auth.workspaceId`.
- Money is integer kobo (`amountKobo`), energy is watt-hours (`energyWh`), percentages are basis points (`1500` = 15%).
- Auth tokens travel only in httpOnly cookies (`vl_access` 15 min, `vl_refresh` 30 days, rotated on each refresh; replaying an old refresh token revokes all of that user's tokens). `Authorization: Bearer` is also accepted for mobile and partner clients.
- After changing a controller or DTO, run `npm run gen:api` in voltline-web to refresh its typed client.
- Only `ocpp.handlers.ts` knows about protocol versions; everything after it works on translated events.
- Console commands also cover remote stop, ChangeAvailability and live charger settings; reservations (OC-10) and the offline RFID list (OC-09, sent on connect when Settings › OCPP › Sync is on) have their own endpoints.
- The OCPP message log is searchable (`/console/chargers/:id/messages/search`) and kept 90 days.
- Driver app: sign-in codes are hashed, valid 5 minutes, 5 tries; outside production the code is returned to the app because no SMS provider is set up, and in production sending is refused until one is. The app serves one workspace (`DRIVER_APP_WORKSPACE`). Driver starts and stops are never queued: an offline charger or a missing answer is reported at once. Sessions stop by themselves at the driver's auto-stop budget.
- An EVSE runs one transaction at a time: a session left open when a new one starts on the same EVSE is closed at its last reading and billed for what it delivered.
- Remote commands wait up to 30 s for the charger. Unanswered or offline ones stay queued and are sent when it reconnects (dropped after 24 h).
- Single instance for now: open sockets, power-now readings and the last-message time live in memory. Running several API instances needs them moved to Redis (planned with the scale work).
