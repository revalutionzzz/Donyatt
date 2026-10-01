/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fillHistory, runCollector } from "../src/collector";
import { DONYATT_LEVEL_MEASURE, SNOWDON_HILL_RAIN_MEASURE } from "../src/config";
import { loadHistory } from "../src/history";
import { apiHistory, type Env } from "../src/index";
import { createTestD1 } from "./d1-sqlite";

const NOW = new Date("2026-10-01T09:05:00Z");
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

/** EA-shaped readings every 15 min between two times, newest first (as the EA returns them). */
function eaReadings(fromMs: number, toMs: number, value: (i: number) => number) {
  const items = [];
  for (let t = fromMs, i = 0; t <= toMs; t += 15 * 60_000, i++) items.push({ dateTime: iso(t), value: value(i) });
  return { items: items.reverse() };
}

/** Fake EA: the latest-readings call returns the last 24 h, the range call returns the older days. */
function fakeEa() {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const end = NOW.getTime() - 5 * 60_000;
    const isRain = url.includes(SNOWDON_HILL_RAIN_MEASURE);
    const v = (i: number) => (isRain ? (i % 8 === 0 ? 0.4 : 0) : 0.2 + (i % 4) * 0.01);
    if (url.includes("startdate=")) return Response.json(eaReadings(end - 8 * 86_400_000, end - 86_400_000, v));
    if (url.includes(DONYATT_LEVEL_MEASURE) || isRain) return Response.json(eaReadings(end - 86_400_000, end, v));
    return Response.json({ items: [] });
  }) as typeof fetch;
  return { fn, calls };
}

describe("fillHistory", () => {
  it("tops up both measures to 7 days, then does nothing", async () => {
    const { d1, sqlite } = createTestD1();
    const ea = fakeEa();
    await runCollector(d1, NOW, ea.fn);
    const before = (sqlite.prepare("SELECT COUNT(*) AS n FROM readings").get() as { n: number }).n;

    const inserted = await fillHistory(d1, NOW, ea.fn);
    expect(inserted).toBeGreaterThan(2 * 6 * 96 - 10);
    const rangeCalls = ea.calls.filter((u) => u.includes("startdate="));
    expect(rangeCalls).toHaveLength(2);
    expect(rangeCalls[0]).toContain("startdate=2026-09-24&enddate=2026-09-30");
    // Nothing older than 7 days is stored.
    const oldest = sqlite.prepare("SELECT MIN(ts) AS ts FROM readings").get() as { ts: string };
    expect(oldest.ts >= "2026-09-24T09:05").toBe(true);
    expect(before).toBeLessThan(before + inserted);

    expect(await fillHistory(d1, NOW, ea.fn)).toBe(0);
    expect(ea.calls.filter((u) => u.includes("startdate="))).toHaveLength(2);
  });

  it("skips measures with no readings yet", async () => {
    const { d1 } = createTestD1();
    const ea = fakeEa();
    expect(await fillHistory(d1, NOW, ea.fn)).toBe(0);
    expect(ea.calls).toEqual([]);
  });
});

describe("loadHistory", () => {
  it("returns level readings and hourly rain for the range", async () => {
    const { d1 } = createTestD1();
    await runCollector(d1, NOW, fakeEa().fn);
    const h = await loadHistory(d1, 1, NOW);

    expect(h.from).toBe("2026-09-30T09:05:00Z");
    expect(h.level.length).toBeGreaterThan(90);
    expect(h.level[0][0] >= h.from).toBe(true);
    // 15-minute rain summed into hours: one 0.4 mm tip every 2 hours in the fake data.
    expect(h.rainHourly.every(([hour]) => hour.endsWith(":00:00Z"))).toBe(true);
    expect(h.rainHourly.reduce((s, [, mm]) => s + mm, 0)).toBeCloseTo(0.4 * 12, 1);
  });

  it("falls back to 2 days for an unsupported range", async () => {
    const { d1 } = createTestD1();
    expect((await loadHistory(d1, 30, NOW)).from).toBe("2026-09-29T09:05:00Z");
  });
});

describe("/api/history", () => {
  it("tops up short history once, then serves it with a 5-minute cache", async () => {
    const { d1 } = createTestD1();
    const ea = fakeEa();
    await runCollector(d1, NOW, ea.fn);
    const res = await apiHistory({ DB: d1 } as Env, 7, NOW.getTime(), ea.fn);

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const body = await res.json<{ level: [string, number][] }>();
    expect(body.level[0][0] < "2026-09-25").toBe(true);
  });

  it("fetches a forecast itself when there's no fresh one, so the chart doesn't depend on the cron", async () => {
    const { d1 } = createTestD1();
    const forecast = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "open-meteo-forecast-synthetic.json"), "utf8"));
    const now = new Date("2026-09-30T20:30:00Z");
    const fn = (async () => Response.json(forecast)) as unknown as typeof fetch;
    const body = await (await apiHistory({ DB: d1 } as Env, 1, now.getTime(), fn)).json<{ rainForecast: [string, number][]; forecastFetchedAt: string }>();
    expect(body.forecastFetchedAt).toBe(now.toISOString());
    expect(body.rainForecast.length).toBeGreaterThan(0);
  });
});
