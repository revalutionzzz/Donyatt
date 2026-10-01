import { alertSender } from "./alerts";
import { fillHistory, runCollector } from "./collector";
import { collectForecast, forecastHealth } from "./forecast";
import { loadHistory } from "./history";
import { adminReports, apiConfig, getPhoto, postReport, type ReportsEnv } from "./reportsApi";
import { DONYATT_LEVEL_MEASURE, SNOWDON_HILL_RAIN_MEASURE } from "./config";
import { getStatus, refreshStatus, runCollectorIfStale, STALE_RUN_MS } from "./statusService";

export interface Env extends ReportsEnv {
  DB: D1Database;
  STATUS: KVNamespace;
}

const json = (body: unknown, status = 200, cacheControl = "no-store") =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": cacheControl },
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

  const outcome = await runCollectorIfStale(env.DB, now, fetchFn);
  const cronLooksHealthy = outcome.lastRunAgeMs < STALE_RUN_MS;
  // Also a backstop for the forecast (self-throttled); the result shows in `forecast`.
  if (!outcome.ran) await collectForecast(env.DB, new Date(now), fetchFn).catch(() => undefined);
  const forecast = await forecastHealth(env.DB, new Date(now)).catch((err) => ({ error: errorMessage(err) }));
  if (!outcome.ran) return json({ ...data, cronLooksHealthy, forecast });

  if (env.STATUS) await refreshStatus(env.DB, env.STATUS, new Date(now), alertSender(env, fetchFn)).catch(() => undefined);
  return json({
    ...(await snapshot(env.DB).catch(() => data)),
    cronLooksHealthy,
    forecast,
    note: "No collector run in the last 20 minutes, so this request ran it.",
    fallbackRun: outcome.error ? { error: outcome.error } : outcome.result,
  });
}

export async function apiStatus(env: Env, now = Date.now(), fetchFn: typeof fetch = fetch): Promise<Response> {
  try {
    return json(await getStatus(env.DB, env.STATUS, now, fetchFn, alertSender(env, fetchFn)), 200, "public, max-age=60");
  } catch (err) {
    console.error("Status failed:", errorMessage(err));
    return json({ error: "Status is unavailable right now. Never drive into floodwater." }, 503);
  }
}

/** At most one history top-up attempt per isolate per 10 minutes. */
const FILL_THROTTLE_MS = 10 * 60 * 1000;
let lastFillAt = 0;

export async function apiHistory(env: Env, days: number, now = Date.now(), fetchFn: typeof fetch = fetch): Promise<Response> {
  try {
    let history = await loadHistory(env.DB, days, new Date(now));
    const first = history.level[0]?.[0];
    const short = !first || Date.parse(first) - Date.parse(history.from) > 60 * 60_000;
    if (short && now - lastFillAt > FILL_THROTTLE_MS) {
      lastFillAt = now;
      if ((await fillHistory(env.DB, new Date(now), fetchFn).catch(() => 0)) > 0) {
        history = await loadHistory(env.DB, days, new Date(now));
      }
    }
    // No fresh forecast (e.g. the cron isn't firing): fetch one now. Self-throttled.
    if (!history.forecastFetchedAt && (await collectForecast(env.DB, new Date(now), fetchFn).catch(() => 0)) > 0) {
      history = await loadHistory(env.DB, days, new Date(now));
    }
    return json(history, 200, "public, max-age=300");
  } catch (err) {
    console.error("History failed:", errorMessage(err));
    return json({ error: "History is unavailable right now." }, 503);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname, searchParams } = new URL(request.url);
    if (request.method === "GET" && pathname === "/api/status") return apiStatus(env);
    if (request.method === "GET" && pathname === "/api/history") return apiHistory(env, Number(searchParams.get("days") ?? 2));
    if (request.method === "GET" && pathname === "/health") return health(env);
    if (request.method === "GET" && pathname === "/api/config") return apiConfig(env);
    if (request.method === "POST" && pathname === "/api/reports") return postReport(request, env);
    if (pathname.startsWith("/api/admin/")) return adminReports(request, env, pathname);
    const photo = /^\/api\/photos\/(\d+)$/.exec(pathname);
    if (request.method === "GET" && photo) return getPhoto(env, Number(photo[1]));
    return json({ error: "Not found" }, 404);
  },

  async scheduled(controller, env, ctx): Promise<void> {
    console.log(`Cron ${controller.cron} fired at ${new Date(controller.scheduledTime).toISOString()}`);
    ctx.waitUntil(
      (async () => {
        try {
          console.log("Collector run", JSON.stringify(await runCollector(env.DB)));
          // Self-throttled to hourly (Open-Meteo updates hourly).
          await collectForecast(env.DB).catch((err) => console.error("Forecast failed:", errorMessage(err)));
          // Hourly, top up chart history if it's short (a no-op once 7 days are stored).
          if (new Date(controller.scheduledTime).getUTCMinutes() < 15) {
            await fillHistory(env.DB).catch((err) => console.error("History top-up failed:", errorMessage(err)));
          }
        } catch (err) {
          console.error("Collector run failed:", errorMessage(err));
        }
        // Refresh the status even if collection failed, so stale data is reported as such.
        try {
          await refreshStatus(env.DB, env.STATUS, new Date(), alertSender(env));
        } catch (err) {
          console.error("Status refresh failed:", errorMessage(err));
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
