/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCollector } from "../src/collector";
import { DONYATT_LEVEL_MEASURE, SNOWDON_HILL_RAIN_MEASURE } from "../src/config";
import { reportWeight, summariseReports, type DriverReport, type ReportKind } from "../src/reports";
import { adminReports, apiConfig, dailySalt, LIMITS, postReport, type ReportsEnv } from "../src/reportsApi";
import { computeStatus, type StatusInputs, type TimedValue } from "../src/status";
import { logStatus } from "../src/statusLog";
import { createTestD1 } from "./d1-sqlite";

// ---------------------------------------------------------------- helpers

const NOW = new Date("2026-12-01T12:00:00Z");
const minsAgo = (m: number, from = NOW) => new Date(from.getTime() - m * 60_000).toISOString();
const report = (kind: ReportKind, ageMin: number, roadId = "a358-donyatt"): DriverReport => ({ roadId, kind, createdAt: minsAgo(ageMin) });

function series(values: number[], lagMin = 20): TimedValue[] {
  const end = NOW.getTime() - lagMin * 60_000;
  return values.map((value, i) => ({ ts: new Date(end - (values.length - 1 - i) * 900_000).toISOString(), value }));
}
function inputs(over: Partial<StatusInputs> = {}): StatusInputs {
  return { now: NOW, levels: series(Array(32).fill(0.25)), rain: series(Array(48).fill(0)), warnings: [], warningsCheckedAt: minsAgo(10), reports: [], ...over };
}
const a358 = (i: StatusInputs) => computeStatus(i).roads.find((r) => r.id === "a358-donyatt")!;

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

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
/** EA fixtures plus a Turnstile endpoint that accepts the token "good-token-123". */
function fakeFetch() {
  const turnstileCalls: FormData[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("turnstile")) {
      const form = init!.body as FormData;
      turnstileCalls.push(form);
      return Response.json({ success: form.get("response") === "good-token-123" && form.get("secret") === "secret" });
    }
    if (url.includes(DONYATT_LEVEL_MEASURE)) return new Response(fixture("donyatt-level-readings.json"));
    if (url.includes(SNOWDON_HILL_RAIN_MEASURE)) return new Response(fixture("snowdon-hill-rainfall-readings.json"));
    return new Response(fixture("floods-none-local.json"));
  }) as typeof fetch;
  return { fn, turnstileCalls };
}

// The saved EA fixtures end at 2026-09-30T20:00Z, so "now" for API tests is just after.
const API_NOW = new Date("2026-09-30T20:20:00Z");

async function setup(over: Partial<ReportsEnv> = {}) {
  const { d1, sqlite } = createTestD1();
  const { kv, store } = fakeKV();
  const f = fakeFetch();
  await runCollector(d1, new Date("2026-09-30T20:10:00Z"), f.fn);
  const env: ReportsEnv = { DB: d1, STATUS: kv, TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret", ADMIN_TOKEN: "admin-token-xyz", ...over };
  return { env, sqlite, store, f };
}

function post(body: unknown, ip = "203.0.113.7") {
  return new Request("https://donyatt.example/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify(body),
  });
}
const good = (over: Record<string, unknown> = {}) => ({ roadId: "a358-donyatt", kind: "do_not_attempt", token: "good-token-123", deviceId: "device-aaaa-1111", ...over });

// ---------------------------------------------------------------- weighting

describe("report weighting", () => {
  it("counts fully for 30 minutes, then fades to nothing at 3 hours", () => {
    expect(reportWeight(0)).toBe(1);
    expect(reportWeight(30)).toBe(1);
    expect(reportWeight(105)).toBeCloseTo(0.5);
    expect(reportWeight(180)).toBe(0);
    expect(reportWeight(500)).toBe(0);
  });

  it("summarises one road's live reports, newest first", () => {
    const s = summariseReports([report("care", 50), report("clear", 5), report("clear", 200), report("care", 1, "b3168-ilford-bridges")], "a358-donyatt", NOW);
    expect(s.recent).toEqual([{ kind: "clear", ageMinutes: 5 }, { kind: "care", ageMinutes: 50 }]);
    expect(s.weights.clear).toBe(1);
  });
});

