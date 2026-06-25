import { getServiceClient } from "@/lib/supabase/server";
import { embed, toVectorLiteral } from "./embeddings";

export interface RetrievedChunk {
  chunk_id: string;
  knowledge_id: string;
  title: string;
  outcome: string;
  content: string;
  similarity: number;
}

/**
 * RAG retrieval: most-similar past-proposal chunks for the given query text.
 * Mode 1 (style-matched) prefers won proposals.
 */
export async function retrieveSimilar(
  queryText: string,
  opts: { k?: number; onlyWon?: boolean } = {},
): Promise<RetrievedChunk[]> {
  const sb = getServiceClient();
  const embedding = await embed(queryText);
  const { data, error } = await sb.rpc("match_knowledge_chunks", {
    query_embedding: toVectorLiteral(embedding),
    match_count: opts.k ?? 6,
    only_won: opts.onlyWon ?? false,
  });
  if (error) return [];
  return (data as RetrievedChunk[]) ?? [];
}
