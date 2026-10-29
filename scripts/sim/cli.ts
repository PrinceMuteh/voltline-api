// One simulated charger. Example, after Add a charger shows you the password:
//   npm run sim -- --id CP-0045 --password <password> [--protocol 1.6] [--model DC60] [--state charging]
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { startCharger, type SimState } from './charger.js';

const { values } = parseArgs({
  options: {
    id: { type: 'string' },
    password: { type: 'string' },
    url: {
      type: 'string',
      default: process.env.OCPP_PUBLIC_URL ?? 'ws://localhost:4000/ocpp',
    },
    protocol: { type: 'string', default: '2.0.1' },
    vendor: { type: 'string', default: 'Voltline Sim' },
    model: { type: 'string', default: 'DC60' },
    firmware: { type: 'string', default: '4.2.1' },
    connectors: { type: 'string', default: '1' },
    'max-kw': { type: 'string', default: '60' },
    state: { type: 'string', default: 'available' },
    fault: { type: 'string' },
    'meter-every': { type: 'string', default: '10' },
  },
});

if (!values.id || !values.password) {
  console.error(
    'Usage: npm run sim -- --id CP-0045 --password <password from Add a charger>',
  );
  process.exit(1);
}

const charger = startCharger({
  url: values.url,
  id: values.id,
  password: values.password,
  protocol: values.protocol.startsWith('1.6') ? 'ocpp1.6' : 'ocpp2.0.1',
  vendor: values.vendor,
  model: values.model,
  firmware: values.firmware,
  connectors: Number(values.connectors),
  maxKw: Number(values['max-kw']),
  state: values.state as SimState,
  fault: values.fault,
  meterEverySec: Number(values['meter-every']),
});

// Unplug cars (end sessions) on Ctrl+C or a plain kill
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void charger.stop().finally(() => process.exit(0));
  });
