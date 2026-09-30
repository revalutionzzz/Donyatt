import {
  DONYATT_LEVEL_MEASURE,
  INITIAL_LOOKBACK_MS,
  PLAUSIBLE_LEVEL_M,
  SNOWDON_HILL_RAIN_MEASURE,
  WATCHED_FLOOD_AREAS,
} from "./config";
import { fetchFloods, fetchReadings, type FloodWarning, type Reading } from "./ea";

export interface CollectorResult {
  startedAt: string;
  levelOk: boolean;
  rainOk: boolean;
  warningsOk: boolean;
  readingsInserted: number;
  warningsSeen: number;
  errors: string[];
}

const BATCH_SIZE = 100;

async function latestTs(db: D1Database, measureId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT MAX(ts) AS ts FROM readings WHERE measure_id = ?")
    .bind(measureId)
    .first<{ ts: string | null }>();
  return row?.ts ?? null;
}

async function insertReadings(db: D1Database, measureId: string, readings: Reading[]): Promise<number> {
  const stmt = db.prepare("INSERT OR IGNORE INTO readings (measure_id, ts, value) VALUES (?, ?, ?)");
  let inserted = 0;
  for (let i = 0; i < readings.length; i += BATCH_SIZE) {
    const batch = readings.slice(i, i + BATCH_SIZE).map((r) => stmt.bind(measureId, r.ts, r.value));
    const results = await db.batch(batch);
    inserted += results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
  }
  return inserted;
}

async function upsertWarnings(db: D1Database, warnings: FloodWarning[], seenAt: string): Promise<void> {
  if (warnings.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO flood_warnings (flood_area_id, time_message_changed, severity_level, severity, message,
       time_raised, time_severity_changed, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (flood_area_id, time_message_changed) DO UPDATE SET
       severity_level = excluded.severity_level,
       severity = excluded.severity,
       message = excluded.message,
       time_severity_changed = excluded.time_severity_changed,
       last_seen_at = excluded.last_seen_at`,
  );
  await db.batch(
    warnings.map((w) =>
      stmt.bind(w.floodAreaId, w.timeMessageChanged, w.severityLevel, w.severity, w.message, w.timeRaised,
        w.timeSeverityChanged, seenAt, seenAt),
    ),
  );
}

async function collectMeasure(db: D1Database, measureId: string, now: Date, fetchFn: typeof fetch) {
  const since = (await latestTs(db, measureId)) ?? new Date(now.getTime() - INITIAL_LOOKBACK_MS).toISOString();
  const { readings, skipped } = await fetchReadings(measureId, since, fetchFn);
  if (skipped > 0) console.warn(`${measureId}: skipped ${skipped} malformed readings`);
  return { readings, inserted: await insertReadings(db, measureId, readings) };
}

/**
 * One collector run. Each source (level, rain, warnings) succeeds or fails on its own,
 * and the outcome is always recorded in collector_runs so later stages can tell
 * "no active warnings" apart from "we couldn't check".
 */
export async function runCollector(db: D1Database, now = new Date(), fetchFn: typeof fetch = fetch): Promise<CollectorResult> {
  const startedAt = now.toISOString();
  const errors: string[] = [];
  let readingsInserted = 0;
  let warningsSeen = 0;

  const attempt = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
      return true;
    } catch (err) {
      errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };

  const levelOk = await attempt("level", async () => {
    const { readings, inserted } = await collectMeasure(db, DONYATT_LEVEL_MEASURE, now, fetchFn);
    readingsInserted += inserted;
    const odd = readings.filter((r) => r.value < PLAUSIBLE_LEVEL_M.min || r.value > PLAUSIBLE_LEVEL_M.max);
    if (odd.length > 0) {
      console.warn(`Donyatt: ${odd.length} implausible level readings, e.g. ${odd[0].value} m at ${odd[0].ts}`);
    }
  });
  const rainOk = await attempt("rain", async () => {
    readingsInserted += (await collectMeasure(db, SNOWDON_HILL_RAIN_MEASURE, now, fetchFn)).inserted;
  });
  const warningsOk = await attempt("warnings", async () => {
    const warnings = await fetchFloods(WATCHED_FLOOD_AREAS, fetchFn);
    await upsertWarnings(db, warnings, startedAt);
    warningsSeen = warnings.length;
  });

  const result = { startedAt, levelOk, rainOk, warningsOk, readingsInserted, warningsSeen, errors };
  await db
    .prepare(
      `INSERT INTO collector_runs (started_at, finished_at, level_ok, rain_ok, warnings_ok,
         readings_inserted, warnings_seen, errors) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(startedAt, new Date().toISOString(), +levelOk, +rainOk, +warningsOk, readingsInserted, warningsSeen,
      errors.length ? errors.join("\n") : null)
    .run();
  if (errors.length) console.error("Collector errors:", errors);
  return result;
}
