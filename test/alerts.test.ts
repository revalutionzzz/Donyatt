import { describe, expect, it } from "vitest";
import { ALERT_STATE_KEY, alertSender, formatAlert, processAlerts, type AlertSender } from "../src/alerts";
import { adminReports, type ReportsEnv } from "../src/reportsApi";
import type { DriverReport } from "../src/reports";
import { computeStatus, type StatusReport, type TimedValue } from "../src/status";
import { logStatus } from "../src/statusLog";
import { createTestD1 } from "./d1-sqlite";

const T0 = Date.parse("2026-12-01T12:00:00Z");

/** A status report as computed at T0 + `min`, with the river steady at `level`. */
function reportAt(min: number, level: number, reports: DriverReport[] = []): StatusReport {
  const now = new Date(T0 + min * 60_000);
  const levels: TimedValue[] = Array.from({ length: 12 }, (_, i) => ({ ts: new Date(now.getTime() - (20 + (11 - i) * 15) * 60_000).toISOString(), value: level }));
  return computeStatus({ now, levels, rain: [], warnings: [], warningsCheckedAt: new Date(now.getTime() - 5 * 60_000).toISOString(), reports });
}

function fakeKV() {
  const store = new Map<string, string>();
  return {
    kv: {
      get: async (k: string, type?: string) => (store.has(k) ? (type === "json" ? JSON.parse(store.get(k)!) : store.get(k)) : null),
      put: async (k: string, v: string) => void store.set(k, v),
    } as unknown as KVNamespace,
    store,
  };
}

function telegram(fail = false) {
  const sent: { url: string; body: { chat_id: string; text: string; parse_mode: string } }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), body: JSON.parse(String(init!.body)) });
    return fail ? Response.json({ ok: false, description: "Bad Request: chat not found" }, { status: 400 }) : Response.json({ ok: true });
  }) as typeof fetch;
  const sender: AlertSender = { token: "123:SECRET", chatId: "@donyatt_test", fetchFn };
  return { sent, sender };
}

async function harness(fail = false) {
  const { d1, sqlite } = createTestD1();
  const { kv, store } = fakeKV();
  const tg = telegram(fail);
  /** What the app does on each refresh: log the status, then process alerts. */
  const step = async (min: number, level: number, sender = tg.sender, reports: DriverReport[] = []) => {
    const report = reportAt(min, level, reports);
    await logStatus(d1, report);
    return processAlerts(d1, kv, report, sender);
  };
  return { d1, sqlite, store, tg, step };
}

