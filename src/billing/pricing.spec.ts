import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  inPeakWindow,
  minuteOfDay,
  previewChargingMinutes,
  price,
  type TariffRates,
} from './pricing.js';

const standardDc: TariffRates = {
  perKwhKobo: 30_000,
  perMinuteKobo: 0,
  sessionFeeKobo: 20_000,
  idleGraceMin: 15,
  idlePerMinuteKobo: 5_000,
  peakFrom: '18:00',
  peakTo: '22:00',
  peakSurchargeBps: 1_500,
  vatIncluded: true,
  vatBps: 750,
};

describe('price', () => {
  it('matches the plan’s worked example: 30 kWh, 60 min plugged in, Standard DC at peak', () => {
    const chargingMinutes = previewChargingMinutes(30);
    expect(chargingMinutes).toBe(36);
    expect(
      price(standardDc, {
        energyWh: 30_000,
        chargingMinutes,
        pluggedMinutes: 60,
        atPeak: true,
      }),
    ).toEqual({
      energyKobo: 900_000, // 30 × ₦300
      peakKobo: 135_000, // 15% = ₦1,350
      timeKobo: 0,
      sessionFeeKobo: 20_000,
      idleMinutes: 9, // 60 − 36 − 15
      idleKobo: 45_000, // 9 × ₦50
      vatKobo: 76_744, // ₦767 of the total
      totalKobo: 1_100_000, // ₦11,000
      effectivePerKwhKobo: 36_667,
      atPeak: true,
      vatIncluded: true,
      stoppedByFault: false,
    });
  });

  it('bills only the metered energy when a fault stopped the session', () => {
    const p = price(standardDc, {
      energyWh: 6_100,
      chargingMinutes: 12,
      pluggedMinutes: 40,
      atPeak: false,
      stoppedByFault: true,
    });
    expect(p.totalKobo).toBe(183_000); // 6.1 × ₦300, no fee, no idle
    expect(p.sessionFeeKobo + p.idleKobo).toBe(0);
  });

  it('adds VAT on top when prices exclude it', () => {
    const p = price(
      {
        ...standardDc,
        vatIncluded: false,
        sessionFeeKobo: 0,
        idlePerMinuteKobo: null,
      },
      {
        energyWh: 10_000,
        chargingMinutes: 20,
        pluggedMinutes: 20,
        atPeak: false,
      },
    );
    expect(p.vatKobo).toBe(22_500); // 7.5% of ₦3,000
    expect(p.totalKobo).toBe(322_500);
  });

  it('charges no idle fee within the grace period or without an idle price', () => {
    const usage = {
      energyWh: 5_000,
      chargingMinutes: 30,
      pluggedMinutes: 44,
      atPeak: false,
    };
    expect(price(standardDc, usage).idleMinutes).toBe(0);
    expect(
      price(
        { ...standardDc, idlePerMinuteKobo: null },
        { ...usage, pluggedMinutes: 300 },
      ).idleKobo,
    ).toBe(0);
  });
});

describe('peak window', () => {
  it('handles windows inside a day and across midnight', () => {
    expect(inPeakWindow(standardDc, 18 * 60)).toBe(true);
    expect(inPeakWindow(standardDc, 22 * 60)).toBe(false);
    const night = { peakFrom: '22:00', peakTo: '06:00' };
    expect(inPeakWindow(night, 23 * 60)).toBe(true);
    expect(inPeakWindow(night, 5 * 60)).toBe(true);
    expect(inPeakWindow(night, 12 * 60)).toBe(false);
    expect(inPeakWindow({ peakFrom: null, peakTo: null }, 0)).toBe(false);
  });

  it('reads the local time in the site’s time zone', () => {
    // 17:30 UTC is 18:30 in Lagos (UTC+1)
    expect(minuteOfDay(new Date('2026-10-28T17:30:00Z'), 'Africa/Lagos')).toBe(
      18 * 60 + 30,
    );
  });
});

describe('web copy', () => {
  const web = fileURLToPath(
    new URL('../../../voltline-web/lib/pricing.ts', import.meta.url),
  );
  it.skipIf(!existsSync(web))(
    'is identical to voltline-web/lib/pricing.ts (run npm run sync:pricing)',
    () => {
      const source = readFileSync(
        fileURLToPath(new URL('./pricing.ts', import.meta.url)),
        'utf8',
      );
      expect(readFileSync(web, 'utf8')).toBe(source);
    },
  );
});
