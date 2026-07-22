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

/** Active sources ordered stalest-first (never-succeeded first), so each time-capped
 *  run makes progress on the least-recently-crawled sources — natural round-robin
 *  coverage across consecutive runs. */
async function getSourcesStalestFirst(): Promise<Source[]> {
  const sb = getServiceClient();
  const { data } = await sb
    .from("sources")
    .select("*")
    .eq("is_active", true)
    .order("last_success_at", { ascending: true, nullsFirst: true })
    .order("last_run_at", { ascending: true, nullsFirst: true })
    .order("name", { ascending: true });
  return (data ?? []) as Source[];
}

export interface RunAllOptions extends CrawlOptions {
  /** Hard per-source timeout; a slow/hung source is aborted so it can't block the rest. Default 60s. */
  perSourceTimeoutMs?: number;
  /** Stop STARTING new sources once this much wall-clock has elapsed (headroom under the 300s platform cap). Default 240s. */
  overallBudgetMs?: number;
  /** Optional cap on how many sources to attempt this run. */
  maxSources?: number;
}

/**
 * Crawl active sources sequentially (politeness: no portal hammered in parallel) with
 * two guardrails so a single run can never hang or overrun the serverless timeout:
 *   1. per-source watchdog — aborts a source's in-flight network I/O and moves on after
 *      perSourceTimeoutMs, so one slow/hung portal (e.g. NC/TX) can't starve the rest;
 *   2. overall time budget — stops launching NEW sources near the platform cap, so the
 *      function returns cleanly instead of being killed mid-write.
 * Sources are taken stalest-first, so consecutive (capped) runs round-robin to full coverage.
 */
export async function runAllCrawls(opts: RunAllOptions = {}): Promise<CrawlSummary[]> {
  const perSourceTimeoutMs = opts.perSourceTimeoutMs ?? 60_000;
  const overallBudgetMs = opts.overallBudgetMs ?? 240_000;
  const sb = getServiceClient();
  const sources = await getSourcesStalestFirst();
  const startedAt = Date.now();
  const summaries: CrawlSummary[] = [];
  let attempted = 0;

  for (const source of sources) {
    if (Date.now() - startedAt >= overallBudgetMs) break; // out of time budget for this run
    if (opts.maxSources && attempted >= opts.maxSources) break;
    attempted++;

    // Per-source abort: chain any caller signal, and abort on watchdog fire so the
    // connector's fetch (which honors opts.signal) is actually cancelled.
    const controller = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = new Promise<CrawlSummary>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({
          sourceId: source.id, sourceName: source.name, runId: null, status: "failed",
          itemsFound: 0, newCount: 0, changedCount: 0, closedCount: 0, errorCount: 1,
          methodUsed: "", warnings: [], durationMs: perSourceTimeoutMs,
          error: `watchdog timeout after ${perSourceTimeoutMs}ms`,
        });
      }, perSourceTimeoutMs);
    });

    try {
      const summary = await Promise.race([
        runCrawlForSource(source, { trigger: opts.trigger ?? "scheduled", limit: opts.limit, signal: controller.signal }),
        watchdog,
      ]);
      summaries.push(summary);
      // If the watchdog won, bump last_run_at so stalest-ordering rotates this slow
      // source to the back next run instead of retrying it first every time.
      if (summary.error?.includes("watchdog")) {
        await sb
          .from("sources")
          .update({
            last_run_at: new Date().toISOString(),
            status: "error",
            consecutive_failures: (source.consecutive_failures ?? 0) + 1,
          })
          .eq("id", source.id);
      }
    } catch (e) {
      summaries.push({
        sourceId: source.id, sourceName: source.name, runId: null, status: "failed",
        itemsFound: 0, newCount: 0, changedCount: 0, closedCount: 0, errorCount: 1,
        methodUsed: "", warnings: [], durationMs: Date.now() - startedAt,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return summaries;
}
