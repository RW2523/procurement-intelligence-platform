import { getServiceClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/db/fetchAll";
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
const CLOSING_SOON_DAYS = 7;

interface StatRow {
  status: string;
  pipeline_stage: string;
  due_date: string | null;
  first_seen_at: string | null;
  relevance_score: number | null;
  estimated_value: number | null;
  pursuit_bucket: string | null;
  urgency: string | null;
  source_id: string;
}

/**
 * Computed from ONE lean, embed-free pull aggregated in JS — deliberately not a
 * fan-out of ~20 parallel count queries (that stormed the cold pgBouncer pool and
 * tripped the role's short statement_timeout, intermittently 500'ing the landing
 * page) and not a per-row count embed (correlated sub-queries, also slow). Scalar
 * columns only, no joins → a fast sequential scan.
 */
export async function getDashboardStats(): Promise<DashboardStats> {
  const sb = getServiceClient();
  const now = Date.now();
  const soon = now + CLOSING_SOON_DAYS * 86_400_000;
  const dayAgo = now - 86_400_000;

  const [{ data: sourceRows }, rows, { count: respCount }] = await Promise.all([
    sb.from("sources").select("id, state"),
    fetchAllRows<StatRow>(
      "opportunities",
      "status, pipeline_stage, due_date, first_seen_at, relevance_score, estimated_value, pursuit_bucket, urgency, source_id",
    ),
    sb.from("responses").select("*", { count: "exact", head: true }),
  ]);

  const stateOf = new Map((sourceRows ?? []).map((s) => [s.id as string, s.state as string | null]));
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
    const open = OPEN.has(o.status);
    if (open) totalOpen++;
    if (o.status === "NEW") newCount++;
    if (o.status === "NEW" && (o.relevance_score ?? 0) >= 70) relevantNew++;
    if (o.status === "AMENDED") amended++;
    if (o.pipeline_stage === "SUBMITTED") submitted++;
    if (o.pipeline_stage === "WON") won++;

    const actionable = open && o.urgency !== "INSUFFICIENT_TIME";
    if (actionable && o.pursuit_bucket === "PURSUE") {
      pursueNow++;
      if (o.first_seen_at && new Date(o.first_seen_at).getTime() >= dayAgo) newPursue++;
    }
    if (actionable && o.pursuit_bucket === "CAPTURE_REVIEW") captureReview++;

    if (open && o.due_date) {
      const due = new Date(o.due_date).getTime();
      if (due >= now && due <= soon) closingSoon++;
    }
    if (open && o.estimated_value) pipelineValue += Number(o.estimated_value);
    if (open && o.urgency) urgencyMap.set(o.urgency, (urgencyMap.get(o.urgency) ?? 0) + 1);

    const state = stateOf.get(o.source_id);
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
    byStatus: {},
    byState: [...stateMap.entries()].map(([state, count]) => ({ state, count })).sort((a, b) => b.count - a.count),
    pipelineValue,
  };
}
