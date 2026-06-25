import { getServiceClient } from "@/lib/supabase/server";
import type { ConnectorType, CrawlRun, Source } from "@/lib/types";

export interface SourceHealth extends Source {
  open_count: number;
  total_count: number;
  new_count: number;
  last_run: CrawlRun | null;
}

export async function listSources(): Promise<Source[]> {
  const sb = getServiceClient();
  const { data } = await sb.from("sources").select("*").order("name");
  return (data ?? []) as Source[];
}

export async function listSourceHealth(): Promise<SourceHealth[]> {
  const sb = getServiceClient();
  const [{ data: sources }, { data: opps }, { data: runs }] = await Promise.all([
    sb.from("sources").select("*").order("name"),
    sb.from("opportunities").select("source_id, status, first_seen_at"),
    sb.from("crawl_runs").select("*").order("started_at", { ascending: false }).limit(100),
  ]);

  const latestRun = new Map<string, CrawlRun>();
  for (const r of (runs ?? []) as CrawlRun[]) if (!latestRun.has(r.source_id)) latestRun.set(r.source_id, r);

  const openSet = new Set(["NEW", "OPEN", "AMENDED", "CLOSING_SOON"]);
  return ((sources ?? []) as Source[]).map((s) => {
    const mine = (opps ?? []).filter((o) => o.source_id === s.id);
    return {
      ...s,
      total_count: mine.length,
      open_count: mine.filter((o) => openSet.has(o.status as string)).length,
      new_count: mine.filter((o) => o.status === "NEW").length,
      last_run: latestRun.get(s.id) ?? null,
    };
  });
}

export async function getSource(id: string): Promise<Source | null> {
  const sb = getServiceClient();
  const { data } = await sb.from("sources").select("*").eq("id", id).maybeSingle();
  return (data as Source) ?? null;
}

export async function getSourceRuns(sourceId: string, limit = 15): Promise<CrawlRun[]> {
  const sb = getServiceClient();
  const { data } = await sb
    .from("crawl_runs")
    .select("*")
    .eq("source_id", sourceId)
    .order("started_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as CrawlRun[];
}

export interface NewSourceInput {
  name: string;
  slug: string;
  state?: string;
  base_url: string;
  connector_type: ConnectorType;
  connector_key?: string;
  schedule_cron?: string;
  timezone?: string;
  requires_auth?: boolean;
  notes?: string;
}

export async function createSource(input: NewSourceInput): Promise<Source> {
  const sb = getServiceClient();
  // If no connector module exists for the key, flag it so engineering knows.
  const { hasConnector } = await import("@/lib/connectors/registry");
  const status = hasConnector(input.connector_key) ? "active" : "needs_connector";
  const { data, error } = await sb
    .from("sources")
    .insert({ ...input, status })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as Source;
}

export async function updateSource(id: string, patch: Partial<Source>): Promise<void> {
  const sb = getServiceClient();
  await sb.from("sources").update(patch).eq("id", id);
}

export async function getAllCrawlRuns(limit = 30): Promise<(CrawlRun & { source_name?: string })[]> {
  const sb = getServiceClient();
  const { data } = await sb
    .from("crawl_runs")
    .select("*, source:sources(name)")
    .order("started_at", { ascending: false })
    .limit(limit);
  return (data ?? []).map((r) => ({
    ...(r as CrawlRun),
    source_name: (r as { source?: { name?: string } }).source?.name,
  }));
}
