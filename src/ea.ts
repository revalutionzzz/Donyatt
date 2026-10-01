import { EA_BASE } from "./config";

export interface Reading {
  ts: string;
  value: number;
}

export interface FloodWarning {
  floodAreaId: string;
  severityLevel: number;
  severity: string;
  message: string | null;
  timeRaised: string | null;
  timeSeverityChanged: string | null;
  timeMessageChanged: string;
}

const HEADERS = { "User-Agent": "donyatt-flood-watch (community flood tool)", Accept: "application/json" };

async function getJson(url: string, fetchFn: typeof fetch): Promise<unknown> {
  const res = await fetchFn(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`EA ${res.status} for ${url}`);
  return res.json();
}

export function readingsUrl(measureId: string, since: string): string {
  return `${EA_BASE}/id/measures/${measureId}/readings?since=${encodeURIComponent(since)}&_sorted&_limit=2000`;
}

/**
 * Keeps only readings with a single numeric value. The EA occasionally returns
 * duplicate readings as an array of values; those are skipped rather than guessed at.
 */
export function parseReadings(body: unknown): { readings: Reading[]; skipped: number } {
  const items = (body as { items?: unknown[] })?.items;
  if (!Array.isArray(items)) throw new Error("EA readings response has no items array");
  const readings: Reading[] = [];
  let skipped = 0;
  for (const item of items as { dateTime?: unknown; value?: unknown }[]) {
    if (typeof item.dateTime === "string" && typeof item.value === "number" && Number.isFinite(item.value)) {
      readings.push({ ts: item.dateTime, value: item.value });
    } else {
      skipped++;
    }
  }
  return { readings, skipped };
}

export function parseFloods(body: unknown, areas: readonly string[]): FloodWarning[] {
  const items = (body as { items?: unknown[] })?.items;
  if (!Array.isArray(items)) throw new Error("EA floods response has no items array");
  const out: FloodWarning[] = [];
  for (const f of items as Record<string, unknown>[]) {
    const areaId = f.floodAreaID;
    if (typeof areaId !== "string" || !areas.includes(areaId)) continue;
    if (typeof f.severityLevel !== "number" || typeof f.severity !== "string") {
      throw new Error(`EA flood item for ${areaId} is missing severity`);
    }
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    out.push({
      floodAreaId: areaId,
      severityLevel: f.severityLevel,
      severity: f.severity,
      message: str(f.message),
      timeRaised: str(f.timeRaised),
      timeSeverityChanged: str(f.timeSeverityChanged),
      // Part of the primary key, so fall back rather than drop the warning.
      timeMessageChanged: str(f.timeMessageChanged) ?? str(f.timeSeverityChanged) ?? str(f.timeRaised) ?? "unknown",
    });
  }
  return out;
}

/** Readings for whole UTC days, from startDate to endDate inclusive (YYYY-MM-DD). */
export function rangeReadingsUrl(measureId: string, startDate: string, endDate: string): string {
  return `${EA_BASE}/id/measures/${measureId}/readings?startdate=${startDate}&enddate=${endDate}&_sorted&_limit=2000`;
}

export async function fetchReadingsRange(measureId: string, startDate: string, endDate: string, fetchFn: typeof fetch = fetch) {
  return parseReadings(await getJson(rangeReadingsUrl(measureId, startDate, endDate), fetchFn));
}

export async function fetchReadings(measureId: string, since: string, fetchFn: typeof fetch = fetch) {
  return parseReadings(await getJson(readingsUrl(measureId, since), fetchFn));
}

export async function fetchFloods(areas: readonly string[], fetchFn: typeof fetch = fetch) {
  return parseFloods(await getJson(`${EA_BASE}/id/floods`, fetchFn), areas);
}
