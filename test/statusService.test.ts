/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCollector } from "../src/collector";
import { DONYATT_LEVEL_MEASURE, SNOWDON_HILL_RAIN_MEASURE } from "../src/config";
import { apiStatus, type Env } from "../src/index";
import type { StatusReport } from "../src/status";
import { getStatus, loadStatusInputs, refreshStatus, STATUS_CACHE_KEY } from "../src/statusService";
import { createTestD1 } from "./d1-sqlite";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

function fakeFetch(floods = "floods-none-local.json") {
  let calls = 0;
  const fn = (async (input: RequestInfo | URL) => {
    calls++;
    const url = String(input);
    if (url.includes(DONYATT_LEVEL_MEASURE)) return new Response(fixture("donyatt-level-readings.json"));
    if (url.includes(SNOWDON_HILL_RAIN_MEASURE)) return new Response(fixture("snowdon-hill-rainfall-readings.json"));
    return new Response(fixture(floods));
  }) as typeof fetch;
  return { fn, count: () => calls };
}

function fakeKV() {
  const store = new Map<string, string>();
  const kv = {
    get: async (key: string, type?: string) => {
      const v = store.get(key);
      return v === undefined ? null : type === "json" ? JSON.parse(v) : v;
    },
    put: async (key: string, value: string) => void store.set(key, value),
  };
  return { kv: kv as unknown as KVNamespace, store };
}

// Latest reading in the saved fixtures is 2026-09-30T20:00:00Z.
const NOW = new Date("2026-09-30T20:20:00Z");

describe("loadStatusInputs", () => {
  it("loads recent readings and only the warnings from the latest successful check", async () => {
    const { d1 } = createTestD1();
    await runCollector(d1, new Date("2026-09-30T20:05:00Z"), fakeFetch("floods-synthetic-active.json").fn);
    await runCollector(d1, new Date("2026-09-30T20:15:00Z"), fakeFetch("floods-none-local.json").fn);

    const inputs = await loadStatusInputs(d1, NOW);
    expect(inputs.levels.at(-1)).toEqual({ ts: "2026-09-30T20:00:00Z", value: expect.any(Number) });
    expect(inputs.levels).toHaveLength(8);
    expect(inputs.rain).toHaveLength(8);
    // The warnings seen at 20:05 were gone by 20:15, so none are active.
    expect(inputs.warnings).toEqual([]);
    expect(inputs.warningsCheckedAt).toBe("2026-09-30T20:15:00.000Z");
  });

  it("returns active warnings, and keeps the old ones if the latest check failed", async () => {
    const { d1 } = createTestD1();
    await runCollector(d1, new Date("2026-09-30T20:05:00Z"), fakeFetch("floods-synthetic-active.json").fn);
    const failing = (async (input: RequestInfo | URL) =>
      String(input).endsWith("/id/floods") ? new Response("down", { status: 503 }) : fakeFetch().fn(input)) as typeof fetch;
    await runCollector(d1, new Date("2026-09-30T20:15:00Z"), failing);

    const inputs = await loadStatusInputs(d1, NOW);
    expect(inputs.warnings.map((w) => [w.floodAreaId, w.severityLevel])).toEqual([
      ["112FWFISL10A", 2],
      ["112WAFTSSR", 3],
    ]);
    expect(inputs.warningsCheckedAt).toBe("2026-09-30T20:05:00.000Z");
  });

  it("returns the last known level even when it is old", async () => {
    const { d1 } = createTestD1();
    await runCollector(d1, new Date("2026-09-30T20:05:00Z"), fakeFetch().fn);
    const inputs = await loadStatusInputs(d1, new Date("2026-10-02T12:00:00Z"));
    expect(inputs.levels).toEqual([{ ts: "2026-09-30T20:00:00Z", value: expect.any(Number) }]);
  });
});