describe("Telegram alerts", () => {
  it("are off until both secrets are set", () => {
    expect(alertSender({})).toBeUndefined();
    expect(alertSender({ TELEGRAM_BOT_TOKEN: "x" })).toBeUndefined();
    expect(alertSender({ TELEGRAM_BOT_TOKEN: "x", TELEGRAM_CHAT_ID: "@c" })).toMatchObject({ token: "x", chatId: "@c" });
  });

  it("stay quiet on the first run, just recording the current statuses", async () => {
    const h = await harness();
    expect(await h.step(0, 0.3)).toEqual([]);
    expect(h.tg.sent).toHaveLength(0);
    expect(JSON.parse(h.store.get(ALERT_STATE_KEY)!)["a358-donyatt"].status).toBe("open");
  });

  it("send escalations at once", async () => {
    const h = await harness();
    await h.step(0, 0.3);
    const changes = await h.step(15, 1.9);
    expect(changes.map((c) => [c.roadId, c.from, c.to])).toEqual([
      ["a358-donyatt", "open", "avoid"],
    ]);
    expect(h.tg.sent).toHaveLength(1);
    const { url, body } = h.tg.sent[0];
    expect(url).toBe("https://api.telegram.org/bot123:SECRET/sendMessage");
    expect(body).toMatchObject({ chat_id: "@donyatt_test", parse_mode: "HTML" });
    expect(body.text).toContain("⛔ <b>AVOID</b> · A358 south of Donyatt");
    expect(body.text).toContain("Never drive into floodwater");
    expect(body.text).toContain("https://donyattfloodwatch.co.uk/");
    expect(body.text.toLowerCase()).not.toContain("safe");
    // No repeat while nothing changes.
    await h.step(30, 1.9);
    expect(h.tg.sent).toHaveLength(1);
  });

  it("hold back a single unconfirmed driver report, and send once a second driver confirms it", async () => {
    const h = await harness();
    const dna = (min: number, device: string): DriverReport => ({ roadId: "a358-donyatt", kind: "do_not_attempt", createdAt: new Date(T0 + min * 60_000).toISOString(), deviceHash: device });
    await h.step(0, 0.3);
    // One driver, river normal: Caution on the site, nothing on Telegram.
    expect(await h.step(15, 0.3, undefined, [dna(14, "aaa")])).toEqual([]);
    expect(h.tg.sent).toHaveLength(0);
    // The same driver again doesn't confirm it.
    expect(await h.step(30, 0.3, undefined, [dna(14, "aaa"), dna(29, "aaa")])).toEqual([]);
    // A second driver does: announced (two "Do not attempt" from different devices means Avoid).
    const changes = await h.step(45, 0.3, undefined, [dna(14, "aaa"), dna(29, "aaa"), dna(44, "bbb")]);
    expect(changes.map((c) => c.to)).toEqual(["avoid"]);
    expect(h.tg.sent).toHaveLength(1);
  });

  it("an unconfirmed report that fades away never sends anything", async () => {
    const h = await harness();
    const one: DriverReport = { roadId: "a358-donyatt", kind: "do_not_attempt", createdAt: new Date(T0 + 14 * 60_000).toISOString(), deviceHash: "aaa" };
    await h.step(0, 0.3);
    await h.step(15, 0.3, undefined, [one]);
    for (let min = 30; min <= 300; min += 15) await h.step(min, 0.3, undefined, [one]);
    expect(h.tg.sent).toHaveLength(0);
  });

  it("wait 30 minutes before announcing that things have eased", async () => {
    const h = await harness();
    await h.step(0, 0.3);
    await h.step(15, 1.3); // Caution: sent
    expect(h.tg.sent).toHaveLength(1);
    await h.step(30, 0.3); // back to Open: not yet
    await h.step(45, 0.3);
    expect(h.tg.sent).toHaveLength(1);
    await h.step(60, 0.3); // held 30 min: sent
    expect(h.tg.sent).toHaveLength(2);
    expect(h.tg.sent[1].body.text).toContain("✅ <b>OPEN</b> · A358 south of Donyatt");
  });

  it("don't flap when the river hovers around a threshold", async () => {
    const h = await harness();
    await h.step(0, 0.3);
    for (const [min, level] of [[15, 1.25], [30, 1.15], [45, 1.25], [60, 1.15], [75, 1.25]] as const) await h.step(min, level);
    // A single Caution message; the short dips back to Open were never announced.
    expect(h.tg.sent).toHaveLength(1);
  });

  it("retry on the next refresh if Telegram fails, and log every attempt", async () => {
    const h = await harness(true);
    await h.step(0, 0.3);
    expect(await h.step(15, 1.9)).toEqual([]);
    const ok = telegram();
    await h.step(30, 1.9, ok.sender);
    expect(ok.sent).toHaveLength(1);
    const rows = h.sqlite.prepare("SELECT ok, error FROM alerts_sent ORDER BY id").all();
    expect(rows).toEqual([
      { ok: 0, error: "Telegram 400: Bad Request: chat not found" },
      { ok: 1, error: null },
    ]);
  });

  it("escapes text so road names or reasons can't break the message", () => {
    const report = reportAt(0, 1.9);
    const text = formatAlert([{ roadId: "x", name: "A<b>&", from: "open", to: "avoid", reasons: ["<script>"] }], report);
    expect(text).toContain("A&lt;b&gt;&amp;");
    expect(text).toContain("&lt;script&gt;");
  });
});

describe("admin test message", () => {
  const req = () => new Request("https://donyatt.example/api/admin/alerts/test", { method: "POST", headers: { authorization: "Bearer admin-token-xyz" } });

  it("explains what's missing when alerts aren't set up", async () => {
    const env = { ADMIN_TOKEN: "admin-token-xyz" } as ReportsEnv;
    const res = await adminReports(req(), env, "/api/admin/alerts/test");
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toMatch(/TELEGRAM_BOT_TOKEN/);
  });
});
