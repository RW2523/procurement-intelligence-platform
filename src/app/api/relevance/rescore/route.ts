import { NextRequest, NextResponse } from "next/server";
import { getServiceClient, dbConfigured } from "@/lib/supabase/server";
import { getCompanySettings } from "@/lib/db/settings";
import { classifyRelevanceLLM, buildProfileFromTargeting } from "@/lib/ai/relevance";
import { getTargetingProfile } from "@/lib/targeting/profile";
import type { BidRecommendation } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

function fallbackRec(score: number | null): BidRecommendation {
  if (score == null) return "REVIEW";
  if (score >= 70) return "BID";
  if (score >= 40) return "REVIEW";
  return "NO_BID";
}

/**
 * POST { limit?, all? } — run the LLM bid/no-bid check over stored opportunities and
 * persist the verdict. By default only items not yet LLM-scored are processed (so it
 * can be looped to backfill); pass { all: true } to re-score everything. Returns how
 * many were scored and how many remain, so a caller can drive it to completion.
 */
export async function POST(req: NextRequest) {
  if (!dbConfigured) return NextResponse.json({ error: "Database not configured" }, { status: 503 });

  const body = await req.json().catch(() => ({}));
  const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 100);
  const onlyKeyword = !body.all;

  const sb = getServiceClient();
  let q = sb
    .from("opportunities")
    .select("id, title, agency, category, description, naics_code, relevance_score")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (onlyKeyword) q = q.neq("relevance_method", "llm");
  const { data: rows, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!rows?.length) return NextResponse.json({ scored: 0, fallback: 0, remaining: 0, done: true, sample: [] });

  const [targeting, company] = await Promise.all([getTargetingProfile(), getCompanySettings()]);
  const profile = buildProfileFromTargeting(company, targeting);

  const verdicts = await classifyRelevanceLLM(
    rows.map((r) => ({
      id: r.id,
      title: r.title,
      agency: r.agency,
      category: r.category,
      description: r.description,
      naicsCode: r.naics_code,
    })),
    profile,
  );

  let scored = 0;
  let fallback = 0;
  const sample: { title: string; rec: BidRecommendation; score: number }[] = [];

  for (const r of rows) {
    const v = verdicts.get(r.id);
    if (v) {
      await sb
        .from("opportunities")
        .update({
          relevance_score: v.score,
          relevance_reason: v.reason,
          bid_recommendation: v.recommendation,
          relevance_method: "llm",
        })
        .eq("id", r.id);
      scored++;
      if (sample.length < 6) sample.push({ title: (r.title ?? "").slice(0, 48), rec: v.recommendation, score: v.score });
    } else {
      // Keep moving (and never re-loop forever) even if the model skipped this row.
      await sb
        .from("opportunities")
        .update({ bid_recommendation: fallbackRec(r.relevance_score), relevance_method: "llm" })
        .eq("id", r.id);
      fallback++;
    }
  }

  let remaining = 0;
  if (onlyKeyword) {
    const { count } = await sb
      .from("opportunities")
      .select("id", { count: "exact", head: true })
      .neq("relevance_method", "llm");
    remaining = count ?? 0;
  }

  return NextResponse.json({ scored, fallback, remaining, done: remaining === 0, sample });
}
