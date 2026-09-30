/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCollector } from "../src/collector";
import { DONYATT_LEVEL_MEASURE, SNOWDON_HILL_RAIN_MEASURE, WATCHED_FLOOD_AREAS } from "../src/config";
import { parseFloods, parseReadings } from "../src/ea";
import { createTestD1 } from "./d1-sqlite";

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));
const level = fixture("donyatt-level-readings.json");
const rain = fixture("snowdon-hill-rainfall-readings.json");
const floodsNone = fixture("floods-none-local.json");
const floodsActive = fixture("floods-synthetic-active.json");

const NOW = new Date("2026-09-30T20:10:00Z");

/** Fake fetch that serves fixtures by URL and records what was requested. */
function fakeFetch(routes: { level?: unknown; rain?: unknown; floods?: unknown; floodsStatus?: number }) {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.includes(DONYATT_LEVEL_MEASURE)) return respond(routes.level ?? level);
    if (url.includes(SNOWDON_HILL_RAIN_MEASURE)) return respond(routes.rain ?? rain);
    if (url.endsWith("/id/floods")) return respond(routes.floods ?? floodsNone, routes.floodsStatus ?? 200);
    return respond({ error: "unexpected url" }, 404);
  }) as typeof fetch;
  return { fn, calls };
}

describe("EA parsing (real saved responses)", () => {
  it("parses Donyatt level readings", () => {
    const { readings, skipped } = parseReadings(level);
    expect(skipped).toBe(0);
    expect(readings).toHaveLength(8);
    expect(readings[0]).toEqual({ ts: "2026-09-30T20:00:00Z", value: expect.any(Number) });
    // Live stage readings are on the threshold scale (metres), not metres above sea level.
    for (const r of readings) expect(r.value).toBeLessThan(4);
  });

  it("parses Snowdon Hill rainfall readings", () => {
    expect(parseReadings(rain).readings).toHaveLength(8);
  });

  it("skips readings whose value is not a single number", () => {
    const body = { items: [{ dateTime: "2026-01-01T00:00:00Z", value: [0.2, 0.3] }, { dateTime: "2026-01-01T00:15:00Z", value: 0.4 }] };
    expect(parseReadings(body)).toEqual({ readings: [{ ts: "2026-01-01T00:15:00Z", value: 0.4 }], skipped: 1 });
  });

  it("rejects a response with no items array", () => {
    expect(() => parseReadings({ error: "x" })).toThrow();
    expect(() => parseFloods({}, WATCHED_FLOOD_AREAS)).toThrow();
  });

  it("ignores warnings for other areas", () => {
    expect(parseFloods(floodsNone, WATCHED_FLOOD_AREAS)).toEqual([]);
    const active = parseFloods(floodsActive, WATCHED_FLOOD_AREAS);
    expect(active.map((w) => [w.floodAreaId, w.severityLevel])).toEqual([
      ["112FWFISL10A", 2],
      ["112WAFTSSR", 3],
    ]);
  });
});

describe("runCollector", () => {
  it("stores readings and records a successful run", async () => {
    const { d1, sqlite } = createTestD1();
    const { fn, calls } = fakeFetch({});
    const result = await runCollector(d1, NOW, fn);

    expect(result).toMatchObject({ levelOk: true, rainOk: true, warningsOk: true, readingsInserted: 16, warningsSeen: 0, errors: [] });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM readings").get()).toEqual({ n: 16 });
    // First run looks back 24 hours.
    expect(calls[0]).toContain(`since=${encodeURIComponent("2026-09-29T20:10:00.000Z")}`);
    const run = sqlite.prepare("SELECT * FROM collector_runs").get() as Record<string, unknown>;
    expect(run).toMatchObject({ level_ok: 1, rain_ok: 1, warnings_ok: 1, readings_inserted: 16, errors: null });
  });

  it("is idempotent and fetches only since the latest stored reading", async () => {
    const { d1, sqlite } = createTestD1();
    await runCollector(d1, NOW, fakeFetch({}).fn);
    const { fn, calls } = fakeFetch({});
    const second = await runCollector(d1, new Date("2026-09-30T20:25:00Z"), fn);

    expect(second.readingsInserted).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM readings").get()).toEqual({ n: 16 });
    expect(calls[0]).toContain(`since=${encodeURIComponent("2026-09-30T20:00:00Z")}`);
  });

  it("records active warnings for watched areas and refreshes last_seen_at", async () => {
    const { d1, sqlite } = createTestD1();
    await runCollector(d1, NOW, fakeFetch({ floods: floodsActive }).fn);
    const later = new Date("2026-09-30T20:25:00Z");
    const result = await runCollector(d1, later, fakeFetch({ floods: floodsActive }).fn);

    expect(result.warningsSeen).toBe(2);
    const rows = sqlite
      .prepare("SELECT flood_area_id, severity_level, first_seen_at, last_seen_at FROM flood_warnings ORDER BY flood_area_id")
      .all();
    expect(rows).toEqual([
      { flood_area_id: "112FWFISL10A", severity_level: 2, first_seen_at: NOW.toISOString(), last_seen_at: later.toISOString() },
      { flood_area_id: "112WAFTSSR", severity_level: 3, first_seen_at: NOW.toISOString(), last_seen_at: later.toISOString() },
    ]);
  });

  it("keeps collecting other sources when one fails, and records the failure", async () => {
    const { d1, sqlite } = createTestD1();
    const result = await runCollector(d1, NOW, fakeFetch({ floodsStatus: 503 }).fn);

    expect(result).toMatchObject({ levelOk: true, rainOk: true, warningsOk: false, readingsInserted: 16 });
    expect(result.errors[0]).toMatch(/^warnings: EA 503/);
    const run = sqlite.prepare("SELECT warnings_ok, errors FROM collector_runs").get() as Record<string, unknown>;
    expect(run.warnings_ok).toBe(0);
    expect(run.errors).toMatch(/EA 503/);
  });

  it("records a failed level fetch without storing anything for it", async () => {
    const { d1, sqlite } = createTestD1();
    const result = await runCollector(d1, NOW, fakeFetch({ level: { unexpected: true } }).fn);

    expect(result.levelOk).toBe(false);
    expect(result.rainOk).toBe(true);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM readings WHERE measure_id = ?").get(DONYATT_LEVEL_MEASURE)).toEqual({ n: 0 });
  });
});

describe("wrangler.toml safety rules", () => {
  const toml = readFileSync(join(import.meta.dirname, "..", "wrangler.toml"), "utf8");
  const config = toml.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

  it("has no routes or custom domains", () => {
    expect(config).not.toMatch(/^\s*routes?\s*=/m);
    expect(config).not.toMatch(/^\s*\[\[?routes?\]?\]/m);
    expect(config).not.toMatch(/custom_domain/);
  });

  it("only uses donyatt- prefixed names", () => {
    expect(config).toMatch(/^name = "donyatt-flood-watch"$/m);
    for (const [, name] of config.matchAll(/(?:database_name|bucket_name)\s*=\s*"([^"]+)"/g)) {
      expect(name).toMatch(/^donyatt-/);
    }
  });
});
