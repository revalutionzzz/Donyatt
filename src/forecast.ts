import { FORECAST_POINT, OPEN_METEO_URL } from "./config";

export interface ForecastHour {
  /** End of the forecast hour, ISO UTC ("...:00:00Z"). */
  hourEnd: string;
  mm: number;
}

export const FORECAST_HOURS = 24;
/** Re-fetch when the stored forecast is older than this (Open-Meteo updates hourly). */
export const FORECAST_REFRESH_MIN = 55;
/** Older than this, the forecast isn't used for the outlook. */
export const FORECAST_STALE_MIN = 180;

export function forecastUrl(): string {
  const q = new URLSearchParams({
    latitude: String(FORECAST_POINT.latitude),
    longitude: String(FORECAST_POINT.longitude),
    hourly: "precipitation",
    forecast_hours: String(FORECAST_HOURS),
    timezone: "GMT",
  });
  return `${OPEN_METEO_URL}?${q}`;
}

/** Parse Open-Meteo's `{hourly: {time: [...], precipitation: [...]}}`, skipping nulls. */
export function parseForecast(body: unknown): ForecastHour[] {
  const hourly = (body as { hourly?: { time?: unknown; precipitation?: unknown } })?.hourly;
  if (!Array.isArray(hourly?.time) || !Array.isArray(hourly?.precipitation) || hourly.time.length !== hourly.precipitation.length) {
    throw new Error("Open-Meteo response has no hourly precipitation");
  }
  const out: ForecastHour[] = [];
  hourly.time.forEach((t: unknown, i: number) => {
    const mm = (hourly.precipitation as unknown[])[i];
    if (typeof t !== "string" || typeof mm !== "number" || !Number.isFinite(mm) || mm < 0) return;
    // "2026-10-01T13:00" in GMT -> "2026-10-01T13:00:00Z"
    const iso = /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(t) ? `${t}:00Z` : t;
    if (Number.isNaN(Date.parse(iso))) return;
    out.push({ hourEnd: iso, mm });
  });
  return out;
}

/** Fetch and store a forecast if the latest stored one is older than FORECAST_REFRESH_MIN. Returns rows stored. */
export async function collectForecast(db: D1Database, now = new Date(), fetchFn: typeof fetch = fetch): Promise<number> {
  const last = await db.prepare("SELECT MAX(fetched_at) AS at FROM rain_forecasts").first<{ at: string | null }>();
  if (last?.at && now.getTime() - Date.parse(last.at) < FORECAST_REFRESH_MIN * 60_000) return 0;
  const res = await fetchFn(forecastUrl(), {
    headers: { "User-Agent": "donyatt-flood-watch (community flood tool)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const hours = parseForecast(await res.json());
  if (!hours.length) return 0;
  const fetchedAt = now.toISOString();
  const stmt = db.prepare("INSERT OR IGNORE INTO rain_forecasts (fetched_at, hour_end, mm) VALUES (?, ?, ?)");
  await db.batch(hours.map((h) => stmt.bind(fetchedAt, h.hourEnd, h.mm)));
  return hours.length;
}

export interface StoredForecast {
  fetchedAt: string;
  hours: ForecastHour[];
}

/**
 * The latest stored forecast's hours ending after `now` minus 2 h (the outlook may be anchored up
 * to an hour back, when the rain feed lags), or null if there's none.
 */
export async function latestForecast(db: D1Database, now: Date): Promise<StoredForecast | null> {
  const last = await db.prepare("SELECT MAX(fetched_at) AS at FROM rain_forecasts").first<{ at: string | null }>();
  if (!last?.at) return null;
  const { results } = await db
    .prepare("SELECT hour_end AS hourEnd, mm FROM rain_forecasts WHERE fetched_at = ? AND hour_end > ? ORDER BY hour_end")
    .bind(last.at, new Date(now.getTime() - 2 * 3_600_000).toISOString())
    .all<ForecastHour>();
  return { fetchedAt: last.at, hours: results };
}

/** Forecast rain (mm) over the `hours` after `from`, counting a partial first hour pro rata. */
export function forecastTotal(hours: ForecastHour[], from: Date, span: number): number {
  const start = from.getTime();
  const end = start + span * 3_600_000;
  let total = 0;
  for (const h of hours) {
    const hEnd = Date.parse(h.hourEnd);
    const hStart = hEnd - 3_600_000;
    const overlap = Math.max(0, Math.min(hEnd, end) - Math.max(hStart, start));
    total += h.mm * (overlap / 3_600_000);
  }
  return total;
}
