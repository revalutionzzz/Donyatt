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
  /** Report id, set when it has a photo that may be shown. */
  id?: number;
  /** Has a photo that may be shown (not hidden, rejected or too old). */
  photoVisible?: boolean;
  /** The photo was approved by the admin. Only then does it add weight to the status. */
  photoApproved?: boolean;
  /** Daily anonymous device code. Each device counts once (its newest report); never sent to the page. */
  deviceHash?: string;
}

export interface ReportSummary {
  /** Weighted totals (0-1 per report, fading with age). */
  weights: Record<ReportKind, number>;
  /** Different devices behind live "Do not attempt" / "Passable with care" reports. */
  warningDevices: number;
  /** Reports still carrying weight, newest first, with their age (and photo id if one may be shown). */
  recent: { kind: ReportKind; ageMinutes: number; photoId?: number }[];
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
  // One person, one voice: only each device's newest report counts, so nobody can push the
  // status alone by reporting twice (the rate limit allows one report per 10 minutes).
  const newest = new Map<string, DriverReport>();
  for (const r of reports) {
    if (r.roadId !== roadId || !r.deviceHash) continue;
    const prev = newest.get(r.deviceHash);
    if (!prev || Date.parse(r.createdAt) > Date.parse(prev.createdAt)) newest.set(r.deviceHash, r);
  }
  const warningDevices = new Set<string>();
  let anonymousWarnings = 0;
  for (const r of reports) {
    if (r.roadId !== roadId) continue;
    if (r.deviceHash && newest.get(r.deviceHash) !== r) continue;
    const ageMinutes = Math.max(0, (now.getTime() - Date.parse(r.createdAt)) / 60_000);
    const w = reportWeight(ageMinutes);
    if (w <= 0) continue;
    weights[r.kind] += w * (r.photoVisible && r.photoApproved ? REPORTS.verifiedPhotoMultiplier : 1);
    if (r.kind !== "clear") {
      if (r.deviceHash) warningDevices.add(r.deviceHash);
      else anonymousWarnings++;
    }
    const entry: ReportSummary["recent"][number] = { kind: r.kind, ageMinutes: Math.round(ageMinutes) };
    if (r.photoVisible && r.id != null) entry.photoId = r.id;
    recent.push(entry);
  }
  recent.sort((a, b) => a.ageMinutes - b.ageMinutes);
  return { weights, warningDevices: warningDevices.size + anonymousWarnings, recent };
}

export function describeReports(summary: ReportSummary, kind: ReportKind): string | null {
  const matching = summary.recent.filter((r) => r.kind === kind);
  if (!matching.length) return null;
  const who = matching.length === 1 ? "1 driver" : `${matching.length} drivers`;
  const age = matching[0].ageMinutes < 1 ? "just now" : `${matching[0].ageMinutes} min ago`;
  return `${who} reported "${REPORT_LABELS[kind]}" (latest ${age}).`;
}

/**
 * SQL condition (report alias `r`): its photo may be shown publicly. Shown straight away (since
 * 2026-10-02, at the owner's request) unless the report is hidden, the photo rejected, or it is
 * older than the cutoff. Binds: (cutoff ISO time).
 */
export const VISIBLE_PHOTO_SQL = `(r.has_photo = 1 AND r.photo_key IS NOT NULL AND r.hidden = 0
  AND COALESCE(r.photo_state, '') <> 'rejected' AND r.created_at >= ?)`;
