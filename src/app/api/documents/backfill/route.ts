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

  // Portals whose documents are discoverable from the detail-page HTML. (NC keeps
  // documents behind a Dataverse subgrid, so NC opps are only processed when their
  // attachments were already discovered — otherwise the loop would never converge.)
  const DISCOVERABLE = new Set(["tn", "ma", "pa", "ar"]);

  // Strong-fit opportunities that have a detail page to discover documents from.
  const { data: candidates } = await sb
    .from("opportunities")
    .select("id, source:sources(slug)")
    .in("bid_recommendation", recs)
    .not("detail_url", "is", null)
    .is("documents_checked_at", null) // skip opps already attempted (converges the loop)
    .order("relevance_score", { ascending: false })
    .limit(800);
  const rows = (candidates ?? []).map((c) => ({
    id: c.id as string,
    slug: ((c as { source?: { slug?: string } }).source?.slug ?? "") as string,
  }));
  if (!rows.length) return NextResponse.json({ processed: 0, stored: 0, remaining: 0, done: true });
  const candidateIds = rows.map((r) => r.id);

  // Attachment state for the candidates: which are downloaded, which have any rows.
  const { data: attRows } = await sb
    .from("attachments")
    .select("opportunity_id, downloaded_at")
    .in("opportunity_id", candidateIds);
  const done = new Set<string>();
  const hasAttachment = new Set<string>();
  for (const a of attRows ?? []) {
    hasAttachment.add(a.opportunity_id);
    if (a.downloaded_at) done.add(a.opportunity_id);
  }

  // Eligible = not yet downloaded AND (already has discovered attachments OR portal is
  // HTML-discoverable). Process opps that already have attachments first (guaranteed yield).
  const eligible = rows.filter(
    (r) => !done.has(r.id) && (hasAttachment.has(r.id) || DISCOVERABLE.has(r.slug)),
  );
  eligible.sort((a, b) => Number(hasAttachment.has(b.id)) - Number(hasAttachment.has(a.id)));
  const todo = eligible.map((r) => r.id);

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
