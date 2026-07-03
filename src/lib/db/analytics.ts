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
  // ── Targeting engine (plan §6.6) ──
  scoreHistogram: { label: string; count: number }[];
  bucketBySource: { source: string; PURSUE: number; CAPTURE_REVIEW: number; MANUAL_REVIEW: number; IGNORE: number }[];
  exclusionByGroup: { group: string; count: number }[];
  winByBucket: { bucket: string; won: number; lost: number; submitted: number }[];
}

export async function getAnalytics(): Promise<Analytics> {
  const sb = getServiceClient();
  const [{ data: opps }, { data: responses }, { data: runs }, { data: submittedLog }] = await Promise.all([
    sb
      .from("opportunities")
      .select(
        "pipeline_stage, relevance_score, first_seen_at, status, pursuit_score, pursuit_bucket, excluded_reason, source:sources(state, name)",
      ),
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

  // Targeting-engine aggregations (plan §6.6)
  const HIST_BANDS = ["0–9", "10–19", "20–39", "40–59", "60–79", "80+"];
  const hist = new Map<string, number>(HIST_BANDS.map((b) => [b, 0]));
  const srcBuckets = new Map<string, { PURSUE: number; CAPTURE_REVIEW: number; MANUAL_REVIEW: number; IGNORE: number }>();
  const exclusions = new Map<string, number>();
  const winBucket = new Map<string, { won: number; lost: number; submitted: number }>();

  for (const o of rows) {
    const stage = o.pipeline_stage as PipelineStage;
    stageCount.set(stage, (stageCount.get(stage) ?? 0) + 1);
    if (o.relevance_score != null) {
      relSum += Number(o.relevance_score);
      relN++;
    }
    const src = (o as { source?: { state?: string; name?: string } }).source;
    const state = src?.state;
    if (state) {
      const e = stateMap.get(state) ?? { open: 0, total: 0 };
      e.total++;
      if (openSet.has(o.status as string)) e.open++;
      stateMap.set(state, e);
    }

    // score histogram
    const s = o.pursuit_score as number | null;
    if (s != null) {
      const band = s >= 80 ? "80+" : s >= 60 ? "60–79" : s >= 40 ? "40–59" : s >= 20 ? "20–39" : s >= 10 ? "10–19" : "0–9";
      hist.set(band, (hist.get(band) ?? 0) + 1);
    }
    // bucket counts per source (state code for portals, name for My Bids / SAM)
    const bucket = o.pursuit_bucket as string | null;
    if (bucket) {
      const key = state ?? src?.name ?? "Other";
      const e = srcBuckets.get(key) ?? { PURSUE: 0, CAPTURE_REVIEW: 0, MANUAL_REVIEW: 0, IGNORE: 0 };
      e[bucket as keyof typeof e]++;
      srcBuckets.set(key, e);
    }
    // exclusion counts by §8 group — excluded_reason format: "<keyword> (<Group>)"
    const exGroup = /\(([^)]+)\)\s*$/.exec((o.excluded_reason as string | null) ?? "")?.[1];
    if (exGroup) exclusions.set(exGroup, (exclusions.get(exGroup) ?? 0) + 1);
    // outcomes by bucket
    if (bucket && (stage === "WON" || stage === "LOST" || stage === "SUBMITTED")) {
      const e = winBucket.get(bucket) ?? { won: 0, lost: 0, submitted: 0 };
      if (stage === "WON") e.won++;
      else if (stage === "LOST") e.lost++;
      else e.submitted++;
      winBucket.set(bucket, e);
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
    scoreHistogram: HIST_BANDS.map((label) => ({ label, count: hist.get(label) ?? 0 })),
    bucketBySource: [...srcBuckets.entries()]
      .map(([source, v]) => ({ source, ...v }))
      .sort((a, b) => b.PURSUE + b.CAPTURE_REVIEW - (a.PURSUE + a.CAPTURE_REVIEW)),
    exclusionByGroup: [...exclusions.entries()]
      .map(([group, count]) => ({ group, count }))
      .sort((a, b) => b.count - a.count),
    winByBucket: ["PURSUE", "CAPTURE_REVIEW", "MANUAL_REVIEW", "IGNORE"]
      .map((bucket) => ({ bucket, ...(winBucket.get(bucket) ?? { won: 0, lost: 0, submitted: 0 }) }))
      .filter((r) => r.won + r.lost + r.submitted > 0),
  };
}
