import { NextRequest, NextResponse } from "next/server";
import { getServiceClient, dbConfigured } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth/guard";
import { getSourceBySlug } from "@/lib/crawl/runner";
import { storeUploadedDocument } from "@/lib/crawl/attachments";
import { classifyRelevanceLLM, buildProfileFromTargeting } from "@/lib/ai/relevance";
import { getTargetingProfile } from "@/lib/targeting/profile";
import { scoreOpportunity } from "@/lib/targeting/engine";
import { getCompanySettings } from "@/lib/db/settings";
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
  try { await requireRole("writer"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }
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

  // Targeting engine + LLM bid/no-bid check — same treatment as crawled items,
  // including the text of the documents just uploaded.
  let scored = false;
  try {
    const [company, targeting, { data: atts }] = await Promise.all([
      getCompanySettings(),
      getTargetingProfile(),
      sb.from("attachments").select("parsed_text").eq("opportunity_id", oppId),
    ]);
    const docText = (atts ?? []).map((a) => a.parsed_text).filter(Boolean).join("\n\n");
    const engine = scoreOpportunity(
      {
        title,
        description: normalized.description,
        category: normalized.category,
        agency: normalized.agency,
        naicsCode: normalized.naicsCode,
        docText: docText || null,
        dueDate: normalized.dueDate ?? null,
        estimatedValue,
      },
      targeting,
    );
    await sb
      .from("opportunities")
      .update({
        pursuit_score: engine.pursuitScore,
        pursuit_bucket: engine.bucket,
        urgency: engine.urgency,
        set_asides: engine.setAsides,
        contract_vehicle: engine.contractVehicle,
        solicitation_type: engine.solicitationType,
        agency_priority: engine.agencyPriority,
        excluded_reason: engine.excludedReason,
        score_breakdown: engine.breakdown as unknown as Record<string, unknown>[],
        relevance_score: Math.min(100, engine.pursuitScore),
        relevance_reason:
          engine.breakdown.filter((b) => b.points > 0).slice(0, 4).map((b) => `${b.criterion} +${b.points}`).join(" · ") ||
          "No targeting criteria matched",
        relevance_method: "engine",
      })
      .eq("id", oppId);

    const verdicts = await classifyRelevanceLLM(
      [
        {
          id: oppId,
          title,
          agency: normalized.agency,
          category: normalized.category,
          description: normalized.description || docText.slice(0, 320) || null,
          naicsCode: normalized.naicsCode,
        },
      ],
      buildProfileFromTargeting(company, targeting),
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
