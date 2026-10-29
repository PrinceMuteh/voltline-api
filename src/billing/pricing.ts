// The one pricing function. It prices the tariff preview, the station sheet and final billing,
// so what an operator previews is exactly what a driver pays.
//
// Pure TypeScript with no imports: voltline-web keeps a byte-identical copy in lib/pricing.ts
// (`npm run sync:pricing` here writes it; a test fails if the copies drift).
// All money is integer kobo, energy is Wh, percentages are basis points.

export interface TariffRates {
  perKwhKobo: number;
  perMinuteKobo: number;
  sessionFeeKobo: number;
  idleGraceMin: number | null;
  idlePerMinuteKobo: number | null;
  /** "18:00", site local time; null when the tariff has no peak window. */
  peakFrom: string | null;
  peakTo: string | null;
  peakSurchargeBps: number | null;
  vatIncluded: boolean;
  vatBps: number;
}

export interface SessionUsage {
  energyWh: number;
  /** Minutes the car was actually drawing power. */
  chargingMinutes: number;
  /** Minutes from plug-in to unplug; the gap after charging is idle time. */
  pluggedMinutes: number;
  /** Whether the session started inside the tariff's peak window. */
  atPeak: boolean;
  /** A charger fault ended it: only the metered energy is billed. */
  stoppedByFault?: boolean;
}

export interface PriceBreakdown {
  energyKobo: number;
  peakKobo: number;
  timeKobo: number;
  sessionFeeKobo: number;
  idleMinutes: number;
  idleKobo: number;
  /** VAT inside the total when prices include VAT, otherwise added on top. */
  vatKobo: number;
  totalKobo: number;
  /** Total per kWh delivered, or null for a session with no energy. */
  effectivePerKwhKobo: number | null;
  atPeak: boolean;
  vatIncluded: boolean;
  stoppedByFault: boolean;
}

export function price(t: TariffRates, u: SessionUsage): PriceBreakdown {
  const fault = u.stoppedByFault ?? false;
  const energyKobo = Math.round((u.energyWh * t.perKwhKobo) / 1000);
  const peakKobo =
    u.atPeak && t.peakSurchargeBps
      ? Math.round((energyKobo * t.peakSurchargeBps) / 10_000)
      : 0;
  const timeKobo = fault ? 0 : u.chargingMinutes * t.perMinuteKobo;
  const sessionFeeKobo = fault ? 0 : t.sessionFeeKobo;
  const idleMinutes =
    fault || t.idlePerMinuteKobo === null
      ? 0
      : Math.max(
          0,
          u.pluggedMinutes - u.chargingMinutes - (t.idleGraceMin ?? 0),
        );
  const idleKobo = idleMinutes * (t.idlePerMinuteKobo ?? 0);

  const subtotal = energyKobo + peakKobo + timeKobo + sessionFeeKobo + idleKobo;
  const vatKobo = t.vatIncluded
    ? Math.round((subtotal * t.vatBps) / (10_000 + t.vatBps))
    : Math.round((subtotal * t.vatBps) / 10_000);
  const totalKobo = t.vatIncluded ? subtotal : subtotal + vatKobo;

  return {
    energyKobo,
    peakKobo,
    timeKobo,
    sessionFeeKobo,
    idleMinutes,
    idleKobo,
    vatKobo,
    totalKobo,
    effectivePerKwhKobo:
      u.energyWh > 0 ? Math.round((totalKobo * 1000) / u.energyWh) : null,
    atPeak: u.atPeak && Boolean(t.peakSurchargeBps),
    vatIncluded: t.vatIncluded,
    stoppedByFault: fault,
  };
}

/** Whether a local time (minutes after midnight) is inside [from, to); windows may cross midnight. */
export function inPeakWindow(
  t: Pick<TariffRates, 'peakFrom' | 'peakTo'>,
  minuteOfDay: number,
): boolean {
  if (!t.peakFrom || !t.peakTo) {
    return false;
  }
  const from = toMinutes(t.peakFrom);
  const to = toMinutes(t.peakTo);
  return from <= to
    ? minuteOfDay >= from && minuteOfDay < to
    : minuteOfDay >= from || minuteOfDay < to;
}

/** Minutes after local midnight in a time zone, e.g. 18:30 in Africa/Lagos → 1110. */
export function minuteOfDay(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
    timeZone,
  }).formatToParts(date);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get('hour') * 60 + get('minute');
}

/** The preview's assumption: a car charging at a steady 50 kW. */
export const PREVIEW_CHARGER_KW = 50;

/** Minutes needed to deliver energyKwh at the preview's steady charging power. */
export function previewChargingMinutes(energyKwh: number) {
  return Math.ceil((energyKwh / PREVIEW_CHARGER_KW) * 60);
}

function toMinutes(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
