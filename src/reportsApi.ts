import { REPORT_KINDS, type ReportKind } from "./reports";
import { ROADS } from "./rules";
import type { StatusReport } from "./status";
import { getStatus, refreshStatus } from "./statusService";

export interface ReportsEnv {
  DB: D1Database;
  STATUS: KVNamespace;
  /** Public Turnstile site key (wrangler.toml [vars]). */
  TURNSTILE_SITE_KEY?: string;
  /** Turnstile secret (Worker secret). Reports are off until both keys exist. */
  TURNSTILE_SECRET_KEY?: string;
  /** Moderation token (Worker secret). Admin endpoints are off until it exists. */
  ADMIN_TOKEN?: string;
}

export const LIMITS = {
  /** One report per road per device in this window. */
  sameRoadMinutes: 10,
  perDevicePerDay: 6,
  /** Per network address: generous, because households and mobile networks share addresses. */
  perIpPerDay: 20,
  maxBodyBytes: 4096,
};

const TURNSTILE_VERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export const reportsEnabled = (env: ReportsEnv) => Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY);

export function apiConfig(env: ReportsEnv): Response {
  return json({ reportsEnabled: reportsEnabled(env), turnstileSiteKey: reportsEnabled(env) ? env.TURNSTILE_SITE_KEY : null });
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Today's hashing key, random and kept in KV for 3 days. Hashes made with it can be compared
 * within a day (rate limiting) but not across days, so nobody can be tracked over time.
 */
export async function dailySalt(kv: KVNamespace, now: Date): Promise<string> {
  const key = `salt:${now.toISOString().slice(0, 10)}`;
  const existing = await kv.get(key);
  if (existing) return existing;
  const salt = hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
  await kv.put(key, salt, { expirationTtl: 3 * 86_400 });
  return salt;
}

export async function hmac(salt: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))).slice(0, 32);
}

export async function verifyTurnstile(secret: string, token: string, ip: string | null, fetchFn: typeof fetch = fetch): Promise<boolean> {
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  try {
    const res = await fetchFn(TURNSTILE_VERIFY, { method: "POST", body: form, signal: AbortSignal.timeout(10_000) });
    const body = (await res.json()) as { success?: boolean };
    return body.success === true;
  } catch {
    return false;
  }
}

interface ReportBody {
  roadId: string;
  kind: ReportKind;
  token: string;
  deviceId: string;
}

function parseBody(raw: unknown): ReportBody | string {
  const b = raw as Partial<Record<keyof ReportBody, unknown>>;
  if (typeof b?.roadId !== "string" || !ROADS.some((r) => r.id === b.roadId)) return "Unknown road.";
  if (typeof b.kind !== "string" || !(REPORT_KINDS as readonly string[]).includes(b.kind)) return "Unknown report type.";
  if (typeof b.token !== "string" || b.token.length < 10 || b.token.length > 4096) return "Missing spam check.";
  if (typeof b.deviceId !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(b.deviceId)) return "Missing device code.";
  return b as ReportBody;
}

const count = async (db: D1Database, sql: string, ...args: (string | number)[]) =>
  (await db.prepare(sql).bind(...args).first<{ n: number }>())?.n ?? 0;

