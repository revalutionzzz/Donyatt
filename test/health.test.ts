/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DONYATT_LEVEL_MEASURE, SNOWDON_HILL_RAIN_MEASURE } from "../src/config";
import { health, type Env } from "../src/index";
import { createTestD1 } from "./d1-sqlite";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

function fakeFetch() {
  let calls = 0;
  const fn = (async (input: RequestInfo | URL) => {
    calls++;
    const url = String(input);
    if (url.includes(DONYATT_LEVEL_MEASURE)) return new Response(fixture("donyatt-level-readings.json"));
    if (url.includes(SNOWDON_HILL_RAIN_MEASURE)) return new Response(fixture("snowdon-hill-rainfall-readings.json"));
    return new Response(fixture("floods-none-local.json"));
  }) as typeof fetch;
  return { fn, count: () => calls };
}

const env = (d1: D1Database) => ({ DB: d1 }) as unknown as Env;
// Each test uses a time far from the others so the per-isolate throttle doesn't carry over.
let clock = Date.parse("2026-10-01T00:00:00Z");
const nextTime = () => (clock += 60 * 60 * 1000);

describe("/health", () => {
  it("runs the collector itself when there has never been a run", async () => {
    const { d1 } = createTestD1();
    const f = fakeFetch();
    const body = await (await health(env(d1), nextTime(), f.fn)).json<Record<string, any>>();

    // Level, rain and warnings from the EA, plus the Open-Meteo forecast.
    expect(f.count()).toBe(4);
    expect(body.cronLooksHealthy).toBe(false);
    expect(body.fallbackRun).toMatchObject({ levelOk: true, rainOk: true, warningsOk: true, readingsInserted: 16 });
    expect(body.donyattLevelM).toEqual({ ts: "2026-09-30T20:00:00Z", value: expect.any(Number) });
    expect(body.lastRun).not.toBeNull();
  });

  it("does not run the collector when the cron ran recently", async () => {
    const { d1 } = createTestD1();
    const t = nextTime();
    await health(env(d1), t, fakeFetch().fn); // creates a run at t
    const f = fakeFetch();
    const body = await (await health(env(d1), t + 5 * 60 * 1000, f.fn)).json<Record<string, any>>();

    expect(f.count()).toBe(0);
    expect(body.cronLooksHealthy).toBe(true);
    expect(body.fallbackRun).toBeUndefined();
  });

  it("throttles fallback runs to one a minute", async () => {
    const { d1 } = createTestD1();
    const t = nextTime();
    const first = fakeFetch();
    await health(env(d1), t, first.fn);
    // Stale again (pretend the run is old) but within the throttle window.
    const { d1: empty } = createTestD1();
    const second = fakeFetch();
    const body = await (await health(env(empty), t + 30 * 1000, second.fn)).json<Record<string, any>>();

    expect(first.count()).toBe(4);
    expect(second.count()).toBe(0);
    expect(body.cronLooksHealthy).toBe(false);
  });

  it("reports a database failure instead of throwing", async () => {
    const broken = { prepare: () => { throw new Error("no such table: readings"); } } as unknown as D1Database;
    const res = await health(env(broken), nextTime(), fakeFetch().fn);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Database query failed: no such table: readings" });
  });
});
