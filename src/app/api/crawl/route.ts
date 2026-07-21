import { NextRequest, NextResponse } from "next/server";
import { runAllCrawls, getSourceBySlug } from "@/lib/crawl/runner";
import { runCrawlForSource } from "@/lib/crawl/pipeline";
import { scanDeadlines } from "@/lib/notify/deadlines";
import { dbConfigured } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const maxDuration = 300;

/** POST { source?: slug, limit?: number } — crawl one or all active sources. */
export async function POST(req: NextRequest) {
  if (!dbConfigured) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }
  try { await requireRole("admin"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }
  const body = await req.json().catch(() => ({}));
  const source: string | undefined = body.source;
  const limit: number | undefined = body.limit;

  let summaries;
  if (source) {
    const s = await getSourceBySlug(source);
    if (!s) return NextResponse.json({ error: `Unknown source: ${source}` }, { status: 404 });
    summaries = [await runCrawlForSource(s, { trigger: "manual", limit })];
  } else {
    summaries = await runAllCrawls({ trigger: "manual", limit });
  }
  const deadlines = await scanDeadlines();
  return NextResponse.json({ summaries, deadlines });
}
