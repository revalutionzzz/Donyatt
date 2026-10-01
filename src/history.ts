import { HISTORY_DAYS } from "./collector";
import { DONYATT_LEVEL_MEASURE, SNOWDON_HILL_RAIN_MEASURE } from "./config";
import { FORECAST_STALE_MIN, latestForecast } from "./forecast";

export interface History {
  from: string;
  to: string;
  /** Donyatt level, [ts, metres], oldest first. */
  level: [string, number][];
  /** Snowdon Hill rain summed per hour, [hour start, mm], oldest first. */
  rainHourly: [string, number][];
  /** Open-Meteo forecast for Chard, next 12 h, [hour start, mm]; empty if there's no fresh forecast. */
  rainForecast: [string, number][];
  forecastFetchedAt: string | null;
}

export const HISTORY_RANGES = [1, 2, 7] as const;

/** Chart data for the last `days` days (1, 2 or 7; anything else falls back to 2). */
export async function loadHistory(db: D1Database, days: number, now = new Date()): Promise<History> {
  const span = (HISTORY_RANGES as readonly number[]).includes(days) ? Math.min(days, HISTORY_DAYS) : 2;
  const from = new Date(now.getTime() - span * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const [level, rain] = await Promise.all([
    db
      .prepare("SELECT ts, value FROM readings WHERE measure_id = ? AND ts >= ? ORDER BY ts")
      .bind(DONYATT_LEVEL_MEASURE, from)
      .all<{ ts: string; value: number }>(),
    db
      .prepare(
        `SELECT substr(ts, 1, 13) || ':00:00Z' AS hour, ROUND(SUM(value), 1) AS mm
         FROM readings WHERE measure_id = ? AND ts >= ? GROUP BY hour ORDER BY hour`,
      )
      .bind(SNOWDON_HILL_RAIN_MEASURE, from)
      .all<{ hour: string; mm: number }>(),
  ]);
  const forecast = await latestForecast(db, now);
  const fresh = forecast && now.getTime() - Date.parse(forecast.fetchedAt) <= FORECAST_STALE_MIN * 60_000;
  const horizon = now.getTime() + 12 * 3_600_000;
  return {
    from,
    to: now.toISOString(),
    level: level.results.map((r) => [r.ts, r.value]),
    rainHourly: rain.results.map((r) => [r.hour, r.mm]),
    rainForecast: fresh
      ? forecast.hours
          .filter((h) => Date.parse(h.hourEnd) > now.getTime() && Date.parse(h.hourEnd) - 3_600_000 < horizon)
          .map((h) => [new Date(Date.parse(h.hourEnd) - 3_600_000).toISOString().replace(".000Z", "Z"), h.mm])
      : [],
    forecastFetchedAt: fresh ? forecast.fetchedAt : null,
  };
}
