import { WATCHED_FLOOD_AREAS } from "./config";
import { describeReports, summariseReports, type DriverReport, type ReportSummary } from "./reports";
import {
  EA_SEVERITY,
  HEAVY_RAIN,
  LEVEL,
  LEVEL_STALE_MIN,
  PROJECTED_AVOID,
  RAIN_STALE_MIN,
  REPORTS,
  RISE_WINDOW_MIN,
  RISING,
  ROADS,
  WARNINGS_STALE_MIN,
  type Road,
} from "./rules";

export type RoadStatus = "open" | "caution" | "avoid" | "unknown";

export interface TimedValue {
  ts: string;
  value: number;
}

export interface ActiveWarning {
  floodAreaId: string;
  severityLevel: number;
  severity: string;
  message: string | null;
  timeRaised: string | null;
}

export interface StatusInputs {
  now: Date;
  /** Donyatt level readings, oldest first, covering at least the longest hold window. */
  levels: TimedValue[];
  /** Snowdon Hill rain readings (mm per 15 min), oldest first, covering at least 12 h. */
  rain: TimedValue[];
  /** Warnings present in the latest successful EA check (any severity). */
  warnings: ActiveWarning[];
  /** When warnings were last checked successfully (null = never). */
  warningsCheckedAt: string | null;
  /** Recent driver reports (moderated-out ones excluded). */
  reports?: DriverReport[];
}

export interface RoadReport {
  id: string;
  name: string;
  where: string;
  status: RoadStatus;
  headline: string;
  reasons: string[];
  reports: ReportSummary;
}

export interface StatusReport {
  generatedAt: string;
  roads: RoadReport[];
  river: {
    levelM: number | null;
    readingAt: string | null;
    ageMinutes: number | null;
    risePerHourM: number | null;
    trend: "rising" | "falling" | "steady" | null;
  };
  rain: { last3hMm: number | null; last12hMm: number | null; latestAt: string | null };
  warnings: ActiveWarning[];
  warningsCheckedAt: string | null;
  dataProblems: string[];
  advice: string;
}

export const ADVICE =
  "Never drive into floodwater. Just 30 cm of moving water can float a car. If in doubt, turn around.";

const HEADLINES: Record<RoadStatus, string> = {
  avoid: "Avoid: flooding likely or reported. Use another route.",
  caution: "Caution: flooding possible. Be ready to turn around.",
  open: "Open: no flooding indicated by river or EA data.",
  unknown: "Unknown: no recent river data. Check conditions yourself.",
};

const AREA_LABELS: Record<string, string> = {
  "112FWFISL10A": "River Isle from Chard Reservoir to Hambridge",
  "112WAFTSSR": "South Somerset Rivers, Upper Reaches",
};

const minutesBetween = (a: Date, b: Date) => (a.getTime() - b.getTime()) / 60_000;
const m = (v: number) => `${v.toFixed(2)} m`;

/** Rate of rise in m/h, from the reading nearest to 1 h before the latest one. */
export function risePerHour(levels: TimedValue[]): number | null {
  const latest = levels.at(-1);
  if (!latest) return null;
  const latestTime = new Date(latest.ts);
  let best: { value: number; minutes: number } | null = null;
  for (const r of levels) {
    const minutes = minutesBetween(latestTime, new Date(r.ts));
    if (minutes < RISE_WINDOW_MIN.min || minutes > RISE_WINDOW_MIN.max) continue;
    if (!best || Math.abs(minutes - 60) < Math.abs(best.minutes - 60)) best = { value: r.value, minutes };
  }
  return best ? ((latest.value - best.value) / best.minutes) * 60 : null;
}

function rainSince(rain: TimedValue[], now: Date, hours: number): number {
  const from = now.getTime() - hours * 3_600_000;
  return rain.filter((r) => new Date(r.ts).getTime() > from).reduce((sum, r) => sum + r.value, 0);
}

function maxLevelSince(levels: TimedValue[], now: Date, hours: number): number {
  const from = now.getTime() - hours * 3_600_000;
  return Math.max(-Infinity, ...levels.filter((r) => new Date(r.ts).getTime() >= from).map((r) => r.value));
}

