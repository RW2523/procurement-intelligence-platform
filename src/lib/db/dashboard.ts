import { getServiceClient } from "@/lib/supabase/server";
import { daysUntil } from "@/lib/utils";
import { CLOSING_SOON_DAYS } from "@/lib/defaults";
import type { OppStatus } from "@/lib/types";

export interface DashboardStats {
  totalOpps: number;
  totalOpen: number;
  newCount: number;
  relevantNew: number;
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
  const [{ data: opps }, { count: respCount }] = await Promise.all([
    sb
      .from("opportunities")
      .select("status, pipeline_stage, due_date, relevance_score, estimated_value, first_seen_at, source:sources(state)"),
    sb.from("responses").select("*", { count: "exact", head: true }),
  ]);

  const rows = opps ?? [];
  const byStatus: Partial<Record<OppStatus, number>> = {};
  const stateMap = new Map<string, number>();
  let totalOpen = 0,
    newCount = 0,
    relevantNew = 0,
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
