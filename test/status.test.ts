import { describe, expect, it } from "vitest";
import { computeStatus, risePerHour, type ActiveWarning, type StatusInputs, type TimedValue } from "../src/status";

const NOW = new Date("2026-12-01T12:00:00Z");

/** 15-minute readings, oldest first, the last one `lagMin` minutes before NOW. */
function series(values: number[], lagMin = 20): TimedValue[] {
  const end = NOW.getTime() - lagMin * 60_000;
  return values.map((value, i) => ({
    ts: new Date(end - (values.length - 1 - i) * 15 * 60_000).toISOString().replace(".000Z", "Z"),
    value,
  }));
}
const flat = (level: number, n = 32) => series(Array(n).fill(level));
const dryRain = series(Array(48).fill(0));

function inputs(over: Partial<StatusInputs> = {}): StatusInputs {
  return {
    now: NOW,
    levels: flat(0.25),
    rain: dryRain,
    warnings: [],
    warningsCheckedAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
    ...over,
  };
}
const statuses = (i: StatusInputs) => Object.fromEntries(computeStatus(i).roads.map((r) => [r.id, r.status]));
const a358 = (i: StatusInputs) => computeStatus(i).roads.find((r) => r.id === "a358-donyatt")!;

const warning = (severityLevel: number, floodAreaId = "112FWFISL10A"): ActiveWarning => ({
  floodAreaId,
  severityLevel,
  severity: { 1: "Severe flood warning", 2: "Flood warning", 3: "Flood alert", 4: "Warning no longer in force" }[severityLevel]!,
  message: null,
  timeRaised: "2026-12-01T09:00:00",
});