export function computeStatus(input: StatusInputs): StatusReport {
  const { now } = input;
  const dataProblems: string[] = [];

  const latest = input.levels.at(-1) ?? null;
  const ageMinutes = latest ? Math.max(0, minutesBetween(now, new Date(latest.ts))) : null;
  const levelFresh = ageMinutes !== null && ageMinutes <= LEVEL_STALE_MIN;
  if (!levelFresh) {
    dataProblems.push(
      latest
        ? `The latest Donyatt river reading is ${Math.round(ageMinutes!)} minutes old.`
        : "No Donyatt river readings are available.",
    );
  }
  const rate = levelFresh ? risePerHour(input.levels) : null;

  const warningsFresh =
    input.warningsCheckedAt !== null && minutesBetween(now, new Date(input.warningsCheckedAt)) <= WARNINGS_STALE_MIN;
  if (!warningsFresh) dataProblems.push("EA flood warnings couldn't be checked recently.");
  const inForce = input.warnings.filter(
    (w) => (WATCHED_FLOOD_AREAS as readonly string[]).includes(w.floodAreaId) && w.severityLevel >= 1 && w.severityLevel <= 3,
  );
  const warningsInForce = inForce.filter((w) => w.severityLevel <= EA_SEVERITY.warning);
  const alertsInForce = inForce.filter((w) => w.severityLevel === EA_SEVERITY.alert);

  const latestRain = input.rain.at(-1) ?? null;
  const rainFresh = latestRain !== null && minutesBetween(now, new Date(latestRain.ts)) <= RAIN_STALE_MIN;
  if (!rainFresh) dataProblems.push("Upstream rainfall at Chard isn't available right now.");
  const rain3h = rainFresh ? rainSince(input.rain, now, 3) : null;
  const rain12h = rainFresh ? rainSince(input.rain, now, 12) : null;

  const roads = ROADS.map((road) => roadStatus(road));

  function roadStatus(road: Road): RoadReport {
    const avoid: string[] = [];
    const caution: string[] = [];

    for (const w of warningsInForce) {
      avoid.push(`EA ${w.severity.toLowerCase()} in force: ${AREA_LABELS[w.floodAreaId] ?? w.floodAreaId}.`);
    }

    if (levelFresh && latest) {
      const level = latest.value;
      const rising = rate !== null && rate > 0 ? ` and rising ${rate.toFixed(2)} m per hour` : "";
      // The current level, if it alone justifies Avoid. Then it isn't repeated as a Caution reason.
      let levelAvoid: string | null = null;
      if (level >= LEVEL.avoid) {
        levelAvoid = `The River Isle at Donyatt is at ${m(level)}${rising}. Roads have flooded from ${m(LEVEL.avoid)}.`;
      } else if (level >= PROJECTED_AVOID.minLevel && rate !== null && rate > 0) {
        const projected = level + rate * (PROJECTED_AVOID.aheadHours + ageMinutes! / 60);
        if (projected >= LEVEL.avoid) {
          levelAvoid = `The River Isle at Donyatt is at ${m(level)}${rising}, so it's likely to reach road-flooding level (${m(LEVEL.avoid)}) within about an hour.`;
        }
      }
      if (levelAvoid) {
        avoid.push(levelAvoid);
      } else if (maxLevelSince(input.levels, now, road.avoidHoldHours) >= LEVEL.avoid) {
        avoid.push(`The river was above ${m(LEVEL.avoid)} within the last ${road.avoidHoldHours} h. Floodwater takes time to clear.`);
      }

      if (levelAvoid) {
        // Already described.
      } else if (level >= LEVEL.caution) {
        caution.push(`The River Isle at Donyatt is at ${m(level)}, above its normal range (${m(LEVEL.caution)})${rising}.`);
      } else if (level >= RISING.minLevel && rate !== null && rate >= RISING.ratePerHour) {
        caution.push(`The River Isle at Donyatt is at ${m(level)}${rising}.`);
      } else if (maxLevelSince(input.levels, now, road.cautionHoldHours) >= LEVEL.caution) {
        caution.push(`The river was above its normal range within the last ${road.cautionHoldHours} h.`);
      }
    }

    for (const w of alertsInForce) {
      caution.push(`EA flood alert in force: ${AREA_LABELS[w.floodAreaId] ?? w.floodAreaId}.`);
    }
    if (rain3h !== null && rain3h >= HEAVY_RAIN.mmIn3h) {
      caution.push(`Heavy rain upstream at Chard: ${rain3h.toFixed(1)} mm in the last 3 h.`);
    } else if (rain12h !== null && rain12h >= HEAVY_RAIN.mmIn12h) {
      caution.push(`Heavy rain upstream at Chard: ${rain12h.toFixed(1)} mm in the last 12 h.`);
    }
    if (!warningsFresh) caution.push("EA flood warnings couldn't be checked recently.");

    // Driver reports can only make the status stricter, never looser.
    const reports = summariseReports(input.reports ?? [], road.id, now);
    const doNotAttempt = describeReports(reports, "do_not_attempt");
    if (reports.weights.do_not_attempt >= REPORTS.avoidAtDoNotAttempt) avoid.push(doNotAttempt!);
    else if (reports.weights.do_not_attempt >= REPORTS.cautionAtDoNotAttempt) caution.push(doNotAttempt!);
    if (reports.weights.care >= REPORTS.cautionAtCare) caution.push(describeReports(reports, "care")!);

    let status: RoadStatus;
    let reasons: string[];
    if (avoid.length) {
      status = "avoid";
      reasons = [...avoid, ...caution];
    } else if (!levelFresh) {
      status = "unknown";
      reasons = [dataProblems[0], ...caution];
    } else if (caution.length) {
      status = "caution";
      reasons = caution;
    } else {
      status = "open";
      reasons = [`The River Isle at Donyatt is at ${m(latest!.value)}, within its normal range.`];
    }
    // "Clear" reports are shown for information only; they never lower the status.
    const clear = describeReports(reports, "clear");
    if (clear && (status === "open" || status === "caution")) reasons.push(clear);
    return { id: road.id, name: road.name, where: road.where, status, headline: HEADLINES[status], reasons, reports };
  }

  return {
    generatedAt: now.toISOString(),
    roads,
    river: {
      levelM: latest?.value ?? null,
      readingAt: latest?.ts ?? null,
      ageMinutes: ageMinutes === null ? null : Math.round(ageMinutes),
      risePerHourM: rate === null ? null : Math.round(rate * 1000) / 1000,
      trend: rate === null ? null : rate >= 0.02 ? "rising" : rate <= -0.02 ? "falling" : "steady",
    },
    rain: {
      last3hMm: rain3h === null ? null : Math.round(rain3h * 10) / 10,
      last12hMm: rain12h === null ? null : Math.round(rain12h * 10) / 10,
      latestAt: latestRain?.ts ?? null,
    },
    warnings: inForce,
    warningsCheckedAt: input.warningsCheckedAt,
    dataProblems,
    advice: ADVICE,
  };
}
