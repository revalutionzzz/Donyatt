import model from "./model/flood-model.json";
import { forecastTotal, FORECAST_STALE_MIN, type StoredForecast } from "./forecast";
import type { TimedValue } from "./status";

// Stage 5: evaluate the model trained by model/train.py (logistic regression, standardised features).

export type FeatureName = "level" | "rise_1h" | "rise_3h" | "rain_1h" | "rain_3h" | "rain_6h" | "rain_24h" | "rain_72h" | "fc_rain_6h";
export type Features = Partial<Record<FeatureName, number>>;

interface HorizonModel {
  intercept: number;
  coef: number[];
  mean: number[];
  scale: number[];
}
interface VariantModel {
  features: FeatureName[];
  horizons: Record<"3" | "6", HorizonModel>;
}
const MODELS = model.models as unknown as Record<"nowcast" | "forecast", VariantModel>;
export const BANDS = model.bands as { elevated: number; high: number };
export const MODEL_GENERATED = model.generated;

export type Band = "low" | "elevated" | "high";

export interface Outlook {
  /** Chance the Donyatt level reaches 1.80 m within 3 h / 6 h. */
  p3h: number;
  p6h: number;
  band: Band;
  /** Which model was used: with the rain forecast, or data-only. */
  variant: "forecast" | "nowcast";
  /** Forecast rain (mm) for the next 6 h at Chard, when the forecast variant was used. */
  forecastRain6hMm: number | null;
  /** The reading time the prediction is made from. */
  asOf: string;
}

const RAIN_WINDOWS = [1, 3, 6, 24, 72] as const;
/** A rain window needs at least this share of its 15-minute readings: missing rain would understate the risk. */
const MIN_RAIN_COVERAGE = 0.95;
/** How far the rain feed may lag the river gauge before the outlook is withheld. */
const MAX_FEED_LAG_MIN = 60;
/** Earlier level readings must be within this many minutes of t-1h / t-3h. */
const LEVEL_TOLERANCE_MIN = 10;

function levelAt(levels: TimedValue[], target: number): number | null {
  let best: TimedValue | null = null;
  let bestGap = Infinity;
  for (const r of levels) {
    const gap = Math.abs(Date.parse(r.ts) - target);
    if (gap < bestGap) {
      best = r;
      bestGap = gap;
    }
  }
  return best && bestGap <= LEVEL_TOLERANCE_MIN * 60_000 ? best.value : null;
}

/**
 * Features as of the latest level reading (t), matching model/train.py: rain windows are sums of
 * the 15-minute gauge readings in (t - h, t], then log1p. Returns null if anything is missing.
 */
export function computeFeatures(levels: TimedValue[], rain: TimedValue[], forecast: StoredForecast | null, now: Date): { features: Features; asOf: string; forecastRain6hMm: number | null } | null {
  const latestLevel = levels.at(-1);
  const latestRain = rain.at(-1);
  if (!latestLevel || !latestRain) return null;
  // Predict as of the latest time both feeds have reported: the rain feed often lags the river
  // gauge by a reading. If rain is more than an hour behind, don't predict at all.
  const t = Math.min(Date.parse(latestLevel.ts), Date.parse(latestRain.ts));
  if (Date.parse(latestLevel.ts) - t > MAX_FEED_LAG_MIN * 60_000) return null;
  const level = levelAt(levels, t);
  const l1 = levelAt(levels, t - 3_600_000);
  const l3 = levelAt(levels, t - 3 * 3_600_000);
  if (level === null || l1 === null || l3 === null) return null;
  const features: Features = { level, rise_1h: level - l1, rise_3h: level - l3 };
  for (const h of RAIN_WINDOWS) {
    const from = t - h * 3_600_000;
    const window = rain.filter((r) => {
      const rt = Date.parse(r.ts);
      return rt > from && rt <= t;
    });
    if (window.length < h * 4 * MIN_RAIN_COVERAGE) return null;
    features[`rain_${h}h` as FeatureName] = Math.log1p(window.reduce((s, r) => s + r.value, 0));
  }
  let forecastRain6hMm: number | null = null;
  if (forecast && now.getTime() - Date.parse(forecast.fetchedAt) <= FORECAST_STALE_MIN * 60_000) {
    // Must cover the full 6 h after t, or it would understate the rain to come.
    const lastHour = forecast.hours.at(-1);
    if (lastHour && Date.parse(lastHour.hourEnd) >= t + 6 * 3_600_000) {
      forecastRain6hMm = forecastTotal(forecast.hours, new Date(t), 6);
      features.fc_rain_6h = Math.log1p(forecastRain6hMm);
    }
  }
  return { features, asOf: new Date(t).toISOString().replace(".000Z", "Z"), forecastRain6hMm };
}

export function probability(m: HorizonModel, names: FeatureName[], features: Features): number {
  let z = m.intercept;
  names.forEach((name, i) => {
    z += (m.coef[i] * ((features[name] as number) - m.mean[i])) / m.scale[i];
  });
  return 1 / (1 + Math.exp(-z));
}

export function bandFor(p: number): Band {
  return p >= BANDS.high ? "high" : p >= BANDS.elevated ? "elevated" : "low";
}

export function predictOutlook(levels: TimedValue[], rain: TimedValue[], forecast: StoredForecast | null, now: Date): Outlook | null {
  const computed = computeFeatures(levels, rain, forecast, now);
  if (!computed) return null;
  const variant = computed.features.fc_rain_6h !== undefined ? "forecast" : "nowcast";
  const m = MODELS[variant];
  const p3h = probability(m.horizons["3"], m.features, computed.features);
  // The 3 h and 6 h models are fitted separately; reaching 1.80 m within 3 h implies within 6 h.
  const p6h = Math.max(p3h, probability(m.horizons["6"], m.features, computed.features));
  return { p3h, p6h, band: bandFor(p6h), variant, forecastRain6hMm: computed.forecastRain6hMm, asOf: computed.asOf };
}

export const MODEL_FOR_TESTS = MODELS;
