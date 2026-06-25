import { getServiceClient } from "@/lib/supabase/server";
import type {
  Attachment,
  Opportunity,
  OpportunityVersion,
  OpportunityView,
  PipelineStage,
  StatusLogEntry,
} from "@/lib/types";

export interface OppFilters {
  q?: string;
  state?: string;
  status?: string;
  stage?: string;
  sourceId?: string;
  relevanceMin?: number;
  assignedTo?: string;
  sort?: "due_date" | "relevance" | "newest";
  limit?: number;
}

const EMBED =
  "*, source:sources!opportunities_source_id_fkey(id,name,slug,state), " +
  "assignee:users!opportunities_assigned_to_fkey(id,name), " +
  "responses(count), attachments(count), opportunity_versions(count)";

function shape(row: Record<string, unknown>): OpportunityView {
  const r = row as unknown as OpportunityView & {
    responses?: { count: number }[];
    attachments?: { count: number }[];
    opportunity_versions?: { count: number }[];
  };
  return {
    ...(row as unknown as OpportunityView),
    response_count: r.responses?.[0]?.count ?? 0,
    attachment_count: r.attachments?.[0]?.count ?? 0,
    version_count: r.opportunity_versions?.[0]?.count ?? 0,
  };
}

export async function listOpportunities(filters: OppFilters = {}): Promise<OpportunityView[]> {
  const sb = getServiceClient();
  let q = sb.from("opportunities").select(EMBED);

  if (filters.status) q = q.eq("status", filters.status);
  if (filters.stage) q = q.eq("pipeline_stage", filters.stage);
  if (filters.sourceId) q = q.eq("source_id", filters.sourceId);
  if (filters.assignedTo) q = q.eq("assigned_to", filters.assignedTo);
  if (filters.relevanceMin != null) q = q.gte("relevance_score", filters.relevanceMin);
  // (state is filtered in JS below — it lives on the embedded `source` resource)
  if (filters.q) {
    const term = filters.q.replace(/[%,]/g, " ");
    q = q.or(`title.ilike.%${term}%,agency.ilike.%${term}%,external_id.ilike.%${term}%`);
  }

  if (filters.sort === "relevance") q = q.order("relevance_score", { ascending: false, nullsFirst: false });
  else if (filters.sort === "due_date") q = q.order("due_date", { ascending: true, nullsFirst: false });
  else q = q.order("first_seen_at", { ascending: false });

  q = q.limit(filters.limit ?? 300);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  let rows = ((data ?? []) as unknown as Record<string, unknown>[]).map(shape);
  // state filter on embedded resource can return nulls; drop rows whose source filtered out
  if (filters.state) rows = rows.filter((r) => r.source?.state === filters.state);
  return rows;
}

export async function getOpportunity(id: string): Promise<OpportunityView | null> {
  const sb = getServiceClient();
  const { data } = await sb.from("opportunities").select(EMBED).eq("id", id).maybeSingle();
  return data ? shape(data as unknown as Record<string, unknown>) : null;
}

export async function getAttachments(opportunityId: string): Promise<Attachment[]> {
  const sb = getServiceClient();
  const { data } = await sb
    .from("attachments")
    .select("*")
    .eq("opportunity_id", opportunityId)
    .order("created_at");
  return (data ?? []) as Attachment[];
}

export async function getVersions(opportunityId: string): Promise<OpportunityVersion[]> {
  const sb = getServiceClient();
  const { data } = await sb
    .from("opportunity_versions")
    .select("*")
    .eq("opportunity_id", opportunityId)
    .order("version_no", { ascending: false });
  return (data ?? []) as OpportunityVersion[];
}

export async function getStatusLog(opportunityId: string): Promise<StatusLogEntry[]> {
  const sb = getServiceClient();
  const { data } = await sb
    .from("opportunity_status_log")
    .select("*")
    .eq("opportunity_id", opportunityId)
    .order("changed_at", { ascending: false });
  return (data ?? []) as StatusLogEntry[];
}

export async function updateOppStatus(
  id: string,
  field: "status" | "pipeline_stage",
  value: string,
  changedBy = "user",
  reason?: string,
): Promise<void> {
  const sb = getServiceClient();
  const { data: current } = await sb.from("opportunities").select(field).eq("id", id).single();
  const old = (current as Record<string, string> | null)?.[field] ?? null;
  if (old === value) return;
  const patch: Record<string, unknown> = { [field]: value };
  if (field === "status" && ["CLOSED", "REMOVED", "CANCELLED", "AWARDED"].includes(value)) {
    patch.closed_at = new Date().toISOString();
  }
  await sb.from("opportunities").update(patch).eq("id", id);
  await sb.from("opportunity_status_log").insert({
    opportunity_id: id,
    field,
    old_value: old,
    new_value: value,
    changed_by: changedBy,
    reason: reason ?? null,
  });
}

export async function assignOpportunity(id: string, userId: string | null): Promise<void> {
  const sb = getServiceClient();
  await sb.from("opportunities").update({ assigned_to: userId }).eq("id", id);
}

/** Opportunities grouped by pipeline stage for the Kanban board. */
export async function getBoard(): Promise<Record<PipelineStage, OpportunityView[]>> {
  const rows = await listOpportunities({ sort: "due_date", limit: 500 });
  const board = {} as Record<PipelineStage, OpportunityView[]>;
  for (const r of rows) {
    (board[r.pipeline_stage] ??= []).push(r);
  }
  return board;
}
