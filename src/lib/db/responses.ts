import { getServiceClient } from "@/lib/supabase/server";
import type { ResponseDraft, ResponseRevision, ResponseStatus } from "@/lib/types";

export async function getResponsesForOpp(opportunityId: string): Promise<ResponseDraft[]> {
  const sb = getServiceClient();
  const { data } = await sb
    .from("responses")
    .select("*")
    .eq("opportunity_id", opportunityId)
    .order("created_at", { ascending: false });
  return (data ?? []) as ResponseDraft[];
}

export async function getResponse(id: string): Promise<ResponseDraft | null> {
  const sb = getServiceClient();
  const { data } = await sb.from("responses").select("*").eq("id", id).maybeSingle();
  return (data as ResponseDraft) ?? null;
}

export async function getRevisions(responseId: string): Promise<ResponseRevision[]> {
  const sb = getServiceClient();
  const { data } = await sb
    .from("response_revisions")
    .select("*")
    .eq("response_id", responseId)
    .order("revision_no", { ascending: false });
  return (data ?? []) as ResponseRevision[];
}

export async function updateResponseContent(id: string, content: string): Promise<void> {
  const sb = getServiceClient();
  await sb.from("responses").update({ content, updated_at: new Date().toISOString() }).eq("id", id);
}

export async function updateResponseStatus(id: string, status: ResponseStatus): Promise<void> {
  const sb = getServiceClient();
  await sb.from("responses").update({ status }).eq("id", id);
  if (status === "APPROVED") {
    const { data: resp } = await sb.from("responses").select("opportunity_id, title").eq("id", id).single();
    if (resp) {
      await sb.from("notifications").insert({
        type: "RESPONSE_APPROVED",
        title: `Response approved: ${resp.title ?? "draft"}`,
        opportunity_id: resp.opportunity_id,
        severity: "info",
      });
    }
  }
}

export async function deleteResponse(id: string): Promise<void> {
  const sb = getServiceClient();
  await sb.from("responses").delete().eq("id", id);
}