describe("reports in the road status", () => {
  it("one fresh 'Do not attempt' means Caution; two mean Avoid", () => {
    const one = a358(inputs({ reports: [report("do_not_attempt", 5)] }));
    expect(one.status).toBe("caution");
    expect(one.reasons).toContain('1 driver reported "Do not attempt" (latest 5 min ago).');
    expect(a358(inputs({ reports: [report("do_not_attempt", 5), report("do_not_attempt", 12)] })).status).toBe("avoid");
  });

  it("older reports carry less weight", () => {
    // 1 + 0.53 = 1.53: Avoid. Two 2-hour-old reports (0.4 each): Caution only.
    expect(a358(inputs({ reports: [report("do_not_attempt", 5), report("do_not_attempt", 100)] })).status).toBe("avoid");
    expect(a358(inputs({ reports: [report("do_not_attempt", 120), report("do_not_attempt", 120)] })).status).toBe("caution");
    expect(a358(inputs({ reports: [report("do_not_attempt", 179)] })).status).toBe("open");
  });

  it("'Passable with care' means Caution", () => {
    expect(a358(inputs({ reports: [report("care", 10)] })).status).toBe("caution");
  });

  it("'Clear' reports never lower the status", () => {
    const flooded = inputs({ levels: series(Array(8).fill(1.9)), reports: Array.from({ length: 6 }, (_, i) => report("clear", i)) });
    expect(a358(flooded).status).toBe("avoid");
    expect(a358(flooded).reasons.join(" ")).not.toMatch(/clear/i);
    const stale = inputs({ levels: [], reports: [report("clear", 1)] });
    expect(a358(stale).status).toBe("unknown");
  });

  it("'Clear' reports are shown as information when the road is Open", () => {
    const r = a358(inputs({ reports: [report("clear", 3), report("clear", 40)] }));
    expect(r.status).toBe("open");
    expect(r.reasons.at(-1)).toBe('2 drivers reported "Clear" (latest 3 min ago).');
  });

  it("reports raise the status even when river data is stale", () => {
    expect(a358(inputs({ levels: [], reports: [report("do_not_attempt", 1), report("do_not_attempt", 2)] })).status).toBe("avoid");
  });

  it("only affects the road reported", () => {
    const report2 = computeStatus(inputs({ reports: [report("do_not_attempt", 1), report("do_not_attempt", 2)] }));
    expect(report2.roads.map((r) => r.status)).toEqual(["avoid", "open", "open"]);
  });
});

// ---------------------------------------------------------------- status log

describe("status log", () => {
  it("logs changes immediately and otherwise one snapshot an hour", async () => {
    const { d1, sqlite } = createTestD1();
    const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
    const rows = () => sqlite.prepare("SELECT road_id, kind, status, previous_status FROM status_log WHERE road_id = 'a358-donyatt' ORDER BY id").all();

    // Inputs as they'd look at `min` minutes after NOW: fresh readings, and a fresh "care" report if asked.
    const snapshotAt = (min: number, care = false) => {
      const now = at(min);
      const levels = series(Array(32).fill(0.25)).map((r) => ({ ...r, ts: new Date(Date.parse(r.ts) + min * 60_000).toISOString() }));
      const reports: DriverReport[] = care ? [{ roadId: "a358-donyatt", kind: "care", createdAt: minsAgo(5, now) }] : [];
      return computeStatus(inputs({ now, levels, rain: [], warningsCheckedAt: minsAgo(5, now), reports }));
    };
    expect(await logStatus(d1, snapshotAt(0))).toBe(3);
    expect(await logStatus(d1, snapshotAt(15))).toBe(0);
    await logStatus(d1, snapshotAt(30, true));
    expect(await logStatus(d1, snapshotAt(45, true))).toBe(0);
    await logStatus(d1, snapshotAt(90, true));
    expect(rows()).toEqual([
      { road_id: "a358-donyatt", kind: "change", status: "open", previous_status: null },
      { road_id: "a358-donyatt", kind: "change", status: "caution", previous_status: "open" },
      { road_id: "a358-donyatt", kind: "hourly", status: "caution", previous_status: "caution" },
    ]);
    const snap = sqlite.prepare("SELECT level_m, warnings, report_counts, reasons FROM status_log WHERE kind = 'change' AND status = 'caution'").get() as Record<string, string>;
    expect(JSON.parse(snap.report_counts)).toEqual({ doNotAttempt: 0, care: 1, clear: 0 });
    expect(JSON.parse(snap.reasons)[0]).toMatch(/Passable with care/);
    expect(snap.level_m).toBe(0.25);
  });
});

// ---------------------------------------------------------------- API

describe("/api/config", () => {
  it("only exposes the site key when reports are fully set up", async () => {
    expect(await apiConfig({ TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "s" } as ReportsEnv).json()).toEqual({ reportsEnabled: true, turnstileSiteKey: "site" });
    expect(await apiConfig({ TURNSTILE_SITE_KEY: "site" } as ReportsEnv).json()).toEqual({ reportsEnabled: false, turnstileSiteKey: null });
  });
});

