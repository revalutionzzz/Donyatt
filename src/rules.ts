// Stage 2 status rules. Values come from the EA thresholds in CLAUDE.md and from the
// analysis of 56 past floods in model/reports/flood_events.md (python3 model/analyse_events.py).
// Change them only with evidence (history, local knowledge or crowd reports), and keep the tests in step.

/** Donyatt gauge levels, metres above stage datum. */
export const LEVEL = {
  /** Top of the normal range. In 75% of days reaching it, the river hit 1.40 m within 12 h. */
  caution: 1.2,
  /** Historical road flooding at Donyatt. */
  avoid: 1.8,
};

/**
 * "Rising" Caution trigger: at or above `minLevel` and rising at least `ratePerHour`.
 * Flagged all 21 floods since 2017, with a median of 2 h notice (shortest 48 min).
 */
export const RISING = { minLevel: 1.0, ratePerHour: 0.1 };

/**
 * Early Avoid: at or above `minLevel` and projected to reach LEVEL.avoid within `aheadHours`
 * (plus the age of the reading) at the current rate of rise. Flagged all 56 floods since 1992,
 * with a median of 60 min before the river reached 1.80 m. About half the time the river
 * peaks between 1.50 and 1.80 m instead, which is still high water.
 */
export const PROJECTED_AVOID = { minLevel: 1.5, aheadHours: 1 };

/**
 * Heavy upstream rain at Chard Snowdon Hill. Rare, but mostly followed by a rise
 * (20 mm in 3 h: 4 of 7 days reached 1.40 m; 35 mm in 12 h: 8 of 10 days).
 */
export const HEAVY_RAIN = { mmIn3h: 20, mmIn12h: 35 };

/** Rate of rise is measured against the reading nearest to 1 h before the latest one, within this window. */
export const RISE_WINDOW_MIN = { min: 45, max: 90 };

/** Level older than this: we don't claim anything from the gauge (EA readings normally arrive 15-45 min late). */
export const LEVEL_STALE_MIN = 90;
/** Warnings not checked successfully for this long: never show Open. */
export const WARNINGS_STALE_MIN = 60;
/** Rain older than this is ignored (rain can only raise the status, so ignoring it is safe for Avoid but noted). */
export const RAIN_STALE_MIN = 90;

/** EA severity levels. 4 = "warning no longer in force" and is ignored. */
export const EA_SEVERITY = { severeWarning: 1, warning: 2, alert: 3 };

export interface Road {
  id: string;
  name: string;
  where: string;
  /**
   * Keep Avoid/Caution for this long after Donyatt drops back below the threshold,
   * because floodwater takes time to drain off the road and to pass downstream.
   */
  avoidHoldHours: number;
  cautionHoldHours: number;
}

// The two downstream roads have no published EA threshold. They use the Donyatt gauge with
// longer holds (floods at Donyatt stayed above 1.80 m for 3-10 h and above 1.20 m for 4-15 h
// in recent events). These holds are cautious defaults, to be tightened with local knowledge.
export const ROADS: Road[] = [
  {
    id: "a358-donyatt",
    name: "A358 south of Donyatt",
    where: "Main A303 diversion, by the River Isle at Donyatt",
    avoidHoldHours: 1,
    cautionHoldHours: 1,
  },
  {
    id: "b3168-ilford-bridges",
    name: "B3168 at Ilford Bridges",
    where: "Downstream of the Donyatt gauge",
    avoidHoldHours: 3,
    cautionHoldHours: 6,
  },
  {
    id: "isle-brewers-fivehead",
    name: "Isle Brewers – Fivehead road",
    where: "Downstream of the Donyatt gauge, in the EA warning area",
    avoidHoldHours: 3,
    cautionHoldHours: 6,
  },
];
