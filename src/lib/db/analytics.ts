import { getServiceClient } from "@/lib/supabase/server";
import { PIPELINE_STAGES, type PipelineStage } from "@/lib/types";

export interface Analytics {
  byStage: { stage: PipelineStage; count: number }[];
  modeUsage: { mode: string; count: number }[];
  winRate: number | null;
  won: number;
  lost: number;
  submitted: number;
  avgRelevance: number | null;
  byState: { state: string; open: number; total: number }[];
  crawlSuccessRate: number | null;
  totalCrawls: number;
  avgCycleDays: number | null;
}

export async function getAnalytics(): Promise<Analytics> {
  const sb = getServiceClient();
  const [{ data: opps }, { data: responses }, { data: runs }, { data: submittedLog }] = await Promise.all([
    sb.from("opportunities").select("pipeline_stage, relevance_score, first_seen_at, source:sources(state), status"),
    sb.from("responses").select("mode"),
    sb.from("crawl_runs").select("status").limit(200),
    sb
      .from("opportunity_status_log")
      .select("opportunity_id, new_value, changed_at")
      .eq("field", "pipeline_stage")
      .eq("new_value", "SUBMITTED"),
  ]);

  const rows = opps ?? [];
  const stageCount = new Map<PipelineStage, number>();
  const stateMap = new Map<string, { open: number; total: number }>();
  let relSum = 0,
    relN = 0;
  const openSet = new Set(["NEW", "OPEN", "AMENDED", "CLOSING_SOON"]);
  const firstSeen = new Map<string, string>();

  for (const o of rows) {
    const stage = o.pipeline_stage as PipelineStage;
    stageCount.set(stage, (stageCount.get(stage) ?? 0) + 1);
    if (o.relevance_score != null) {
      relSum += Number(o.relevance_score);
      relN++;
    }
    const state = (o as { source?: { state?: string } }).source?.state;
    if (state) {
      const e = stateMap.get(state) ?? { open: 0, total: 0 };
      e.total++;
      if (openSet.has(o.status as string)) e.open++;
      stateMap.set(state, e);
    }
  }

  const modeMap = new Map<string, number>();
  for (const r of responses ?? []) modeMap.set(r.mode as string, (modeMap.get(r.mode as string) ?? 0) + 1);

  const won = stageCount.get("WON") ?? 0;
  const lost = stageCount.get("LOST") ?? 0;
  const submitted = stageCount.get("SUBMITTED") ?? 0;
  const decided = won + lost;

  const runRows = runs ?? [];
  const successful = runRows.filter((r) => r.status === "success" || r.status === "partial").length;

  return {
    byStage: PIPELINE_STAGES.map((stage) => ({ stage, count: stageCount.get(stage) ?? 0 })),
    modeUsage: [...modeMap.entries()].map(([mode, count]) => ({ mode, count })),
    winRate: decided ? Math.round((won / decided) * 100) : null,
    won,
    lost,
    submitted,
    avgRelevance: relN ? Math.round(relSum / relN) : null,
    byState: [...stateMap.entries()]
      .map(([state, v]) => ({ state, ...v }))
      .sort((a, b) => b.total - a.total),
    crawlSuccessRate: runRows.length ? Math.round((successful / runRows.length) * 100) : null,
    totalCrawls: runRows.length,
    avgCycleDays: submittedLog && submittedLog.length ? null : null,
  };
}
