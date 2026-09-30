import { runCollector } from "./collector";
import { DONYATT_LEVEL_MEASURE, SNOWDON_HILL_RAIN_MEASURE } from "./config";

export interface Env {
  DB: D1Database;
  STATUS: KVNamespace;
}

/** If the cron hasn't produced a run for this long, /health runs the collector itself. */
const STALE_RUN_MS = 20 * 60 * 1000;
/** At most one /health-triggered run per isolate per minute, so repeated reloads can't hammer the EA API. */
const FALLBACK_THROTTLE_MS = 60 * 1000;
let lastFallbackAt = 0;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function snapshot(db: D1Database) {
  const latest = (measure: string) =>
    db.prepare("SELECT ts, value FROM readings WHERE measure_id = ? ORDER BY ts DESC LIMIT 1")
      .bind(measure)
      .first<{ ts: string; value: number }>();
  const [level, rain, lastRun] = await Promise.all([
    latest(DONYATT_LEVEL_MEASURE),
    latest(SNOWDON_HILL_RAIN_MEASURE),
    db.prepare("SELECT * FROM collector_runs ORDER BY started_at DESC LIMIT 1").first<{ started_at: string }>(),
  ]);
  return { donyattLevelM: level, snowdonHillRainMm15: rain, lastRun };
}

/**
 * Latest collected data, for checking the collector is working. Not a road status.
 * Also a backstop for the cron: if no run is recent, run the collector now and report
 * what happened (including the error, if it fails).
 */
export async function health(env: Env, now = Date.now(), fetchFn: typeof fetch = fetch): Promise<Response> {
  let data;
  try {
    data = await snapshot(env.DB);
  } catch (err) {
    return json({ error: `Database query failed: ${errorMessage(err)}` }, 500);
  }

  const lastRunAge = data.lastRun ? now - Date.parse(data.lastRun.started_at) : Infinity;
  if (lastRunAge < STALE_RUN_MS || now - lastFallbackAt < FALLBACK_THROTTLE_MS) {
    return json({ ...data, cronLooksHealthy: lastRunAge < STALE_RUN_MS });
  }

  lastFallbackAt = now;
  let fallbackRun;
  try {
    fallbackRun = await runCollector(env.DB, new Date(now), fetchFn);
  } catch (err) {
    fallbackRun = { error: errorMessage(err) };
  }
  return json({
    ...(await snapshot(env.DB).catch(() => data)),
    cronLooksHealthy: false,
    note: "No collector run in the last 20 minutes, so this request ran it.",
    fallbackRun,
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/health") return health(env);
    return json({ error: "Not found. Try /health" }, 404);
  },

  async scheduled(controller, env, ctx): Promise<void> {
    console.log(`Cron ${controller.cron} fired at ${new Date(controller.scheduledTime).toISOString()}`);
    ctx.waitUntil(
      runCollector(env.DB).then(
        (r) => console.log("Collector run", JSON.stringify(r)),
        (err) => console.error("Collector run failed:", errorMessage(err)),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
