/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectForecast, forecastTotal, latestForecast, parseForecast, type StoredForecast } from "../src/forecast";
import { BANDS, computeFeatures, MODEL_FOR_TESTS, predictOutlook, probability, type FeatureName, type Features } from "../src/predict";
import { computeStatus, type TimedValue } from "../src/status";
import { createTestD1 } from "./d1-sqlite";

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));
const parity: { features: Record<FeatureName, number>; expected: Record<string, number> }[] = fixture("model-parity.json");
const forecastJson = fixture("open-meteo-forecast-synthetic.json");

const NOW = new Date("2026-12-01T12:20:00Z");
const T = Date.parse("2026-12-01T12:00:00Z"); // latest reading time (20 min old)
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

/** Level and rain series (15-min, oldest first) that reproduce the given model features at T. */
function seriesFor(f: Record<FeatureName, number>) {
  const levels: TimedValue[] = [];
  for (let i = 32; i >= 0; i--) {
    const t = T - i * 900_000;
    // Piecewise linear through t-3h, t-1h and t.
    const at3 = f.level - f.rise_3h;
    const at1 = f.level - f.rise_1h;
    const v = i >= 12 ? at3 : i >= 4 ? at3 + ((at1 - at3) * (12 - i)) / 8 : at1 + ((f.level - at1) * (4 - i)) / 4;
    levels.push({ ts: iso(t), value: v });
  }
  // Rain totals for nested windows, spread evenly within each band.
  const totals = [1, 3, 6, 24, 72].map((h) => [h, Math.expm1(f[`rain_${h}h` as FeatureName])] as const);
  const perReading = new Map<number, number>();
  let prevH = 0;
  let prevTotal = 0;
  for (const [h, total] of totals) {
    const n = (h - prevH) * 4;
    const band = Math.max(0, total - prevTotal);
    for (let k = prevH * 4; k < h * 4; k++) perReading.set(k, band / n);
    prevH = h;
    prevTotal = Math.max(prevTotal, total);
  }
  const rain: TimedValue[] = [];
  for (let k = 72 * 4 - 1; k >= 0; k--) rain.push({ ts: iso(T - k * 900_000), value: perReading.get(k) ?? 0 });
  return { levels, rain };
}

describe("model parity with Python", () => {
  it("reproduces the trained probabilities exactly", () => {
    for (const sample of parity) {
      for (const variant of ["nowcast", "forecast"] as const) {
        const m = MODEL_FOR_TESTS[variant];
        for (const h of ["3", "6"] as const) {
          expect(probability(m.horizons[h], m.features, sample.features)).toBeCloseTo(sample.expected[`${variant}_${h}h`], 10);
        }
      }
    }
  });
});

describe("computeFeatures", () => {
  it("rebuilds the training features from raw readings", () => {
    const sample = parity[0].features;
    const { levels, rain } = seriesFor(sample);
    const got = computeFeatures(levels, rain, null, NOW)!;
    for (const name of MODEL_FOR_TESTS.nowcast.features) expect(got.features[name]).toBeCloseTo(sample[name], 6);
    expect(got.features.fc_rain_6h).toBeUndefined();
    expect(got.asOf).toBe(iso(T));
  });

  it("refuses to predict with gaps in the rain record (it would understate the risk)", () => {
    const { levels, rain } = seriesFor(parity[0].features);
    expect(computeFeatures(levels, rain.filter((_, i) => i % 10 !== 0), null, NOW)).toBeNull();
    expect(computeFeatures(levels, rain.slice(-200), null, NOW)).toBeNull();
  });

  it("predicts as of the latest time both feeds have reported, when rain lags the river", () => {
    const { levels, rain } = seriesFor(parity[0].features);
    const extra = { ts: iso(T + 900_000), value: levels.at(-1)!.value + 0.05 };
    const got = computeFeatures([...levels, extra], rain, null, NOW)!;
    expect(got.asOf).toBe(iso(T));
    expect(got.features.level).toBeCloseTo(parity[0].features.level, 6);
    // Rain more than an hour behind: no outlook.
    expect(computeFeatures(levels, rain.slice(0, -6), null, NOW)).toBeNull();
  });

  it("needs readings near 1 h and 3 h ago", () => {
    const { levels, rain } = seriesFor(parity[0].features);
    expect(computeFeatures(levels.slice(-6), rain, null, NOW)).toBeNull();
  });

  it("uses a fresh forecast covering the next 6 h, and ignores stale or short ones", () => {
    const { levels, rain } = seriesFor(parity[0].features);
    const hours = Array.from({ length: 12 }, (_, i) => ({ hourEnd: iso(T + (i + 1) * 3_600_000), mm: 2 }));
    const fresh: StoredForecast = { fetchedAt: iso(NOW.getTime() - 30 * 60_000), hours };
    expect(computeFeatures(levels, rain, fresh, NOW)!.forecastRain6hMm).toBeCloseTo(12);
    expect(computeFeatures(levels, rain, { ...fresh, fetchedAt: iso(NOW.getTime() - 4 * 3_600_000) }, NOW)!.forecastRain6hMm).toBeNull();
    expect(computeFeatures(levels, rain, { ...fresh, hours: hours.slice(0, 4) }, NOW)!.forecastRain6hMm).toBeNull();
  });
});

