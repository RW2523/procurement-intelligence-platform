import { getServiceClient } from "@/lib/supabase/server";
import type { CompanyKnowledge, KnowledgeOutcome } from "@/lib/types";

export interface KnowledgeView extends CompanyKnowledge {
  chunk_count: number;
}

export async function listKnowledge(): Promise<KnowledgeView[]> {
  const sb = getServiceClient();
  const { data } = await sb
    .from("company_knowledge")
    .select("*, company_knowledge_chunks(count)")
    .order("created_at", { ascending: false });
  return (data ?? []).map((k) => ({
    ...(k as CompanyKnowledge),
    chunk_count: (k as { company_knowledge_chunks?: { count: number }[] }).company_knowledge_chunks?.[0]?.count ?? 0,
  }));
}

export async function createKnowledge(input: {
  title: string;
  parsed_text: string;
  outcome?: KnowledgeOutcome;
  category?: string;
  tags?: string[];
}): Promise<CompanyKnowledge> {
  const sb = getServiceClient();
  const { data, error } = await sb
    .from("company_knowledge")
    .insert({
      title: input.title,
      parsed_text: input.parsed_text,
      outcome: input.outcome ?? "unknown",
      category: input.category ?? null,
      tags: input.tags ?? [],
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as CompanyKnowledge;
}

export async function deleteKnowledge(id: string): Promise<void> {
  const sb = getServiceClient();
  await sb.from("company_knowledge").delete().eq("id", id);
}
