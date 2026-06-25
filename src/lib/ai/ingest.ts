import { getServiceClient } from "@/lib/supabase/server";
import { embed, toVectorLiteral } from "./embeddings";

function chunkText(text: string, size = 1200, overlap = 150): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= size) return clean ? [clean] : [];
  const chunks: string[] = [];
  let i = 0;
  while (i < clean.length) {
    chunks.push(clean.slice(i, i + size));
    i += size - overlap;
  }
  return chunks;
}

/**
 * Chunk a company_knowledge document, embed each chunk, and store it for RAG.
 * Idempotent: clears prior chunks first.
 */
export async function ingestKnowledge(knowledgeId: string): Promise<number> {
  const sb = getServiceClient();
  const { data: k } = await sb
    .from("company_knowledge")
    .select("id, parsed_text")
    .eq("id", knowledgeId)
    .single();
  if (!k?.parsed_text) return 0;

  await sb.from("company_knowledge_chunks").delete().eq("knowledge_id", knowledgeId);
  const chunks = chunkText(k.parsed_text as string);
  let n = 0;
  for (let i = 0; i < chunks.length; i++) {
    const vec = await embed(chunks[i]);
    const { error } = await sb.from("company_knowledge_chunks").insert({
      knowledge_id: knowledgeId,
      chunk_no: i,
      content: chunks[i],
      embedding: toVectorLiteral(vec),
    });
    if (!error) n++;
  }
  await sb.from("company_knowledge").update({ embedded: true }).eq("id", knowledgeId);
  return n;
}
