import { NextRequest, NextResponse } from "next/server";
import { getServiceClient, dbConfigured } from "@/lib/supabase/server";
import { fetchOpportunityDocuments } from "@/lib/crawl/attachments";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST { batch?, maxDocs?, recommendations? }
 * Discover → download → text-extract documents for strong-fit opportunities that
 * don't yet have any downloaded document. Processes a bounded batch and reports how
 * many remain, so a caller can loop until `remaining` hits 0.
 */
export async function POST(req: NextRequest) {
  if (!dbConfigured) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const body = await req.json().catch(() => ({}) as Record<string, unknown>);
  const batch = Math.min(Math.max(Number(body.batch) || 4, 1), 10);
  const maxDocs = Math.min(Math.max(Number(body.maxDocs) || 5, 1), 10);
  const recs = Array.isArray(body.recommendations) ? (body.recommendations as string[]) : ["BID"];
  const sb = getServiceClient();

  // Strong-fit opportunities that have a detail page to discover documents from.
  const { data: candidates } = await sb
    .from("opportunities")
    .select("id")
    .in("bid_recommendation", recs)
    .not("detail_url", "is", null)
    .order("relevance_score", { ascending: false })
    .limit(500);
  const candidateIds = (candidates ?? []).map((c) => c.id);
  if (!candidateIds.length) {
    return NextResponse.json({ processed: 0, stored: 0, remaining: 0, done: true });
  }

  // Which of those already have a downloaded document → skip them.
  const { data: doneRows } = await sb
    .from("attachments")
    .select("opportunity_id")
    .in("opportunity_id", candidateIds)
    .not("downloaded_at", "is", null);
  const done = new Set((doneRows ?? []).map((r) => r.opportunity_id));
  const todo = candidateIds.filter((id) => !done.has(id));

  const slice = todo.slice(0, batch);
  let stored = 0;
  let discovered = 0;
  const detail: { id: string; discovered: number; stored: number }[] = [];
  for (const id of slice) {
    try {
      const r = await fetchOpportunityDocuments(id, { max: maxDocs, discover: true });
      stored += r.stored;
      discovered += r.discovered;
      detail.push({ id, discovered: r.discovered, stored: r.stored });
    } catch (e) {
      detail.push({ id, discovered: 0, stored: 0 });
      void e;
    }
  }

  const remaining = Math.max(0, todo.length - slice.length);
  return NextResponse.json({
    processed: slice.length,
    discovered,
    stored,
    remaining,
    done: remaining === 0,
    detail,
  });
}
