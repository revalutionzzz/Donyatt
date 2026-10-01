import type { StatusReport } from "./status";

/** Hourly snapshots: at most one per road per this many minutes. */
const SNAPSHOT_EVERY_MIN = 55;

/**
 * Record what we showed: a 'change' row when a road's status differs from its last logged
 * status, and an 'hourly' snapshot when a road has had no row for about an hour.
 */
export async function logStatus(db: D1Database, report: StatusReport): Promise<number> {
  const at = report.generatedAt;
  const { results: last } = await db
    .prepare(
      // SQLite returns the status from the row holding MAX(at).
      "SELECT road_id, status, MAX(at) AS at FROM status_log GROUP BY road_id",
    )
    .all<{ road_id: string; status: string; at: string }>();
  const lastByRoad = new Map(last.map((r) => [r.road_id, r]));

  const insert = db.prepare(
    `INSERT INTO status_log (road_id, kind, status, previous_status, at, level_m, level_reading_at,
       rise_per_hour_m, rain_3h_mm, rain_12h_mm, warnings, report_counts, reasons)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const warnings = JSON.stringify(report.warnings.map((w) => ({ floodAreaId: w.floodAreaId, severityLevel: w.severityLevel })));
  const stmts = [];
  for (const road of report.roads) {
    const prev = lastByRoad.get(road.id);
    let kind: "change" | "hourly" | null = null;
    if (!prev || prev.status !== road.status) kind = "change";
    else if (Date.parse(at) - Date.parse(prev.at) >= SNAPSHOT_EVERY_MIN * 60_000) kind = "hourly";
    if (!kind) continue;
    const w = road.reports.weights;
    stmts.push(
      insert.bind(
        road.id, kind, road.status, prev?.status ?? null, at,
        report.river.levelM, report.river.readingAt, report.river.risePerHourM,
        report.rain.last3hMm, report.rain.last12hMm, warnings,
        JSON.stringify({ doNotAttempt: round(w.do_not_attempt), care: round(w.care), clear: round(w.clear) }),
        JSON.stringify(road.reasons),
      ),
    );
  }
  if (stmts.length) await db.batch(stmts);
  return stmts.length;
}

const round = (v: number) => Math.round(v * 100) / 100;