describe("computeStatus", () => {
  it("is Open in normal conditions, and never says 'safe'", () => {
    const report = computeStatus(inputs());
    expect(statuses(inputs())).toEqual({ "a358-donyatt": "open" });
    expect(JSON.stringify(report).toLowerCase()).not.toContain("safe");
    expect(report.advice).toMatch(/Never drive into floodwater/);
    expect(report.dataProblems).toEqual([]);
  });

  it.each([
    [1.19, "open"],
    [1.2, "caution"],
    [1.79, "caution"],
    [1.8, "avoid"],
    [2.4, "avoid"],
  ])("level %s m (steady) is %s", (level, expected) => {
    expect(a358(inputs({ levels: flat(level) })).status).toBe(expected);
  });

  it("is Caution when at 1.0 m or more and rising at 0.10 m/h or faster", () => {
    // 1.00 -> 1.10 over the last hour.
    expect(a358(inputs({ levels: series([0.9, 0.95, 0.975, 1.0, 1.025, 1.05, 1.075, 1.1]) })).status).toBe("caution");
    // Rising slowly (0.04 m/h) at 1.1 m is still Open.
    expect(a358(inputs({ levels: series([1.02, 1.04, 1.05, 1.06, 1.07, 1.08, 1.09, 1.1]) })).status).toBe("open");
  });

  it("is Avoid early when high and rising fast enough to reach 1.80 m within about an hour", () => {
    // 1.35 -> 1.55 in the last hour (0.2 m/h). Reading 20 min old: 1.55 + 0.2 * 1.33 = 1.82.
    const r = a358(inputs({ levels: series([1.3, 1.33, 1.35, 1.4, 1.45, 1.5, 1.55]) }));
    expect(r.status).toBe("avoid");
    expect(r.reasons[0]).toMatch(/likely to reach road-flooding level/);
    // Same level but rising slowly: Caution only.
    expect(a358(inputs({ levels: series([1.5, 1.51, 1.52, 1.53, 1.54, 1.55]) })).status).toBe("caution");
  });

  it("holds Avoid for an hour after the peak, then eases", () => {
    // 1.9 m 50 min ago, now 1.5 m and falling: still Avoid.
    expect(a358(inputs({ levels: series([1.9, 1.6, 1.5]) })).status).toBe("avoid");
    // Peaked at 1.9 m two hours ago, now 1.5 m: Caution (above normal), no longer Avoid.
    expect(a358(inputs({ levels: series([1.9, 1.9, 1.85, 1.8, 1.75, 1.7, 1.65, 1.6, 1.5]) })).status).toBe("caution");
    // Above 1.2 m four hours ago, normal since: Open.
    expect(a358(inputs({ levels: series([1.3, ...Array(16).fill(0.9)]) })).status).toBe("open");
  });

  it("an EA flood warning means Avoid for every road, whatever the gauge says", () => {
    const i = inputs({ warnings: [warning(2)] });
    expect(new Set(Object.values(statuses(i)))).toEqual(new Set(["avoid"]));
    expect(a358(i).reasons[0]).toBe("EA flood warning in force: River Isle from Chard Reservoir to Hambridge.");
  });

  it("a flood alert means Caution; a warning no longer in force is ignored", () => {
    expect(a358(inputs({ warnings: [warning(3, "112WAFTSSR")] })).status).toBe("caution");
    expect(a358(inputs({ warnings: [warning(4)] })).status).toBe("open");
  });

  it("ignores warnings for areas we don't watch", () => {
    expect(a358(inputs({ warnings: [warning(2, "112WATAVN1")] })).status).toBe("open");
  });

  it("heavy upstream rain means Caution", () => {
    const rain = series([...Array(40).fill(0), 3, 3, 3, 3, 3, 3, 3, 0]); // 21 mm in the last 2 h
    const r = a358(inputs({ rain }));
    expect(r.status).toBe("caution");
    expect(r.reasons[0]).toMatch(/21\.0 mm in the last 3 h/);
    const soaking = series(Array(48).fill(0.8)); // 38.4 mm over 12 h, never 20 mm in 3 h
    expect(a358(inputs({ rain: soaking })).status).toBe("caution");
  });

  it("never shows Open when the river data is stale", () => {
    const stale = series(Array(8).fill(0.25), 120);
    const report = computeStatus(inputs({ levels: stale }));
    expect(new Set(report.roads.map((r) => r.status))).toEqual(new Set(["unknown"]));
    expect(report.roads[0].reasons[0]).toMatch(/hasn't published a new Donyatt river reading since \d\d:\d\d \(120 minutes ago\)/);
    expect(computeStatus(inputs({ levels: [] })).roads[0].status).toBe("unknown");
  });

  it("stale river data plus an EA warning is still Avoid", () => {
    expect(a358(inputs({ levels: [], warnings: [warning(1)] })).status).toBe("avoid");
  });

  it("never shows Open when EA warnings couldn't be checked", () => {
    for (const warningsCheckedAt of [null, new Date(NOW.getTime() - 90 * 60_000).toISOString()]) {
      const r = a358(inputs({ warningsCheckedAt }));
      expect(r.status).toBe("caution");
      expect(r.reasons).toContain("EA flood warnings couldn't be checked recently.");
    }
  });

  it("missing rain data is reported but doesn't block an Open status", () => {
    const report = computeStatus(inputs({ rain: [] }));
    expect(report.roads[0].status).toBe("open");
    expect(report.dataProblems).toEqual(["Upstream rainfall at Chard isn't available right now."]);
  });

  it("summarises the river trend", () => {
    const report = computeStatus(inputs({ levels: series([1.0, 1.05, 1.1, 1.15, 1.2]) }));
    expect(report.river).toMatchObject({ levelM: 1.2, ageMinutes: 20, risePerHourM: 0.2, trend: "rising" });
  });
});

describe("risePerHour", () => {
  it("uses the reading nearest 1 h before the latest", () => {
    expect(risePerHour(series([1.0, 1.1, 1.2, 1.3, 1.4]))).toBeCloseTo(0.4);
  });
  it("returns null without a reading 45-90 min earlier", () => {
    expect(risePerHour(series([1.0, 1.1]))).toBeNull();
    expect(risePerHour([])).toBeNull();
  });
});

describe("reasons", () => {
  it("doesn't repeat the river level as both an Avoid and a Caution reason", () => {
    const r = a358(inputs({ levels: flat(1.9) }));
    expect(r.reasons).toEqual(["The River Isle at Donyatt is at 1.90 m. Roads have flooded from 1.80 m."]);
  });
});
