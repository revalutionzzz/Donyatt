import { runCollector } from "./collector";
import { DONYATT_LEVEL_MEASURE, SNOWDON_HILL_RAIN_MEASURE } from "./config";

export interface Env {
  DB: D1Database;
  STATUS: KVNamespace;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/** Latest collected data, for checking the collector is working. Not a road status. */
async function health(env: Env): Promise<Response> {
  const latest = (measure: string) =>
    env.DB.prepare("SELECT ts, value FROM readings WHERE measure_id = ? ORDER BY ts DESC LIMIT 1")
      .bind(measure)
      .first<{ ts: string; value: number }>();
  const [level, rain, lastRun] = await Promise.all([
    latest(DONYATT_LEVEL_MEASURE),
    latest(SNOWDON_HILL_RAIN_MEASURE),
    env.DB.prepare("SELECT * FROM collector_runs ORDER BY started_at DESC LIMIT 1").first(),
  ]);
  return json({ donyattLevelM: level, snowdonHillRainMm15: rain, lastRun });
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/health") return health(env);
    return json({ error: "Not found" }, 404);
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(runCollector(env.DB));
  },
} satisfies ExportedHandler<Env>;
