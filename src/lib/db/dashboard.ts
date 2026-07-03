import { getServiceClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/db/fetchAll";
import { daysUntil } from "@/lib/utils";
import { CLOSING_SOON_DAYS } from "@/lib/defaults";
import type { OppStatus } from "@/lib/types";

export interface DashboardStats {
  totalOpps: number;
  totalOpen: number;
  newCount: number;
  relevantNew: number;
  pursueNow: number;
  captureReview: number;
  /** PURSUE items first seen in the last 24h ("new since yesterday"). */
  newPursue: number;
  /** Open-opportunity §10 urgency distribution. */
  urgencyDist: { band: string; label: string; count: number; color: string }[];
  closingSoon: number;
  amended: number;
  submitted: number;
  won: number;
  totalResponses: number;
  byStatus: Partial<Record<OppStatus, number>>;
  byState: { state: string; count: number }[];
  pipelineValue: number;
}

const OPEN = new Set(["NEW", "OPEN", "AMENDED", "CLOSING_SOON"]);

export async function getDashboardStats(): Promise<DashboardStats> {
  const sb = getServiceClient();
  const [rows, { count: respCount }] = await Promise.all([
    fetchAllRows(
      "opportunities",
      "status, pipeline_stage, due_date, relevance_score, estimated_value, first_seen_at, pursuit_bucket, urgency, source:sources(state)",
    ),
    sb.from("responses").select("*", { count: "exact", head: true }),
  ]);
  const byStatus: Partial<Record<OppStatus, number>> = {};
  const stateMap = new Map<string, number>();
  const urgencyMap = new Map<string, number>();
  let totalOpen = 0,
    newCount = 0,
    relevantNew = 0,
    pursueNow = 0,
    captureReview = 0,
    newPursue = 0,
    closingSoon = 0,
    amended = 0,
    submitted = 0,
    won = 0,
    pipelineValue = 0;

  for (const o of rows) {
    const status = o.status as OppStatus;
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    const open = OPEN.has(status);
    if (open) totalOpen++;
    if (status === "NEW") newCount++;
    if (status === "NEW" && (o.relevance_score ?? 0) >= 70) relevantNew++;
    if (status === "AMENDED") amended++;
    // Targeting buckets: actionable = open with >= 10 days to respond (§10).
    const actionable = open && o.urgency !== "INSUFFICIENT_TIME";
    if (actionable && o.pursuit_bucket === "PURSUE") pursueNow++;
    if (actionable && o.pursuit_bucket === "CAPTURE_REVIEW") captureReview++;
    if (
      actionable &&
      o.pursuit_bucket === "PURSUE" &&
      o.first_seen_at &&
      Date.now() - new Date(o.first_seen_at as string).getTime() < 86_400_000
    ) {
      newPursue++;
    }
    if (open && o.urgency) urgencyMap.set(o.urgency as string, (urgencyMap.get(o.urgency as string) ?? 0) + 1);
    if (o.pipeline_stage === "SUBMITTED") submitted++;
    if (o.pipeline_stage === "WON") won++;
    const d = daysUntil(o.due_date as string | null);
    if (open && d !== null && d >= 0 && d <= CLOSING_SOON_DAYS) closingSoon++;
    if (open && o.estimated_value) pipelineValue += Number(o.estimated_value);
    const state = (o as { source?: { state?: string } }).source?.state;
    if (state) stateMap.set(state, (stateMap.get(state) ?? 0) + 1);
  }

  return {
    totalOpps: rows.length,
    totalOpen,
    newCount,
    relevantNew,
    pursueNow,
    captureReview,
    newPursue,
    urgencyDist: [
      { band: "URGENT", label: "Urgent (10–20d)", color: "var(--color-rose-500)" },
      { band: "STANDARD", label: "Standard (21–45d)", color: "var(--color-sky-500)" },
      { band: "EARLY_CAPTURE", label: "Early capture (46+d)", color: "var(--color-mint-500)" },
      { band: "INSUFFICIENT_TIME", label: "< 10 days", color: "#9aa1ad" },
    ].map((b) => ({ ...b, count: urgencyMap.get(b.band) ?? 0 })),
    closingSoon,
    amended,
    submitted,
    won,
    totalResponses: respCount ?? 0,
    byStatus,
    byState: [...stateMap.entries()].map(([state, count]) => ({ state, count })).sort((a, b) => b.count - a.count),
    pipelineValue,
  };
}