export async function postReport(request: Request, env: ReportsEnv, now = new Date(), fetchFn: typeof fetch = fetch): Promise<Response> {
  if (!reportsEnabled(env)) return json({ error: "Reports aren't switched on yet." }, 503);
  if (!(request.headers.get("content-type") ?? "").includes("application/json")) return json({ error: "Expected JSON." }, 415);
  const text = await request.text();
  if (text.length > LIMITS.maxBodyBytes) return json({ error: "Too large." }, 413);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return json({ error: "Expected JSON." }, 400);
  }
  const body = parseBody(raw);
  if (typeof body === "string") return json({ error: body }, 400);

  const ip = request.headers.get("cf-connecting-ip");
  if (!(await verifyTurnstile(env.TURNSTILE_SECRET_KEY!, body.token, ip, fetchFn))) {
    return json({ error: "The spam check didn't pass. Please try again." }, 403);
  }

  const salt = await dailySalt(env.STATUS, now);
  const [deviceHash, ipHash] = await Promise.all([hmac(salt, `device:${body.deviceId}`), hmac(salt, `ip:${ip ?? "unknown"}`)]);
  const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const recentSameRoad = new Date(now.getTime() - LIMITS.sameRoadMinutes * 60_000).toISOString();
  const [sameRoad, perDevice, perIp] = await Promise.all([
    count(env.DB, "SELECT COUNT(*) AS n FROM reports WHERE device_hash = ? AND road_id = ? AND created_at >= ?", deviceHash, body.roadId, recentSameRoad),
    count(env.DB, "SELECT COUNT(*) AS n FROM reports WHERE device_hash = ? AND created_at >= ?", deviceHash, dayStart),
    count(env.DB, "SELECT COUNT(*) AS n FROM reports WHERE ip_hash = ? AND created_at >= ?", ipHash, dayStart),
  ]);
  if (sameRoad > 0) return json({ error: `Thanks, you've already reported this road in the last ${LIMITS.sameRoadMinutes} minutes.` }, 429);
  if (perDevice >= LIMITS.perDevicePerDay || perIp >= LIMITS.perIpPerDay) {
    return json({ error: "Thanks for your reports today. You've reached the daily limit." }, 429);
  }

  // Snapshot of what we knew when the report was made.
  const status: StatusReport = await getStatus(env.DB, env.STATUS, now.getTime(), fetchFn);
  const shown = status.roads.find((r) => r.id === body.roadId)?.status ?? null;
  const worstWarning = status.warnings.length ? Math.min(...status.warnings.map((w) => w.severityLevel)) : null;
  await env.DB
    .prepare(
      `INSERT INTO reports (road_id, kind, created_at, device_hash, ip_hash, status_shown, level_m,
         level_reading_at, rise_per_hour_m, rain_3h_mm, ea_warning_level)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(body.roadId, body.kind, now.toISOString(), deviceHash, ipHash, shown, status.river.levelM,
      status.river.readingAt, status.river.risePerHourM, status.rain.last3hMm, worstWarning)
    .run();

  // Count it straight away.
  const updated = await refreshStatus(env.DB, env.STATUS, now);
  return json({ ok: true, road: updated.roads.find((r) => r.id === body.roadId) }, 201);
}

// ---------------------------------------------------------------- moderation

async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([a, b].map((s) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

async function isAdmin(request: Request, env: ReportsEnv): Promise<boolean> {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return Boolean(env.ADMIN_TOKEN && token && (await constantTimeEqual(token, env.ADMIN_TOKEN)));
}

/** GET /api/admin/reports and POST /api/admin/reports/:id/hide|unhide. Off (404) until ADMIN_TOKEN is set. */
export async function adminReports(request: Request, env: ReportsEnv, pathname: string, now = new Date()): Promise<Response> {
  if (!env.ADMIN_TOKEN) return json({ error: "Not found" }, 404);
  if (!(await isAdmin(request, env))) return json({ error: "Wrong or missing admin token." }, 401);

  if (request.method === "GET" && pathname === "/api/admin/reports") {
    const since = new Date(now.getTime() - 14 * 86_400_000).toISOString();
    const { results } = await env.DB
      .prepare(
        `SELECT id, road_id AS roadId, kind, created_at AS createdAt, status_shown AS statusShown,
           level_m AS levelM, hidden, hidden_reason AS hiddenReason, substr(device_hash, 1, 8) AS device
         FROM reports WHERE created_at >= ? ORDER BY created_at DESC LIMIT 500`,
      )
      .bind(since)
      .all();
    return json({ reports: results });
  }

  const m = /^\/api\/admin\/reports\/(\d+)\/(hide|unhide)$/.exec(pathname);
  if (request.method === "POST" && m) {
    let reason: string | null = null;
    try {
      const body = (await request.json()) as { reason?: unknown };
      if (typeof body.reason === "string") reason = body.reason.slice(0, 200);
    } catch {
      // No body is fine.
    }
    const hide = m[2] === "hide";
    const res = await env.DB
      .prepare("UPDATE reports SET hidden = ?, hidden_reason = ? WHERE id = ?")
      .bind(hide ? 1 : 0, hide ? reason : null, Number(m[1]))
      .run();
    if (!res.meta.changes) return json({ error: "No such report." }, 404);
    await refreshStatus(env.DB, env.STATUS, now);
    return json({ ok: true });
  }
  return json({ error: "Not found" }, 404);
}