describe("predictOutlook", () => {
  // River at 1.0 m and rising after heavy rain (60-70 mm over 3 days): about 48% within 6 h.
  const L = Math.log1p;
  const risky = {
    features: { level: 1.0, rise_1h: 0.12, rise_3h: 0.3, rain_1h: L(5), rain_3h: L(14), rain_6h: L(20), rain_24h: L(40), rain_72h: L(70), fc_rain_6h: 0 },
  };

  it("matches the parity probabilities end to end, and 6 h is never below 3 h", () => {
    for (const sample of parity) {
      const { levels, rain } = seriesFor(sample.features);
      const o = predictOutlook(levels, rain, null, NOW)!;
      expect(o.variant).toBe("nowcast");
      expect(o.p3h).toBeCloseTo(sample.expected.nowcast_3h, 4);
      expect(o.p6h).toBeCloseTo(Math.max(sample.expected.nowcast_6h, sample.expected.nowcast_3h), 4);
      expect(o.p6h).toBeGreaterThanOrEqual(o.p3h);
    }
  });

  it("is Low when the river is low and it's been dry", () => {
    const quiet = { level: 0.25, rise_1h: 0, rise_3h: 0, rain_1h: 0, rain_3h: 0, rain_6h: 0, rain_24h: 0, rain_72h: 0, fc_rain_6h: 0 };
    const { levels, rain } = seriesFor(quiet);
    const o = predictOutlook(levels, rain, null, NOW)!;
    expect(o.band).toBe("low");
    expect(o.p6h).toBeLessThan(0.001);
  });

  describe("in the road status", () => {
    it("an Elevated or High outlook raises roads to Caution, with the chance in the reasons", () => {
      const { levels, rain } = seriesFor(risky.features);
      expect(predictOutlook(levels, rain, null, NOW)!.p6h).toBeGreaterThanOrEqual(BANDS.elevated);
      const report = computeStatus({ now: NOW, levels, rain, warnings: [], warningsCheckedAt: iso(NOW.getTime() - 5 * 60_000) });
      expect(report.outlook?.band).not.toBe("low");
      for (const road of report.roads) {
        expect(["caution", "avoid"]).toContain(road.status);
        expect(road.reasons.some((r) => r.startsWith("Flood outlook:"))).toBe(true);
      }
    });

    it("never sets Avoid on its own", () => {
      // Strong outlook but a low, steady river: the only trigger is the model.
      const f: Features = { ...risky.features, level: 0.9, rise_1h: 0.01, rise_3h: 0.02 };
      const { levels, rain } = seriesFor(f as Record<FeatureName, number>);
      const report = computeStatus({ now: NOW, levels, rain, warnings: [], warningsCheckedAt: iso(NOW.getTime() - 5 * 60_000) });
      if (report.outlook && report.outlook.band !== "low") {
        expect(report.roads.map((r) => r.status)).toEqual(["caution", "caution", "caution"]);
      }
      expect(report.roads.some((r) => r.status === "avoid")).toBe(false);
    });

    it("gives no outlook when the river data is stale", () => {
      const { levels, rain } = seriesFor(risky.features);
      const report = computeStatus({ now: new Date(T + 3 * 3_600_000), levels, rain, warnings: [], warningsCheckedAt: iso(T) });
      expect(report.outlook).toBeNull();
    });
  });
});

describe("Open-Meteo forecast", () => {
  it("parses hourly precipitation, skipping nulls and marking times as UTC", () => {
    const hours = parseForecast(forecastJson);
    expect(hours).toHaveLength(11);
    expect(hours[0]).toEqual({ hourEnd: "2026-09-30T21:00:00Z", mm: 0 });
    expect(hours.find((h) => h.hourEnd === "2026-10-01T01:00:00Z")!.mm).toBe(4.6);
    expect(() => parseForecast({ error: true, reason: "bad" })).toThrow();
  });

  it("totals the next N hours, counting a partial first hour pro rata", () => {
    const hours = [
      { hourEnd: "2026-12-01T13:00:00Z", mm: 4 },
      { hourEnd: "2026-12-01T14:00:00Z", mm: 2 },
    ];
    // From 12:30: half of the first hour (2 mm) plus the second (2 mm).
    expect(forecastTotal(hours, new Date("2026-12-01T12:30:00Z"), 6)).toBeCloseTo(4);
  });

  it("stores each fetch, refreshes at most hourly, and returns the latest future hours", async () => {
    const { d1 } = createTestD1();
    let calls = 0;
    const fetchFn = (async (url: RequestInfo | URL) => {
      calls++;
      expect(String(url)).toContain("api.open-meteo.com/v1/forecast?latitude=50.8759&longitude=-2.9814&hourly=precipitation");
      return Response.json(forecastJson);
    }) as typeof fetch;
    const t0 = new Date("2026-09-30T22:30:00Z");
    expect(await collectForecast(d1, t0, fetchFn)).toBe(11);
    expect(await collectForecast(d1, new Date(t0.getTime() + 30 * 60_000), fetchFn)).toBe(0);
    expect(calls).toBe(1);
    expect(await collectForecast(d1, new Date(t0.getTime() + 60 * 60_000), fetchFn)).toBe(11);
    expect(calls).toBe(2);

    const latest = await latestForecast(d1, t0);
    expect(latest!.fetchedAt).toBe(new Date(t0.getTime() + 60 * 60_000).toISOString());
    // Includes the 2 h before now, for an outlook anchored up to an hour back.
    expect(latest!.hours[0].hourEnd).toBe("2026-09-30T21:00:00Z");
  });
});
