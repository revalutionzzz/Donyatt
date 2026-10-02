import { SITE_URL } from "./config";
import { ALERTS } from "./rules";
import { ADVICE, type RoadStatus, type StatusReport } from "./status";

export const ALERT_STATE_KEY = "alerts:state:v1";
/** Last EA alert/warning we told people about, per flood area (severity level 1-3). */
export const EA_STATE_KEY = "alerts:ea:v1";

export interface AlertSender {
  token: string;
  chatId: string;
  fetchFn?: typeof fetch;
}

interface AlertEnv {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

/** Alerts are off until both Telegram secrets exist. */
export function alertSender(env: AlertEnv, fetchFn?: typeof fetch): AlertSender | undefined {
  return env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID ? { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID, fetchFn } : undefined;
}

/** Last status we told people about, per road. */
type AlertState = Record<string, { status: RoadStatus; at: string }>;

const ESCALATION_RANK: Record<RoadStatus, number> = { open: 0, unknown: 0, caution: 1, avoid: 2 };
const ICON: Record<RoadStatus, string> = { avoid: "⛔", caution: "⚠️", open: "✅", unknown: "❔" };
const LABEL: Record<RoadStatus, string> = { avoid: "AVOID", caution: "CAUTION", open: "OPEN", unknown: "UNKNOWN" };

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface RoadChange {
  roadId: string;
  name: string;
  from: RoadStatus;
  to: RoadStatus;
  reasons: string[];
}

/** An EA flood alert or warning issued, changed or lifted. Levels: 1 severe warning, 2 warning, 3 alert; null = none. */
export interface EaChange {
  floodAreaId: string;
  from: number | null;
  to: number | null;
}

const EA_NAME: Record<number, string> = { 1: "severe flood warning", 2: "flood warning", 3: "flood alert" };
const EA_ICON: Record<number, string> = { 1: "🚨", 2: "🔴", 3: "🟠" };
const EA_AREAS: Record<string, string> = {
  "112FWFISL10A": "the River Isle from Chard Reservoir to Hambridge",
  "112WAFTSSR": "South Somerset Rivers, Upper Reaches",
};

function describeEa(c: EaChange): string {
  const area = escapeHtml(EA_AREAS[c.floodAreaId] ?? c.floodAreaId);
  if (c.to === null) return `✅ <b>The Environment Agency has removed the ${EA_NAME[c.from!]}</b> for ${area}.`;
  if (c.from === null) return `${EA_ICON[c.to]} <b>The Environment Agency has issued a ${EA_NAME[c.to]}</b> for ${area}.`;
  const verb = c.to < c.from ? "upgraded" : "downgraded";
  return `${EA_ICON[c.to]} <b>The Environment Agency has ${verb} the ${EA_NAME[c.from]} to a ${EA_NAME[c.to]}</b> for ${area}.`;
}

export function formatAlert(changes: RoadChange[], report: StatusReport, ea: EaChange[] = []): string {
  const eaBlocks = ea.map(describeEa);
  // An EA-only message still says where each road stands.
  const statusLines = changes.length ? [] : report.roads.map((r) => `${ICON[r.status]} ${escapeHtml(r.name)}: <b>${LABEL[r.status]}</b>`);
  const blocks = changes.map((c) => {
    const lines = [`${ICON[c.to]} <b>${LABEL[c.to]}</b> · ${escapeHtml(c.name)}`, `<i>was ${LABEL[c.from].toLowerCase()}</i>`];
    for (const r of c.reasons.slice(0, 3)) lines.push(`• ${escapeHtml(r)}`);
    return lines.join("\n");
  });
  const river = report.river.levelM == null ? null : `River Isle at Donyatt: ${report.river.levelM.toFixed(2)} m${report.river.trend ? `, ${report.river.trend}` : ""}.`;
  return [...eaBlocks, ...statusLines, ...blocks, ...(river ? [river] : []), `<b>${escapeHtml(ADVICE)}</b>`, `<a href="${SITE_URL}">Live status</a>`].join("\n\n");
}

export async function sendTelegram(sender: AlertSender, text: string): Promise<void> {
  const res = await (sender.fetchFn ?? fetch)(`https://api.telegram.org/bot${sender.token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: sender.chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { description?: string };
    // Never echo the token: Telegram's error text doesn't contain it, and neither does ours.
    throw new Error(`Telegram ${res.status}${body.description ? `: ${body.description}` : ""}`);
  }
}

/** EA alerts/warnings in force now, by flood area, or null if the EA hasn't been checked yet. */
function eaNow(report: StatusReport): Record<string, number> | null {
  if (!report.warningsCheckedAt) return null;
  const now: Record<string, number> = {};
  for (const w of report.warnings) now[w.floodAreaId] = Math.min(now[w.floodAreaId] ?? 9, w.severityLevel);
  return now;
}

function eaChanges(last: Record<string, number>, now: Record<string, number>): EaChange[] {
  const ids = [...new Set([...Object.keys(last), ...Object.keys(now)])].sort();
  return ids.filter((id) => last[id] !== now[id]).map((id) => ({ floodAreaId: id, from: last[id] ?? null, to: now[id] ?? null }));
}

/**
 * Decide which roads and EA alerts/warnings to announce, send one combined message, and remember
 * what was sent. The first run only records the current state (no announcement on switch-on).
 * EA alerts and warnings are announced when issued, upgraded, downgraded or removed, even if the
 * road's status doesn't change (e.g. already on Caution from heavy rain).
 */
export async function processAlerts(db: D1Database, kv: KVNamespace, report: StatusReport, sender: AlertSender): Promise<RoadChange[]> {
  const state = (await kv.get<AlertState>(ALERT_STATE_KEY, "json")) ?? null;
  const now = report.generatedAt;
  const eaCurrent = eaNow(report);
  const eaLast = await kv.get<Record<string, number>>(EA_STATE_KEY, "json");
  if (eaCurrent && !eaLast) await kv.put(EA_STATE_KEY, JSON.stringify(eaCurrent)); // first EA run: record silently
  const ea = eaCurrent && eaLast ? eaChanges(eaLast, eaCurrent) : [];
  if (!state) {
    const initial: AlertState = Object.fromEntries(report.roads.map((r) => [r.id, { status: r.status, at: now }]));
    await kv.put(ALERT_STATE_KEY, JSON.stringify(initial));
    return [];
  }

  // When each road's current status began (status_log is written just before this runs).
  const { results } = await db
    .prepare("SELECT road_id, status, MAX(at) AS since FROM status_log WHERE kind = 'change' GROUP BY road_id")
    .all<{ road_id: string; status: string; since: string }>();
  const since = new Map(results.map((r) => [r.road_id, r]));

  const changes: RoadChange[] = [];
  for (const road of report.roads) {
    const last = state[road.id];
    if (!last) {
      state[road.id] = { status: road.status, at: now };
      continue;
    }
    if (last.status === road.status) continue;
    // One unconfirmed driver report (the data shows nothing): shown on the site, not announced.
    // The state stays as it was, so it goes out as soon as it's confirmed, and silently clears if not.
    if (road.unconfirmed) continue;
    const escalation = road.status !== "unknown" && ESCALATION_RANK[road.status] > ESCALATION_RANK[last.status];
    const began = since.get(road.id);
    const heldFor = began && began.status === road.status ? Date.parse(now) - Date.parse(began.since) : 0;
    if (escalation || heldFor >= ALERTS.holdMinutes * 60_000) {
      changes.push({ roadId: road.id, name: road.name, from: last.status, to: road.status, reasons: road.reasons });
    }
  }
  if (!changes.length && !ea.length) {
    await kv.put(ALERT_STATE_KEY, JSON.stringify(state));
    return [];
  }

  const text = formatAlert(changes, report, ea);
  let error: string | null = null;
  try {
    await sendTelegram(sender, text);
    for (const c of changes) state[c.roadId] = { status: c.to, at: now };
    if (ea.length) await kv.put(EA_STATE_KEY, JSON.stringify(eaCurrent));
  } catch (err) {
    // State is left unchanged, so the next refresh tries again.
    error = err instanceof Error ? err.message : String(err);
    console.error("Alert failed:", error);
  }
  await kv.put(ALERT_STATE_KEY, JSON.stringify(state));
  await db
    .prepare("INSERT INTO alerts_sent (at, roads, text, ok, error) VALUES (?, ?, ?, ?, ?)")
    .bind(now, JSON.stringify([...changes.map(({ roadId, from, to }) => ({ roadId, from, to })), ...ea.map(({ floodAreaId, from, to }) => ({ ea: floodAreaId, from, to }))]), text, error ? 0 : 1, error)
    .run();
  return error ? [] : changes;
}
