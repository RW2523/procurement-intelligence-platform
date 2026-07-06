import { getServiceClient } from "@/lib/supabase/server";
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

const OPEN_STATUSES = ["NEW", "OPEN", "AMENDED", "CLOSING_SOON"];
const CLOSING_SOON_DAYS = 7;

/**
 * Dashboard tiles computed with indexed COUNT queries (head:true) rather than
 * pulling the whole corpus into memory — the latter exceeded Postgres's statement
 * timeout under load and intermittently 500'd the landing page. Each count is a
 * fast `SELECT count(*) … WHERE …`; they run in parallel.
 */
export async function getDashboardStats(): Promise<DashboardStats> {
  const sb = getServiceClient();
  const nowIso = new Date().toISOString();
  const soonIso = new Date(Date.now() + CLOSING_SOON_DAYS * 86_400_000).toISOString();
  const yesterdayIso = new Date(Date.now() - 86_400_000).toISOString();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type QB = any;
  const c = async (build: (q: QB) => QB): Promise<number> => {
    const { count } = await build(sb.from("opportunities").select("*", { count: "exact", head: true }));
    return count ?? 0;
  };
  const open = (q: QB) => q.in("status", OPEN_STATUSES);
  const actionable = (q: QB) => open(q).neq("urgency", "INSUFFICIENT_TIME");

  const { data: sourceRows } = await sb.from("sources").select("id, state");
  const sources = (sourceRows ?? []).filter((s) => s.state);

  const [
    totalOpps,
    totalOpen,
    newCount,
    relevantNew,
    amended,
    submitted,
    won,
    pursueNow,
    captureReview,
    newPursue,
    closingSoon,
    respCount,
    urgent,
    standard,
    early,
    insufficient,
    ...stateCounts
  ] = await Promise.all([
    c((q) => q),
    c((q) => open(q)),
    c((q) => q.eq("status", "NEW")),
    c((q) => q.eq("status", "NEW").gte("relevance_score", 70)),
    c((q) => q.eq("status", "AMENDED")),
    c((q) => q.eq("pipeline_stage", "SUBMITTED")),
    c((q) => q.eq("pipeline_stage", "WON")),
    c((q) => actionable(q).eq("pursuit_bucket", "PURSUE")),
    c((q) => actionable(q).eq("pursuit_bucket", "CAPTURE_REVIEW")),
    c((q) => actionable(q).eq("pursuit_bucket", "PURSUE").gte("first_seen_at", yesterdayIso)),
    c((q) => open(q).gte("due_date", nowIso).lte("due_date", soonIso)),
    (async () => {
      const { count } = await sb.from("responses").select("*", { count: "exact", head: true });
      return count ?? 0;
    })(),
    c((q) => open(q).eq("urgency", "URGENT")),
    c((q) => open(q).eq("urgency", "STANDARD")),
    c((q) => open(q).eq("urgency", "EARLY_CAPTURE")),
    c((q) => open(q).eq("urgency", "INSUFFICIENT_TIME")),
    ...sources.map((s) => c((q) => q.eq("source_id", s.id))),
  ]);

  // Pipeline value: only the handful of opps that expose an estimated value.
  const { data: valueRows } = await sb
    .from("opportunities")
    .select("estimated_value")
    .in("status", OPEN_STATUSES)
    .not("estimated_value", "is", null);
  const pipelineValue = (valueRows ?? []).reduce((s, r) => s + Number(r.estimated_value ?? 0), 0);

  const byState = sources
    .map((s, i) => ({ state: s.state as string, count: stateCounts[i] ?? 0 }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count);

  return {
    totalOpps,
    totalOpen,
    newCount,
    relevantNew,
    pursueNow,
    captureReview,
    newPursue,
    urgencyDist: [
      { band: "URGENT", label: "Urgent (10–20d)", color: "var(--color-rose-500)", count: urgent },
      { band: "STANDARD", label: "Standard (21–45d)", color: "var(--color-sky-500)", count: standard },
      { band: "EARLY_CAPTURE", label: "Early capture (46+d)", color: "var(--color-mint-500)", count: early },
      { band: "INSUFFICIENT_TIME", label: "< 10 days", color: "#9aa1ad", count: insufficient },
    ],
    closingSoon,
    amended,
    submitted,
    won,
    totalResponses: respCount,
    byStatus: {},
    byState,
    pipelineValue,
  };
}
