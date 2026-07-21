"use server";

import { revalidatePath } from "next/cache";
import { requireRole, requireUser } from "@/lib/auth/guard";
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

// Authorization model (see lib/auth/guard.ts):
//   viewer   — read only (may only manage their own notifications)
//   writer   — draft/edit responses, move opportunities, add knowledge
//   approver — writer + approve/reject/delete responses
//   admin    — everything, incl. sources, settings, crawling, knowledge deletion

// ── Notifications (any signed-in procurement user, their own) ─────────────────
export async function markAllReadAction() {
  await requireUser();
  await markAllRead();
  revalidatePath("/", "layout");
}
export async function markReadAction(id: string) {
  await requireUser();
  await markRead(id);
  revalidatePath("/", "layout");
}

// ── Opportunity status / stage / assignment (writer+) ────────────────────────
export async function setStatusAction(oppId: string, value: string, reason?: string) {
  const user = await requireRole("writer");
  await updateOppStatus(oppId, "status", value, user.name ?? "user", reason);
  revalidatePath(`/opportunities/${oppId}`);
  revalidatePath("/opportunities");
  revalidatePath("/board");
}
export async function setStageAction(oppId: string, value: string, reason?: string) {
  const user = await requireRole("writer");
  await updateOppStatus(oppId, "pipeline_stage", value, user.name ?? "user", reason);
  revalidatePath(`/opportunities/${oppId}`);
  revalidatePath("/board");
  revalidatePath("/opportunities");
}
export async function assignAction(oppId: string, userId: string | null) {
  await requireRole("writer");
  await assignOpportunity(oppId, userId || null);
  revalidatePath(`/opportunities/${oppId}`);
  revalidatePath("/opportunities");
}

// ── Responses (AI) ──────────────────────────────────────────────────────────
export async function generateDraftAction(oppId: string, mode: ResponseMode) {
  const user = await requireRole("writer");
  await generateResponseDraft(oppId, mode, user.id);
  revalidatePath(`/opportunities/${oppId}`);
}
export async function reviseAction(responseId: string, oppId: string, instruction: string) {
  const user = await requireRole("writer");
  await reviseResponse(responseId, instruction, user.id);
  revalidatePath(`/opportunities/${oppId}`);
}
export async function saveResponseAction(responseId: string, oppId: string, content: string) {
  await requireRole("writer");
  await updateResponseContent(responseId, content);
  revalidatePath(`/opportunities/${oppId}`);
}
export async function setResponseStatusAction(responseId: string, oppId: string, status: ResponseStatus) {
  // Approve / reject / submit are the approver's gate; draft/in-review are writer-level.
  const isDecision = status === "APPROVED" || status === "REJECTED" || status === "SUBMITTED";
  await requireRole(isDecision ? "approver" : "writer");
  await updateResponseStatus(responseId, status);
  revalidatePath(`/opportunities/${oppId}`);
}
export async function deleteResponseAction(responseId: string, oppId: string) {
  await requireRole("approver");
  await deleteResponse(responseId);
  revalidatePath(`/opportunities/${oppId}`);
}

// ── Sources (admin) ───────────────────────────────────────────────────────────
export async function createSourceAction(input: NewSourceInput) {
  await requireRole("admin");
  const created = await createSource(input);
  revalidatePath("/sources");
  return created;
}
export async function updateSourceAction(id: string, patch: { is_active?: boolean; schedule_cron?: string; status?: string; connector_type?: ConnectorType }) {
  await requireRole("admin");
  await updateSource(id, patch as never);
  revalidatePath("/sources");
}

// ── Knowledge (add: writer+, delete: admin) ──────────────────────────────────
export async function createKnowledgeAction(input: {
  title: string;
  parsed_text: string;
  outcome?: "won" | "lost" | "unknown";
  category?: string;
  tags?: string[];
}) {
  await requireRole("writer");
  const k = await createKnowledge(input);
  const chunks = await ingestKnowledge(k.id);
  revalidatePath("/knowledge");
  return { id: k.id, chunks };
}
export async function deleteKnowledgeAction(id: string) {
  await requireRole("admin");
  await deleteKnowledge(id);
  revalidatePath("/knowledge");
}

// ── Settings (admin) ──────────────────────────────────────────────────────────
export async function updateSettingAction(key: string, value: unknown) {
  await requireRole("admin");
  await updateSetting(key, value);
  revalidatePath("/admin");
  revalidatePath("/", "layout");
}

// ── Crawl (admin — resource-intensive / operational) ─────────────────────────
export async function runSourceCrawlAction(slug: string) {
  await requireRole("admin");
  const source = await getSourceBySlug(slug);
  if (!source) throw new Error(`Unknown source: ${slug}`);
  const summary = await runCrawlForSource(source, { trigger: "manual" });
  await scanDeadlines();
  revalidatePath("/sources");
  revalidatePath("/opportunities");
  revalidatePath("/");
  return summary;
}
