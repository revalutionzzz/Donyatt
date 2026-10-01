// EA identifiers confirmed against the live API on 2026-09-30 (see CLAUDE.md).
export const EA_BASE = "https://environment.data.gov.uk/flood-monitoring";

/** River Isle at Donyatt, station 52115. Metres above stage datum (same scale as the EA thresholds). */
export const DONYATT_LEVEL_MEASURE = "52115-level-stage-i-15_min-mASD";

/** Chard Snowdon Hill tipping-bucket rain gauge, station 52129. mm per 15 minutes. */
export const SNOWDON_HILL_RAIN_MEASURE = "52129-rainfall-tipping_bucket_raingauge-t-15_min-mm";

/** Flood areas we record alerts/warnings for. */
export const WATCHED_FLOOD_AREAS = [
  "112FWFISL10A", // Flood warning area: River Isle from Chard Reservoir to Hambridge not including Ilminster
  "112WAFTSSR", // Parent flood alert area: South Somerset Rivers, Upper Reaches
] as const;

/** How far back to fetch when a measure has no stored readings yet. */
export const INITIAL_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** Donyatt stage readings outside this range are almost certainly a datum/sensor problem, not a flood. */
export const PLAUSIBLE_LEVEL_M = { min: -0.5, max: 4 };

/** Public address of the site, used in alert messages. */
export const SITE_URL = "https://donyattfloodwatch.co.uk/";

/**
 * Open-Meteo forecast point: the Chard Snowdon Hill rain gauge (EA station 52129, ST310089).
 * Open-Meteo's `precipitation` is the total for the preceding hour; times are requested in GMT.
 */
export const FORECAST_POINT = { latitude: 50.8759, longitude: -2.9814 };
export const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";
