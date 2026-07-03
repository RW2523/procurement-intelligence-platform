import { NextRequest, NextResponse } from "next/server";
import { getServiceClient, dbConfigured } from "@/lib/supabase/server";
import { getTargetingProfile } from "@/lib/targeting/profile";
import { scoreOpportunity } from "@/lib/targeting/engine";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST { batch? } — run the weighted targeting engine over stored opportunities that
 * don't yet have a pursuit score (or all of them with {force:true}), in bounded
 * batches. Loop until `done` — same pattern as the document backfill. Parsed document
 * text is included so scores reflect the real RFP requirements.
 */
export async function POST(req: NextRequest) {
  if (!dbConfigured) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const body = await req.json().catch(() => ({}) as Record<string, unknown>);
  const batch = Math.min(Math.max(Number(body.batch) || 200, 10), 400);
  const sb = getServiceClient();
  const profile = await getTargetingProfile();

  // {reset:true} → clear all buckets first so the loop re-scores the whole corpus
  // (used after the profile is edited in Admin).
  if (body.reset === true) {
    await sb.from("opportunities").update({ pursuit_bucket: null }).not("id", "is", null);
  }

  const { data: rows } = await sb
    .from("opportunities")
    .select(
      "id, title, description, category, agency, naics_code, due_date, estimated_value, " +
        "bid_recommendation, relevance_score, relevance_method, source:sources(state)",
    )
    .is("pursuit_bucket", null)
    .order("first_seen_at", { ascending: false })
    .limit(batch);
  if (!rows?.length) return NextResponse.json({ processed: 0, remaining: 0, done: true });

  // Pull parsed document text for this batch in one query (few opps have docs).
  const ids = rows.map((r) => r.id);
  const { data: atts } = await sb
    .from("attachments")
    .select("opportunity_id, parsed_text")
    .in("opportunity_id", ids)
    .not("parsed_text", "is", null);
  const docText = new Map<string, string>();
  for (const a of atts ?? []) {
    docText.set(a.opportunity_id, `${docText.get(a.opportunity_id) ?? ""}\n${a.parsed_text}`.slice(0, 30_000));
  }

  const buckets: Record<string, number> = {};
  for (const r of rows) {
    const engine = scoreOpportunity(
      {
        title: r.title,
        description: r.description,
        category: r.category,
        agency: r.agency,
        naicsCode: r.naics_code,
        docText: docText.get(r.id) ?? null,
        dueDate: r.due_date,
        estimatedValue: r.estimated_value,
        sourceState: (r as { source?: { state?: string | null } }).source?.state ?? null,
      },
      profile,
    );
    // AI-analyst promotion: re-apply the stored profile-aware LLM verdict (no new
    // tokens) — a confident BID on a thin listing lifts it into the shortlist,
    // never past an exclusion. Recorded transparently in the breakdown.
    let bucket = engine.bucket;
    let breakdown = engine.breakdown;
    const llmBid = r.relevance_method === "llm" && r.bid_recommendation === "BID";
    if (llmBid && !engine.excludedReason && (bucket === "MANUAL_REVIEW" || bucket === "IGNORE")) {
      bucket = (r.relevance_score ?? 0) >= 90 ? "PURSUE" : "CAPTURE_REVIEW";
      breakdown = [
        ...engine.breakdown,
        {
          criterion: "AI analyst promotion",
          points: 0,
          matched: ["profile-aware LLM rated BID"],
          note: `Engine scored ${engine.pursuitScore} (thin listing text); AI bid/no-bid rated BID (${r.relevance_score}/100)`,
        },
      ];
    }
    buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    await sb
      .from("opportunities")
      .update({
        pursuit_score: engine.pursuitScore,
        pursuit_bucket: bucket,
        urgency: engine.urgency,
        set_asides: engine.setAsides,
        contract_vehicle: engine.contractVehicle,
        solicitation_type: engine.solicitationType,
        agency_priority: engine.agencyPriority,
        excluded_reason: engine.excludedReason,
        score_breakdown: breakdown as unknown as Record<string, unknown>[],
      })
      .eq("id", r.id);
  }

  const { count } = await sb
    .from("opportunities")
    .select("*", { count: "exact", head: true })
    .is("pursuit_bucket", null);
  return NextResponse.json({
    processed: rows.length,
    buckets,
    remaining: count ?? 0,
    done: (count ?? 0) === 0,
  });
}