describe("status caching", () => {
  it("refreshStatus stores the report in D1, not KV (KV's free plan allows only 1,000 writes a day)", async () => {
    const { d1, sqlite } = createTestD1();
    const { kv, store } = fakeKV();
    await runCollector(d1, new Date("2026-09-30T20:05:00Z"), fakeFetch().fn);
    const report = await refreshStatus(d1, kv, NOW);

    expect(report.roads.map((r) => r.status)).toEqual(["open"]);
    const row = sqlite.prepare("SELECT report FROM status_cache WHERE key = ?").get(STATUS_CACHE_KEY) as { report: string };
    expect(JSON.parse(row.report)).toEqual(report);
    expect(store.size).toBe(0);
  });

  it("refreshes that change nothing don't write to KV", async () => {
    const { d1 } = createTestD1();
    const { kv } = fakeKV();
    let puts = 0;
    const counting = { get: kv.get.bind(kv), put: async (k: string, v: string) => { puts++; return kv.put(k, v); } } as unknown as KVNamespace;
    await runCollector(d1, new Date("2026-09-30T20:05:00Z"), fakeFetch().fn);
    const sender = { token: "t", chatId: "@c", fetchFn: (async () => Response.json({ ok: true })) as unknown as typeof fetch };
    // 40 minutes of refreshes while nothing changes (before this fix: 2 KV writes every refresh).
    // (Any longer and the test's EA warnings check goes over an hour old, a real change to Caution.)
    for (let i = 0; i < 9; i++) await refreshStatus(d1, counting, new Date(NOW.getTime() + i * 5 * 60_000), sender);
    // Only the first run writes, recording the road and EA alert state.
    expect(puts).toBe(2);
  });

  it("getStatus serves a fresh cached report without calling the EA", async () => {
    const { d1, sqlite } = createTestD1();
    const { kv } = fakeKV();
    const cached = { generatedAt: NOW.toISOString(), roads: [] } as unknown as StatusReport;
    sqlite.prepare("INSERT INTO status_cache (key, generated_at, report) VALUES (?, ?, ?)").run(STATUS_CACHE_KEY, cached.generatedAt, JSON.stringify(cached));
    const f = fakeFetch();

    expect(await getStatus(d1, kv, NOW.getTime() + 5 * 60_000, f.fn)).toEqual(cached);
    expect(f.count()).toBe(0);
  });

  it("getStatus runs the collector and recomputes when the cache is stale", async () => {
    const { d1 } = createTestD1();
    const { kv } = fakeKV();
    const f = fakeFetch();
    const report = await getStatus(d1, kv, NOW.getTime() + 3 * 3_600_000, f.fn);

    // Level, rain and warnings from the EA, plus the Open-Meteo forecast.
    expect(f.count()).toBe(4);
    expect(report.generatedAt).toBe(new Date(NOW.getTime() + 3 * 3_600_000).toISOString());
    // The fixture readings are now over 3 h old: stale data is never "open".
    expect(report.roads.map((r) => r.status)).toEqual(["unknown"]);
  });
});

describe("/api/status", () => {
  it("returns the report with a short public cache", async () => {
    const { d1 } = createTestD1();
    const { kv } = fakeKV();
    await runCollector(d1, new Date("2026-09-30T20:05:00Z"), fakeFetch().fn);
    await refreshStatus(d1, kv, NOW);
    const res = await apiStatus({ DB: d1, STATUS: kv } as Env, NOW.getTime() + 60_000, fakeFetch().fn);

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const body = await res.json<StatusReport>();
    expect(body.roads).toHaveLength(1);
    expect(body.advice).toMatch(/Never drive into floodwater/);
  });

  it("fails closed with floodwater advice when the database is unavailable", async () => {
    const { kv } = fakeKV();
    const broken = { prepare: () => { throw new Error("D1 down"); } } as unknown as D1Database;
    const res = await apiStatus({ DB: broken, STATUS: kv } as Env, NOW.getTime(), fakeFetch().fn);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Status is unavailable right now. Never drive into floodwater." });
  });
});
