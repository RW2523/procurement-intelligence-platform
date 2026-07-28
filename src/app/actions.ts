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
import {
  grantAccess,
  revokeAccess,
  setAccountActive,
  countActiveAdmins,
  findAccount,
  findLogin,
} from "@/lib/db/access";
import { USER_ROLES, type ConnectorType, type ResponseMode, type ResponseStatus, type UserRole } from "@/lib/types";

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
/**
 * Fill in details the spreadsheet did not carry. Writer-gated like every other
 * mutation here; the column allow-list lives in lib/bids/completeness.ts so the
 * form, the "what is missing" badge and this write can never disagree.
 */
export async function updateBidDetailsAction(oppId: string, patch: Record<string, unknown>) {
  await requireRole("writer");
  const { updateBidDetails } = await import("@/lib/db/opportunities");
  const res = await updateBidDetails(oppId, patch);
  revalidatePath(`/opportunities/${oppId}`);
  revalidatePath("/opportunities");
  revalidatePath("/my-bids");
  revalidatePath("/board");
  return res;
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

// ── Procurement access / roles (admin) ───────────────────────────────────────
// These are PRIVILEGE changes, so they get three things the rest of this file
// does not need:
//   1. requireRole("admin") — as always, but here it is the whole point.
//   2. An audit row per change (public.user_access_log), written inside
//      lib/db/access.ts so the script and the UI produce identical history.
//   3. Lockout guards. A Server Action is only reachable by POST (Next 16 —
//      docs/01-app/01-getting-started/07-mutating-data.md: "actions use the POST
//      method, and only this HTTP method can invoke them"), and it is reachable
//      by direct POST, not just through our UI — so every rule below must live
//      here on the server, never in the component that renders the buttons.
export type AccessResult = { ok: true; message: string } | { ok: false; message: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function grantAccessAction(input: {
  email: string;
  role: UserRole;
  name?: string;
  reason?: string;
}): Promise<AccessResult> {
  const me = await requireRole("admin");
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, message: "That doesn't look like an email address." };
  // The role arrives from a POST body an attacker controls, not from our <select>.
  if (!USER_ROLES.includes(input.role)) return { ok: false, message: `Unknown role "${input.role}".` };

  // Demoting yourself out of admin is the classic one-click lockout when you are
  // the only admin. Refuse rather than "confirm?" — there is no undo from the UI.
  if (email === me.email.toLowerCase() && input.role !== "admin") {
    return { ok: false, message: "You can't lower your own role. Ask another admin to do it." };
  }

  const login = await findLogin(email);
  const result = await grantAccess({
    email,
    role: input.role,
    name: input.name,
    actor: me.email,
    reason: input.reason ?? null,
  });
  revalidatePath("/admin/access");
  revalidatePath("/admin");
  revalidatePath("/", "layout");

  const noun = result.effect === "created" ? "Granted" : result.effect === "unchanged" ? "Already" : "Updated";
  const warn = login ? "" : " — note: no AJACE login exists for that address yet, so they can't sign in until the timesheet account is created.";
  return { ok: true, message: `${noun} ${email} the ${input.role} role.${warn}` };
}

export async function revokeAccessAction(input: { email: string; reason?: string }): Promise<AccessResult> {
  const me = await requireRole("admin");
  const email = input.email.trim().toLowerCase();
  if (email === me.email.toLowerCase()) {
    return { ok: false, message: "You can't revoke your own access." };
  }
  const target = await findAccount(email);
  if (!target) return { ok: false, message: `${email} has no procurement account.` };
  if (target.role === "admin" && target.is_active && (await countActiveAdmins()) <= 1) {
    return { ok: false, message: "That's the last active admin — promote someone else first." };
  }
  await revokeAccess({ email, actor: me.email, reason: input.reason ?? null });
  revalidatePath("/admin/access");
  revalidatePath("/admin");
  revalidatePath("/", "layout");
  return { ok: true, message: `Removed procurement access for ${email}. Their AJACE login still works.` };
}

export async function setAccessActiveAction(input: {
  email: string;
  active: boolean;
  reason?: string;
}): Promise<AccessResult> {
  const me = await requireRole("admin");
  const email = input.email.trim().toLowerCase();
  if (email === me.email.toLowerCase() && !input.active) {
    return { ok: false, message: "You can't deactivate your own account." };
  }
  const target = await findAccount(email);
  if (!target) return { ok: false, message: `${email} has no procurement account.` };
  if (!input.active && target.role === "admin" && target.is_active && (await countActiveAdmins()) <= 1) {
    return { ok: false, message: "That's the last active admin — promote someone else first." };
  }
  const { changed } = await setAccountActive({
    email,
    active: input.active,
    actor: me.email,
    reason: input.reason ?? null,
  });
  revalidatePath("/admin/access");
  revalidatePath("/admin");
  revalidatePath("/", "layout");
  return {
    ok: true,
    message: changed
      ? `${input.active ? "Reactivated" : "Deactivated"} ${email}.`
      : `${email} was already ${input.active ? "active" : "inactive"}.`,
  };
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
