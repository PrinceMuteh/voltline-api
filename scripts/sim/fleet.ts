// Connects the seeded demo chargers so Overview shows the network from the design, live.
// CP-0012 stays away on purpose: it is the "offline" charger in the designs.
import 'dotenv/config';
import { startCharger, type SimOptions } from './charger.js';

const url = process.env.OCPP_PUBLIC_URL ?? 'ws://localhost:4000/ocpp';
const password = process.env.SIM_CHARGER_PASSWORD ?? 'voltline-sim-charger-01';

const fleet: (Pick<
  SimOptions,
  'id' | 'model' | 'maxKw' | 'state' | 'protocol' | 'firmware'
> &
  Partial<SimOptions>)[] = [
  {
    id: 'CP-0007',
    idTags: ['04:A2:1C:9F'],
    targetKwh: 6,
    model: 'AC22',
    maxKw: 22,
    state: 'charging',
    powerKw: 7.2,
    protocol: 'ocpp2.0.1',
    firmware: '4.1.9',
  },
  {
    id: 'CP-0018',
    model: 'AC22',
    maxKw: 22,
    state: 'available',
    protocol: 'ocpp2.0.1',
    firmware: '4.1.9',
  },
  {
    id: 'CP-0021',
    idTags: ['04:5C:88:A0', '04:77:0D:51'],
    targetKwh: 30,
    model: 'DC120',
    maxKw: 120,
    state: 'charging',
    powerKw: 84.5,
    protocol: 'ocpp2.0.1',
    firmware: '2.1.4',
  },
  {
    id: 'CP-0026',
    model: 'AC7',
    maxKw: 7,
    state: 'available',
    protocol: 'ocpp1.6',
    firmware: '1.12',
  },
  {
    id: 'CP-0031',
    model: 'DC60',
    maxKw: 60,
    state: 'faulted',
    fault: 'GroundFailure',
    protocol: 'ocpp2.0.1',
    firmware: '3.8.0',
  },
  {
    id: 'CP-0035',
    idTags: ['04:77:0D:51', '04:A2:1C:9F'],
    targetKwh: 25,
    model: 'DC60',
    maxKw: 60,
    state: 'charging',
    powerKw: 41,
    protocol: 'ocpp2.0.1',
    firmware: '3.8.0',
  },
  {
    id: 'CP-0044',
    model: 'AC22',
    maxKw: 22,
    state: 'available',
    protocol: 'ocpp1.6',
    firmware: '4.1.9',
  },
];

const running = fleet.map((c) =>
  startCharger({
    url,
    password,
    vendor: '[Vendor]',
    connectors: 1,
    meterEverySec: 5,
    // Each car charges to its target, idles 90 s, unplugs; the next arrives a minute later
    idleSec: 90,
    nextAfterSec: 60,
    ...c,
  }),
);

// Unplug cars (end sessions) on Ctrl+C or a plain kill
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void Promise.all(running.map((c) => c.stop())).finally(() =>
      process.exit(0),
    );
  });