describe("POST /api/reports", () => {
  it("is switched off until both Turnstile keys exist", async () => {
    const { env, f } = await setup({ TURNSTILE_SECRET_KEY: undefined });
    expect((await postReport(post(good()), env, API_NOW, f.fn)).status).toBe(503);
  });

  it.each([
    [{ roadId: "m5" }, "Unknown road."],
    [{ kind: "flooded" }, "Unknown report type."],
    [{ token: "" }, "Missing spam check."],
    [{ deviceId: "x" }, "Missing device code."],
  ])("rejects bad input %j", async (over, error) => {
    const { env, f } = await setup();
    const res = await postReport(post(good(over)), env, API_NOW, f.fn);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
  });

  it("rejects a failed spam check and passes the visitor's address to Turnstile", async () => {
    const { env, f, sqlite } = await setup();
    const res = await postReport(post(good({ token: "bad-token-999" })), env, API_NOW, f.fn);
    expect(res.status).toBe(403);
    expect(f.turnstileCalls[0].get("remoteip")).toBe("203.0.113.7");
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM reports").get()).toEqual({ n: 0 });
  });

  it("stores the report anonymously with a snapshot, and counts it straight away", async () => {
    const { env, f, sqlite } = await setup();
    const res = await postReport(post(good()), env, API_NOW, f.fn);
    expect(res.status).toBe(201);
    const body = await res.json<{ road: { status: string; reasons: string[] } }>();
    expect(body.road.status).toBe("caution");
    expect(body.road.reasons).toContain('1 driver reported "Do not attempt" (latest just now).');

    const row = sqlite.prepare("SELECT * FROM reports").get() as Record<string, unknown>;
    expect(row).toMatchObject({ road_id: "a358-donyatt", kind: "do_not_attempt", status_shown: "open", level_m: expect.any(Number), hidden: 0 });
    // No raw identifiers are stored.
    expect(JSON.stringify(row)).not.toContain("203.0.113.7");
    expect(JSON.stringify(row)).not.toContain("device-aaaa-1111");
    expect(row.device_hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("allows one report per road per device every 10 minutes", async () => {
    const { env, f } = await setup();
    expect((await postReport(post(good()), env, API_NOW, f.fn)).status).toBe(201);
    expect((await postReport(post(good({ kind: "clear" })), env, new Date(API_NOW.getTime() + 5 * 60_000), f.fn)).status).toBe(429);
    // Another road is fine, and the same road after 10 minutes is fine.
    expect((await postReport(post(good({ roadId: "b3168-ilford-bridges" })), env, new Date(API_NOW.getTime() + 6 * 60_000), f.fn)).status).toBe(201);
    expect((await postReport(post(good()), env, new Date(API_NOW.getTime() + 11 * 60_000), f.fn)).status).toBe(201);
  });

  it("caps reports per device per day", async () => {
    const { env, f } = await setup();
    const roads = ["a358-donyatt", "b3168-ilford-bridges", "isle-brewers-fivehead"];
    for (let i = 0; i < LIMITS.perDevicePerDay; i++) {
      const at = new Date(API_NOW.getTime() + i * 11 * 60_000);
      expect((await postReport(post(good({ roadId: roads[i % 3] })), env, at, f.fn)).status).toBe(201);
    }
    const res = await postReport(post(good({ roadId: "a358-donyatt" })), env, new Date(API_NOW.getTime() + 3 * 3_600_000), f.fn);
    expect(res.status).toBe(429);
  });

  it("two drivers reporting 'Do not attempt' turns the road to Avoid", async () => {
    const { env, f, store } = await setup();
    await postReport(post(good()), env, API_NOW, f.fn);
    const res = await postReport(post(good({ deviceId: "device-bbbb-2222" }), "198.51.100.9"), env, new Date(API_NOW.getTime() + 60_000), f.fn);
    expect((await res.json<{ road: { status: string } }>()).road.status).toBe("avoid");
    expect(JSON.parse(store.get("status:v1")!).roads[0].status).toBe("avoid");
  });
});

describe("daily hashing key", () => {
  it("is stable within a day and different the next day", async () => {
    const { kv } = fakeKV();
    const a = await dailySalt(kv, new Date("2026-10-01T01:00:00Z"));
    expect(await dailySalt(kv, new Date("2026-10-01T23:00:00Z"))).toBe(a);
    expect(await dailySalt(kv, new Date("2026-10-02T00:01:00Z"))).not.toBe(a);
  });
});

describe("admin moderation", () => {
  const adminReq = (path: string, method = "GET", token = "admin-token-xyz") =>
    new Request(`https://donyatt.example${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: method === "POST" ? JSON.stringify({ reason: "test" }) : undefined });

  it("is hidden until ADMIN_TOKEN is set, and needs the right token", async () => {
    const off = await setup({ ADMIN_TOKEN: undefined });
    expect((await adminReports(adminReq("/api/admin/reports"), off.env, "/api/admin/reports")).status).toBe(404);
    const on = await setup();
    expect((await adminReports(adminReq("/api/admin/reports", "GET", "wrong"), on.env, "/api/admin/reports")).status).toBe(401);
  });

  it("lists reports and hides junk, which stops it counting", async () => {
    const { env, f, store } = await setup();
    await postReport(post(good()), env, API_NOW, f.fn);
    await postReport(post(good({ deviceId: "device-bbbb-2222" }), "198.51.100.9"), env, new Date(API_NOW.getTime() + 60_000), f.fn);
    const list = await (await adminReports(adminReq("/api/admin/reports"), env, "/api/admin/reports", API_NOW)).json<{ reports: { id: number }[] }>();
    expect(list.reports).toHaveLength(2);

    const path = `/api/admin/reports/${list.reports[0].id}/hide`;
    expect((await adminReports(adminReq(path, "POST"), env, path, new Date(API_NOW.getTime() + 2 * 60_000))).status).toBe(200);
    expect(JSON.parse(store.get("status:v1")!).roads[0].status).toBe("caution");
  });
});
