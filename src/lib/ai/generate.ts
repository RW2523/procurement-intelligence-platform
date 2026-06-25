import { getServiceClient } from "@/lib/supabase/server";
import { getCompanySettings } from "@/lib/db/settings";
import { config } from "@/lib/config";
import { retrieveSimilar } from "./rag";
import { llmGenerate } from "./llm";
import {
  buildStyleMatchedPrompt,
  buildOriginalPrompt,
  buildRevisionPrompt,
  mockStyleMatched,
  mockOriginal,
  mockRevision,
  type OppContext,
} from "./prompts";
import type { ResponseDraft, ResponseMode } from "@/lib/types";

async function loadContext(opportunityId: string): Promise<{ ctx: OppContext; opp: Record<string, unknown> }> {
  const sb = getServiceClient();
  const { data: opp } = await sb
    .from("opportunities")
    .select("*, source:sources(name, state)")
    .eq("id", opportunityId)
    .single();
  if (!opp) throw new Error("Opportunity not found");
  const { data: atts } = await sb
    .from("attachments")
    .select("filename, parsed_text")
    .eq("opportunity_id", opportunityId);
  const attachmentsText =
    (atts ?? [])
      .map((a) => a.parsed_text)
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 6000) || null;
  const source = (opp as { source?: { name?: string; state?: string } }).source;
  const ctx: OppContext = {
    externalId: opp.external_id as string,
    title: opp.title as string,
    agency: (opp.agency as string) ?? null,
    sourceName: source?.name ?? "Portal",
    state: source?.state ?? null,
    category: (opp.category as string) ?? null,
    dueDate: opp.due_date ? new Date(opp.due_date as string).toLocaleString("en-US") : null,
    qaDeadline: opp.q_and_a_deadline ? new Date(opp.q_and_a_deadline as string).toLocaleString("en-US") : null,
    description: (opp.description as string) ?? null,
    attachmentsText,
  };
  return { ctx, opp };
}

/** Generate a Mode 1 (STYLE_MATCHED) or Mode 2 (LLM_ORIGINAL) draft and persist it. */
export async function generateResponseDraft(
  opportunityId: string,
  mode: ResponseMode,
  userId?: string,
): Promise<ResponseDraft> {
  const sb = getServiceClient();
  const company = await getCompanySettings();
  const { ctx } = await loadContext(opportunityId);

  let prompt: { system: string; user: string };
  let mock: () => string;
  if (mode === "STYLE_MATCHED") {
    const retrieved = await retrieveSimilar(`${ctx.title} ${ctx.description ?? ""}`, { k: 5 });
    prompt = buildStyleMatchedPrompt(ctx, retrieved, company);
    mock = () => mockStyleMatched(ctx, retrieved, company);
  } else {
    prompt = buildOriginalPrompt(ctx, company);
    mock = () => mockOriginal(ctx, company);
  }

  const result = await llmGenerate({
    system: prompt.system,
    user: prompt.user,
    model: config.llm.generationModel,
    mock,
  });

  const { count } = await sb
    .from("responses")
    .select("*", { count: "exact", head: true })
    .eq("opportunity_id", opportunityId)
    .eq("mode", mode);

  const { data: inserted, error } = await sb
    .from("responses")
    .insert({
      opportunity_id: opportunityId,
      mode,
      version_no: (count ?? 0) + 1,
      title: mode === "STYLE_MATCHED" ? "Style-matched draft" : "LLM-original draft",
      content: result.content,
      model_used: result.model,
      prompt_used: prompt.user.slice(0, 8000),
      status: "DRAFT",
      created_by: userId ?? null,
    })
    .select("*")
    .single();
  if (error || !inserted) throw new Error(`Failed to save response: ${error?.message}`);

  // Move the opportunity into the Drafting stage if it was earlier in the pipeline.
  await sb
    .from("opportunities")
    .update({ pipeline_stage: "DRAFTING" })
    .eq("id", opportunityId)
    .in("pipeline_stage", ["BACKLOG", "REVIEWING"]);

  return inserted as ResponseDraft;
}

/** Apply a free-text revision instruction; preserves every iteration. */
export async function reviseResponse(
  responseId: string,
  instruction: string,
  userId?: string,
): Promise<ResponseDraft> {
  const sb = getServiceClient();
  const { data: resp } = await sb.from("responses").select("*").eq("id", responseId).single();
  if (!resp) throw new Error("Response not found");
  const { ctx } = await loadContext(resp.opportunity_id as string);
  const prompt = buildRevisionPrompt(ctx, resp.content as string, instruction);
  const result = await llmGenerate({
    system: prompt.system,
    user: prompt.user,
    model: config.llm.generationModel,
    mock: () => mockRevision(resp.content as string, instruction),
  });

  const { count } = await sb
    .from("response_revisions")
    .select("*", { count: "exact", head: true })
    .eq("response_id", responseId);
  await sb.from("response_revisions").insert({
    response_id: responseId,
    revision_no: (count ?? 0) + 1,
    instruction,
    previous_content: resp.content,
    revised_content: result.content,
    model_used: result.model,
    revised_by: userId ?? null,
  });

  const { data: updated } = await sb
    .from("responses")
    .update({ content: result.content, model_used: result.model, updated_at: new Date().toISOString() })
    .eq("id", responseId)
    .select("*")
    .single();
  return updated as ResponseDraft;
}
