"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/db/users";
import {
  updateOppStatus,
  assignOpportunity,
} from "@/lib/db/opportunities";
import {
  updateResponseContent,
  updateResponseStatus,
  deleteResponse,
} from "@/lib/db/responses";
import { generateResponseDraft, reviseResponse } from "@/lib/ai/generate";
import { createSource, updateSource, type NewSourceInput } from "@/lib/db/sources";
import { createKnowledge, deleteKnowledge } from "@/lib/db/knowledge";
import { ingestKnowledge } from "@/lib/ai/ingest";
import { updateSetting } from "@/lib/db/settings";
import { markAllRead, markRead } from "@/lib/db/notifications";
import { getSourceBySlug } from "@/lib/crawl/runner";
import { runCrawlForSource } from "@/lib/crawl/pipeline";
import { scanDeadlines } from "@/lib/notify/deadlines";
import type { ConnectorType, ResponseMode, ResponseStatus } from "@/lib/types";

// ── Notifications ────────────────────────────────────────────────────────────
export async function markAllReadAction() {
  await markAllRead();
  revalidatePath("/", "layout");
}
export async function markReadAction(id: string) {
  await markRead(id);
  revalidatePath("/", "layout");
}

// ── Opportunity status / stage / assignment ─────────────────────────────────
export async function setStatusAction(oppId: string, value: string, reason?: string) {
  const user = await getCurrentUser();
  await updateOppStatus(oppId, "status", value, user?.name ?? "user", reason);
  revalidatePath(`/opportunities/${oppId}`);
  revalidatePath("/opportunities");
  revalidatePath("/board");
}
export async function setStageAction(oppId: string, value: string, reason?: string) {
  const user = await getCurrentUser();
  await updateOppStatus(oppId, "pipeline_stage", value, user?.name ?? "user", reason);
  revalidatePath(`/opportunities/${oppId}`);
  revalidatePath("/board");
  revalidatePath("/opportunities");
}
export async function assignAction(oppId: string, userId: string | null) {
  await assignOpportunity(oppId, userId || null);
  revalidatePath(`/opportunities/${oppId}`);
  revalidatePath("/opportunities");
}

// ── Responses (AI) ──────────────────────────────────────────────────────────
export async function generateDraftAction(oppId: string, mode: ResponseMode) {
  const user = await getCurrentUser();
  await generateResponseDraft(oppId, mode, user?.id);
  revalidatePath(`/opportunities/${oppId}`);
}
export async function reviseAction(responseId: string, oppId: string, instruction: string) {
  const user = await getCurrentUser();
  await reviseResponse(responseId, instruction, user?.id);
  revalidatePath(`/opportunities/${oppId}`);
}
export async function saveResponseAction(responseId: string, oppId: string, content: string) {
  await updateResponseContent(responseId, content);
  revalidatePath(`/opportunities/${oppId}`);
}
export async function setResponseStatusAction(responseId: string, oppId: string, status: ResponseStatus) {
  await updateResponseStatus(responseId, status);
  revalidatePath(`/opportunities/${oppId}`);
}
export async function deleteResponseAction(responseId: string, oppId: string) {
  await deleteResponse(responseId);
  revalidatePath(`/opportunities/${oppId}`);
}

// ── Sources ──────────────────────────────────────────────────────────────────
export async function createSourceAction(input: NewSourceInput) {
  const created = await createSource(input);
  revalidatePath("/sources");
  return created;
}
export async function updateSourceAction(id: string, patch: { is_active?: boolean; schedule_cron?: string; status?: string; connector_type?: ConnectorType }) {
  await updateSource(id, patch as never);
  revalidatePath("/sources");
}

// ── Knowledge ────────────────────────────────────────────────────────────────
export async function createKnowledgeAction(input: {
  title: string;
  parsed_text: string;
  outcome?: "won" | "lost" | "unknown";
  category?: string;
  tags?: string[];
}) {
  const k = await createKnowledge(input);
  const chunks = await ingestKnowledge(k.id);
  revalidatePath("/knowledge");
  return { id: k.id, chunks };
}
export async function deleteKnowledgeAction(id: string) {
  await deleteKnowledge(id);
  revalidatePath("/knowledge");
}

// ── Settings ─────────────────────────────────────────────────────────────────
export async function updateSettingAction(key: string, value: unknown) {
  await updateSetting(key, value);
  revalidatePath("/admin");
  revalidatePath("/", "layout");
}

// ── Crawl (single source — bounded; all-sources runs via /api/crawl) ─────────
export async function runSourceCrawlAction(slug: string) {
  const source = await getSourceBySlug(slug);
  if (!source) throw new Error(`Unknown source: ${slug}`);
  const summary = await runCrawlForSource(source, { trigger: "manual" });
  await scanDeadlines();
  revalidatePath("/sources");
  revalidatePath("/opportunities");
  revalidatePath("/");
  return summary;
}
