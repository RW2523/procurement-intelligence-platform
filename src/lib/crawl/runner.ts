import { getServiceClient } from "@/lib/supabase/server";
import type { Source } from "@/lib/types";
import { runCrawlForSource, type CrawlOptions, type CrawlSummary } from "./pipeline";

export async function getActiveSources(): Promise<Source[]> {
  const sb = getServiceClient();
  const { data } = await sb
    .from("sources")
    .select("*")
    .eq("is_active", true)
    .order("name");
  return (data ?? []) as Source[];
}

export async function getSourceBySlug(slug: string): Promise<Source | null> {
  const sb = getServiceClient();
  const { data } = await sb.from("sources").select("*").eq("slug", slug).maybeSingle();
  return (data as Source) ?? null;
}

export async function getSourceById(id: string): Promise<Source | null> {
  const sb = getServiceClient();
  const { data } = await sb.from("sources").select("*").eq("id", id).maybeSingle();
  return (data as Source) ?? null;
}

/** Crawl every active source sequentially (politeness: no portal hammered in parallel). */
export async function runAllCrawls(opts: CrawlOptions = {}): Promise<CrawlSummary[]> {
  const sources = await getActiveSources();
  const summaries: CrawlSummary[] = [];
  for (const source of sources) {
    summaries.push(await runCrawlForSource(source, { ...opts, trigger: opts.trigger ?? "scheduled" }));
  }
  return summaries;
}
