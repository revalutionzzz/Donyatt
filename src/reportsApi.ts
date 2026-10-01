import { alertSender, sendTelegram } from "./alerts";
import { JpegError, stripJpegMetadata } from "./jpeg";
import { REPORT_KINDS, VISIBLE_PHOTO_SQL, type ReportKind } from "./reports";
import { PHOTOS, ROADS } from "./rules";
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
  /** R2 bucket donyatt-photos. Photos are off until the binding is added to wrangler.toml. */
  PHOTOS?: R2Bucket;
  /** Telegram alerts (Worker secrets). Off until both exist. */
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
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
  return json({
    reportsEnabled: reportsEnabled(env),
    photosEnabled: reportsEnabled(env) && Boolean(env.PHOTOS),
    turnstileSiteKey: reportsEnabled(env) ? env.TURNSTILE_SITE_KEY : null,
  });
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
  // JSON for a text-only report; multipart form data when a photo is attached.
  const type = request.headers.get("content-type") ?? "";
  const declared = Number(request.headers.get("content-length") ?? 0);
  let raw: unknown;
  let photoFile: File | null = null;
  if (type.includes("application/json")) {
    const text = await request.text();
    if (text.length > LIMITS.maxBodyBytes) return json({ error: "Too large." }, 413);
    try {
      raw = JSON.parse(text);
    } catch {
      return json({ error: "Expected JSON." }, 400);
    }
  } else if (type.includes("multipart/form-data")) {
    if (declared > PHOTOS.maxBytes + 64_000) return json({ error: "That photo is too large." }, 413);
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return json({ error: "Couldn't read the form." }, 400);
    }
    raw = Object.fromEntries(["roadId", "kind", "token", "deviceId"].map((k) => [k, form.get(k)]));
    const p = form.get("photo");
    if (p && typeof p !== "string") photoFile = p;
  } else {
    return json({ error: "Expected JSON." }, 415);
  }
  const body = parseBody(raw);
  if (typeof body === "string") return json({ error: body }, 400);

  // Check the photo before anything is stored, so a bad photo never leaves a half-made report.
  let photo: Uint8Array | null = null;
  if (photoFile) {
    if (photoFile.size > PHOTOS.maxBytes) return json({ error: "That photo is too large." }, 413);
    try {
      const info = stripJpegMetadata(new Uint8Array(await photoFile.arrayBuffer()));
      if (info.width > PHOTOS.maxDimension || info.height > PHOTOS.maxDimension) {
        return json({ error: "That photo is too large." }, 413);
      }
      photo = info.bytes;
    } catch (err) {
      if (err instanceof JpegError) return json({ error: "That photo couldn't be read. Try again, or send the report without it." }, 400);
      throw err;
    }
  }

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
  const status: StatusReport = await getStatus(env.DB, env.STATUS, now.getTime(), fetchFn, alertSender(env, fetchFn));
  const shown = status.roads.find((r) => r.id === body.roadId)?.status ?? null;
  const worstWarning = status.warnings.length ? Math.min(...status.warnings.map((w) => w.severityLevel)) : null;
  const inserted = await env.DB
    .prepare(
      `INSERT INTO reports (road_id, kind, created_at, device_hash, ip_hash, status_shown, level_m,
         level_reading_at, rise_per_hour_m, rain_3h_mm, ea_warning_level)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(body.roadId, body.kind, now.toISOString(), deviceHash, ipHash, shown, status.river.levelM,
      status.river.readingAt, status.river.risePerHourM, status.rain.last3hMm, worstWarning)
    .run();

  let photoNote: string | undefined;
  if (photo) photoNote = await storePhoto(env, Number(inserted.meta.last_row_id), photo, dayStart);

  // Count it straight away.
  const updated = await refreshStatus(env.DB, env.STATUS, now, alertSender(env, fetchFn));
  return json({ ok: true, road: updated.roads.find((r) => r.id === body.roadId), photoNote }, 201);
}

/** Store a checked, metadata-free photo for a report. Returns a note for the reporter. */
async function storePhoto(env: ReportsEnv, reportId: number, bytes: Uint8Array, dayStart: string): Promise<string> {
  if (!env.PHOTOS) return "Photos aren't switched on yet, so your report was sent without it.";
  const today = await count(env.DB, "SELECT COUNT(*) AS n FROM reports WHERE has_photo = 1 AND created_at >= ?", dayStart);
  if (today >= PHOTOS.maxPerDay) return "Photo uploads are paused for today, so your report was sent without it.";
  const key = `reports/${reportId}-${crypto.randomUUID()}.jpg`;
  await env.PHOTOS.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
  await env.DB
    .prepare("UPDATE reports SET has_photo = 1, photo_state = 'pending', photo_key = ? WHERE id = ?")
    .bind(key, reportId)
    .run();
  return "Your photo will appear once it's checked or another driver confirms the same thing.";
}

async function photoResponse(env: ReportsEnv, key: string, cacheControl: string): Promise<Response> {
  const obj = await env.PHOTOS!.get(key);
  if (!obj) return json({ error: "Photo not found." }, 404);
  return new Response(obj.body, {
    headers: { "content-type": "image/jpeg", "cache-control": cacheControl, "x-content-type-options": "nosniff" },
  });
}

/** GET /api/photos/:id — only photos that are approved or corroborated, and under 48 h old. */
export async function getPhoto(env: ReportsEnv, id: number, now = new Date()): Promise<Response> {
  if (!env.PHOTOS || !Number.isInteger(id)) return json({ error: "Photo not found." }, 404);
  const row = await env.DB
    .prepare(`SELECT r.photo_key AS key FROM reports r WHERE r.id = ? AND ${VISIBLE_PHOTO_SQL}`)
    .bind(id, new Date(now.getTime() - PHOTOS.maxAgeHours * 3_600_000).toISOString(), PHOTOS.corroborateMinutes)
    .first<{ key: string }>();
  if (!row) return json({ error: "Photo not found." }, 404);
  return photoResponse(env, row.key, "public, max-age=300");
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

/**
 * GET /api/admin/reports, GET /api/admin/photos/:id, POST /api/admin/reports/:id/hide|unhide and
 * POST /api/admin/reports/:id/photo/approve|reject. Off (404) until ADMIN_TOKEN is set.
 */
export async function adminReports(request: Request, env: ReportsEnv, pathname: string, now = new Date()): Promise<Response> {
  if (!env.ADMIN_TOKEN) return json({ error: "Not found" }, 404);
  if (!(await isAdmin(request, env))) return json({ error: "Wrong or missing admin token." }, 401);

  if (request.method === "GET" && pathname === "/api/admin/reports") {
    const since = new Date(now.getTime() - 14 * 86_400_000).toISOString();
    const { results } = await env.DB
      .prepare(
        `SELECT id, road_id AS roadId, kind, created_at AS createdAt, status_shown AS statusShown,
           level_m AS levelM, hidden, hidden_reason AS hiddenReason, substr(device_hash, 1, 8) AS device,
           has_photo AS hasPhoto, photo_state AS photoState, photo_key IS NOT NULL AS photoStored
         FROM reports WHERE created_at >= ? ORDER BY created_at DESC LIMIT 500`,
      )
      .bind(since)
      .all();
    return json({ reports: results });
  }

  if (request.method === "POST" && pathname === "/api/admin/alerts/test") {
    const sender = alertSender(env);
    if (!sender) return json({ error: "Alerts aren't set up: add the TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID secrets." }, 400);
    try {
      await sendTelegram(sender, "✅ Test message from Donyatt Flood Watch. Alerts are working.");
      return json({ ok: true });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  }

  const photoView = /^\/api\/admin\/photos\/(\d+)$/.exec(pathname);
  if (request.method === "GET" && photoView) {
    if (!env.PHOTOS) return json({ error: "Photos aren't switched on." }, 404);
    const row = await env.DB.prepare("SELECT photo_key AS key FROM reports WHERE id = ? AND photo_key IS NOT NULL").bind(Number(photoView[1])).first<{ key: string }>();
    if (!row) return json({ error: "No photo." }, 404);
    return photoResponse(env, row.key, "private, no-store");
  }

  const photoAction = /^\/api\/admin\/reports\/(\d+)\/photo\/(approve|reject)$/.exec(pathname);
  if (request.method === "POST" && photoAction) {
    const id = Number(photoAction[1]);
    const row = await env.DB.prepare("SELECT photo_key AS key FROM reports WHERE id = ? AND has_photo = 1").bind(id).first<{ key: string | null }>();
    if (!row) return json({ error: "No photo for that report." }, 404);
    if (photoAction[2] === "approve") {
      await env.DB.prepare("UPDATE reports SET photo_state = 'approved' WHERE id = ?").bind(id).run();
    } else {
      // Rejected photos are deleted straight away, not left for the lifecycle rule.
      if (row.key && env.PHOTOS) await env.PHOTOS.delete(row.key);
      await env.DB.prepare("UPDATE reports SET photo_state = 'rejected', photo_key = NULL WHERE id = ?").bind(id).run();
    }
    await refreshStatus(env.DB, env.STATUS, now, alertSender(env));
    return json({ ok: true });
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
    await refreshStatus(env.DB, env.STATUS, now, alertSender(env));
    return json({ ok: true });
  }
  return json({ error: "Not found" }, 404);
}
