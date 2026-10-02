import { processAlerts, type AlertSender } from "./alerts";
import { collectForecast, latestForecast } from "./forecast";
import { runCollector, type CollectorResult } from "./collector";
import { DONYATT_LEVEL_MEASURE, SNOWDON_HILL_RAIN_MEASURE } from "./config";
import { VISIBLE_PHOTO_SQL, type DriverReport } from "./reports";
import { PHOTOS, REPORTS } from "./rules";
import { logStatus } from "./statusLog";
import { computeStatus, type ActiveWarning, type StatusInputs, type StatusReport, type TimedValue } from "./status";

/** Bump when the report shape or road list changes, so an old cached report is never served. */
export const STATUS_KV_KEY = "status:v2";
/** If the cron hasn't produced a run for this long, requests run the collector themselves. */
export const STALE_RUN_MS = 20 * 60 * 1000;
/** At most one request-triggered collector run per isolate per minute. */
const FALLBACK_THROTTLE_MS = 60 * 1000;
let lastFallbackAt = 0;

/** Level history needed: the longest road hold (6 h) plus the rise window. */
const LEVEL_HISTORY_HOURS = 8;
/** 72 h for the model's longest rain window. */
const RAIN_HISTORY_HOURS = 72;

const isoSeconds = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

async function readingsSince(db: D1Database, measure: string, since: string): Promise<TimedValue[]> {
  const { results } = await db
    .prepare("SELECT ts, value FROM readings WHERE measure_id = ? AND ts >= ? ORDER BY ts")
    .bind(measure, since)
    .all<TimedValue>();
  return results;
}

async function latestReading(db: D1Database, measure: string): Promise<TimedValue[]> {
  const row = await db
    .prepare("SELECT ts, value FROM readings WHERE measure_id = ? ORDER BY ts DESC LIMIT 1")
    .bind(measure)
    .first<TimedValue>();
  return row ? [row] : [];
}

export async function loadStatusInputs(db: D1Database, now: Date): Promise<StatusInputs> {
  const t = now.getTime();
  let levels = await readingsSince(db, DONYATT_LEVEL_MEASURE, isoSeconds(t - LEVEL_HISTORY_HOURS * 3_600_000));
  // Keep the last known reading even when it's old, so the page can say how old.
  if (levels.length === 0) levels = await latestReading(db, DONYATT_LEVEL_MEASURE);
  const rain = await readingsSince(db, SNOWDON_HILL_RAIN_MEASURE, isoSeconds(t - RAIN_HISTORY_HOURS * 3_600_000));

  const lastCheck = await db
    .prepare("SELECT started_at FROM collector_runs WHERE warnings_ok = 1 ORDER BY started_at DESC LIMIT 1")
    .first<{ started_at: string }>();
  let warnings: ActiveWarning[] = [];
  if (lastCheck) {
    const { results } = await db
      .prepare(
        `SELECT flood_area_id AS floodAreaId, severity_level AS severityLevel, severity, message, time_raised AS timeRaised
         FROM flood_warnings WHERE last_seen_at = ? ORDER BY severity_level`,
      )
      .bind(lastCheck.started_at)
      .all<ActiveWarning>();
    warnings = results;
  }
  const { results: reports } = await db
    .prepare(
      `SELECT r.id, r.road_id AS roadId, r.kind, r.created_at AS createdAt, r.device_hash AS deviceHash,
         ${VISIBLE_PHOTO_SQL} AS photoVisible, r.photo_state = 'approved' AS photoApproved
       FROM reports r
       WHERE r.hidden = 0 AND r.created_at >= ? ORDER BY r.created_at`,
    )
    .bind(
      new Date(t - PHOTOS.maxAgeHours * 3_600_000).toISOString(),
      new Date(t - REPORTS.expireMinutes * 60_000).toISOString(),
    )
    .all<Omit<DriverReport, "photoVisible" | "photoApproved"> & { photoVisible: number; photoApproved: number | null }>();
  const forecast = await latestForecast(db, now);
  return {
    now, levels, rain, warnings, warningsCheckedAt: lastCheck?.started_at ?? null, forecast,
    reports: reports.map((r) => ({ ...r, photoVisible: r.photoVisible === 1, photoApproved: r.photoApproved === 1 })),
  };
}

/** Recompute the road status from D1 and cache it in KV. */
export async function refreshStatus(db: D1Database, kv: KVNamespace, now = new Date(), alerts?: AlertSender): Promise<StatusReport> {
  const report = computeStatus(await loadStatusInputs(db, now));
  await kv.put(STATUS_KV_KEY, JSON.stringify(report));
  // History for learning; a logging failure must never block the live status.
  await logStatus(db, report).catch((err) => console.error("Status log failed:", err instanceof Error ? err.message : err));
  // Alerts likewise must never block the status.
  if (alerts) await processAlerts(db, kv, report, alerts).catch((err) => console.error("Alerts failed:", err instanceof Error ? err.message : err));
  return report;
}

export type FallbackOutcome =
  | { ran: false; lastRunAgeMs: number }
  | { ran: true; lastRunAgeMs: number; result?: CollectorResult; error?: string };

/**
 * Backstop for the cron: if no collector run is recent, run it now (throttled).
 * Used by /health and /api/status so the data stays fresh even if the cron stops.
 */
export async function runCollectorIfStale(
  db: D1Database,
  now = Date.now(),
  fetchFn: typeof fetch = fetch,
): Promise<FallbackOutcome> {
  const last = await db
    .prepare("SELECT started_at FROM collector_runs ORDER BY started_at DESC LIMIT 1")
    .first<{ started_at: string }>();
  const lastRunAgeMs = last ? now - Date.parse(last.started_at) : Infinity;
  if (lastRunAgeMs < STALE_RUN_MS || now - lastFallbackAt < FALLBACK_THROTTLE_MS) return { ran: false, lastRunAgeMs };
  lastFallbackAt = now;
  try {
    const result = await runCollector(db, new Date(now), fetchFn);
    // Self-throttled to hourly; a forecast failure never affects the collector result.
    await collectForecast(db, new Date(now), fetchFn).catch((err) => console.error("Forecast failed:", err instanceof Error ? err.message : err));
    return { ran: true, lastRunAgeMs, result };
  } catch (err) {
    return { ran: true, lastRunAgeMs, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Cached status, refreshed (and the collector run) when the cache is older than STALE_RUN_MS. */
export async function getStatus(
  db: D1Database,
  kv: KVNamespace,
  now = Date.now(),
  fetchFn: typeof fetch = fetch,
  alerts?: AlertSender,
): Promise<StatusReport> {
  const cached = await kv.get<StatusReport>(STATUS_KV_KEY, "json");
  if (cached && now - Date.parse(cached.generatedAt) < STALE_RUN_MS) return cached;
  await runCollectorIfStale(db, now, fetchFn);
  return refreshStatus(db, kv, new Date(now), alerts);
}
