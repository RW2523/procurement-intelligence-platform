import { NextRequest, NextResponse } from "next/server";
import { getServiceClient, dbConfigured } from "@/lib/supabase/server";
import { getSourceBySlug } from "@/lib/crawl/runner";
import { storeUploadedDocument } from "@/lib/crawl/attachments";
import { classifyRelevanceLLM, buildCompanyProfile } from "@/lib/ai/relevance";
import { getCompanySettings, getRelevanceSettings } from "@/lib/db/settings";
import { contentHash } from "@/lib/crawl/hash";
import type { NormalizedOpportunity, PipelineStage } from "@/lib/types";
import { PIPELINE_STAGES } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * POST multipart/form-data — add a bid the team is already working on (Susan's
 * "current pipeline") into the same system as crawled opportunities. The bid gets
 * the full treatment: documents stored+parsed, LLM bid/no-bid check, version
 * snapshot, audit trail — and lands on the standard opportunity detail page.
 */
export async function POST(req: NextRequest) {
  if (!dbConfigured) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const sb = getServiceClient();

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });

  const str = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };

  const title = str("title");
  if (!title) return NextResponse.json({ error: "Title is required" }, { status: 400 });

  const source = await getSourceBySlug("manual");
  if (!source) return NextResponse.json({ error: "Manual source missing — run migrations" }, { status: 500 });

  const externalId = str("external_id") ?? `MANUAL-${Date.now().toString(36).toUpperCase()}`;
  const stageRaw = (str("pipeline_stage") ?? "REVIEWING").toUpperCase();
  const stage: PipelineStage = (PIPELINE_STAGES as string[]).includes(stageRaw)
    ? (stageRaw as PipelineStage)
    : "REVIEWING";
  const estRaw = str("estimated_value");
  const estimatedValue = estRaw ? Number(estRaw.replace(/[$,]/g, "")) || null : null;

  const normalized: NormalizedOpportunity = {
    externalId,
    title,
    agency: str("agency"),
    category: str("category"),
    naicsCode: str("naics_code"),
    description: str("description"),
    postedDate: str("posted_date"),
    dueDate: str("due_date"),
    qAndADeadline: str("q_and_a_deadline"),
    estimatedValue,
    detailUrl: str("detail_url"),
    statusOnSite: "manual",
  };

  // Duplicate guard on the natural key (source_id, external_id).
  const { data: dup } = await sb
    .from("opportunities")
    .select("id")
    .eq("source_id", source.id)
    .eq("external_id", externalId)
    .maybeSingle();
  if (dup) {
    return NextResponse.json(
      { error: `A bid with number "${externalId}" already exists in My Bids`, id: dup.id },
      { status: 409 },
    );
  }

  const { data: inserted, error } = await sb
    .from("opportunities")
    .insert({
      source_id: source.id,
      external_id: externalId,
      title,
      agency: normalized.agency,
      category: normalized.category,
      naics_code: normalized.naicsCode,
      description: normalized.description,
      posted_date: normalized.postedDate ? normalized.postedDate.slice(0, 10) : null,
      due_date: normalized.dueDate,
      q_and_a_deadline: normalized.qAndADeadline,
      estimated_value: estimatedValue,
      detail_url: normalized.detailUrl,
      status: "OPEN",
      pipeline_stage: stage,
      content_hash: contentHash(normalized),
    })
    .select("id")
    .single();
  if (error || !inserted) {
    return NextResponse.json({ error: `Failed to save bid: ${error?.message}` }, { status: 500 });
  }
  const oppId = inserted.id as string;

  await sb.from("opportunity_versions").insert({
    opportunity_id: oppId,
    version_no: 1,
    snapshot_json: normalized as unknown as Record<string, unknown>,
    content_hash: contentHash(normalized),
    change_summary: "Uploaded by team (current pipeline)",
  });
  await sb.from("opportunity_status_log").insert({
    opportunity_id: oppId,
    field: "status",
    old_value: null,
    new_value: "OPEN",
    changed_by: str("added_by") ?? "team",
    reason: "Bid uploaded manually — existing pipeline",
  });

  // Store uploaded documents (bytes + extracted text → same as crawled docs).
  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  let stored = 0;
  let tooLarge = 0;
  for (const f of files.slice(0, 12)) {
    const buf = Buffer.from(await f.arrayBuffer());
    const r = await storeUploadedDocument(oppId, f.name || "document", buf, f.type || "");
    if (r === "stored") stored++;
    else tooLarge++;
  }

  // LLM bid/no-bid check against the company profile (same as crawled items).
  let scored = false;
  try {
    const [company, rel] = await Promise.all([getCompanySettings(), getRelevanceSettings()]);
    const verdicts = await classifyRelevanceLLM(
      [
        {
          id: oppId,
          title,
          agency: normalized.agency,
          category: normalized.category,
          description: normalized.description,
          naicsCode: normalized.naicsCode,
        },
      ],
      buildCompanyProfile(company, rel),
    );
    const v = verdicts.get(oppId);
    if (v) {
      await sb
        .from("opportunities")
        .update({
          relevance_score: v.score,
          relevance_reason: v.reason,
          bid_recommendation: v.recommendation,
          relevance_method: "llm",
        })
        .eq("id", oppId);
      scored = true;
    }
  } catch {
    /* scoring is best-effort; the bid is already saved */
  }

  // Mark documents checked so backfills skip this manual bid.
  await sb.from("opportunities").update({ documents_checked_at: new Date().toISOString() }).eq("id", oppId);

  return NextResponse.json({ id: oppId, externalId, documents: { stored, tooLarge }, scored });
}
