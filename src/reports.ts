import { REPORTS } from "./rules";

export type ReportKind = "clear" | "care" | "do_not_attempt";
export const REPORT_KINDS: readonly ReportKind[] = ["clear", "care", "do_not_attempt"];
export const REPORT_LABELS: Record<ReportKind, string> = {
  clear: "Clear",
  care: "Passable with care",
  do_not_attempt: "Do not attempt",
};

export interface DriverReport {
  roadId: string;
  kind: ReportKind;
  createdAt: string;
}

export interface ReportSummary {
  /** Weighted totals (0-1 per report, fading with age). */
  weights: Record<ReportKind, number>;
  /** Reports still carrying weight, newest first, with their age. */
  recent: { kind: ReportKind; ageMinutes: number }[];
}

/** 1 while fresh, fading linearly to 0 at REPORTS.expireMinutes. */
export function reportWeight(ageMinutes: number): number {
  if (ageMinutes < 0) return 1;
  if (ageMinutes <= REPORTS.fullWeightMinutes) return 1;
  if (ageMinutes >= REPORTS.expireMinutes) return 0;
  return (REPORTS.expireMinutes - ageMinutes) / (REPORTS.expireMinutes - REPORTS.fullWeightMinutes);
}

export function summariseReports(reports: DriverReport[], roadId: string, now: Date): ReportSummary {
  const weights: Record<ReportKind, number> = { clear: 0, care: 0, do_not_attempt: 0 };
  const recent: ReportSummary["recent"] = [];
  for (const r of reports) {
    if (r.roadId !== roadId) continue;
    const ageMinutes = Math.max(0, (now.getTime() - Date.parse(r.createdAt)) / 60_000);
    const w = reportWeight(ageMinutes);
    if (w <= 0) continue;
    weights[r.kind] += w;
    recent.push({ kind: r.kind, ageMinutes: Math.round(ageMinutes) });
  }
  recent.sort((a, b) => a.ageMinutes - b.ageMinutes);
  return { weights, recent };
}

export function describeReports(summary: ReportSummary, kind: ReportKind): string | null {
  const matching = summary.recent.filter((r) => r.kind === kind);
  if (!matching.length) return null;
  const who = matching.length === 1 ? "1 driver" : `${matching.length} drivers`;
  const age = matching[0].ageMinutes < 1 ? "just now" : `${matching[0].ageMinutes} min ago`;
  return `${who} reported "${REPORT_LABELS[kind]}" (latest ${age}).`;
}
