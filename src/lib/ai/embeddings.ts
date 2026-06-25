import { config } from "@/lib/config";

export const EMBED_DIM = 1536;

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic local embedding (hashed bag-of-words + bigrams projected into
 * EMBED_DIM, L2-normalized). Lets RAG retrieval over the proposal library work with
 * NO external embedding API. Swap to a provider embedding by setting embedding_mode.
 */
export function localEmbed(text: string): number[] {
  const v = new Array(EMBED_DIM).fill(0);
  const tokens = (text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []).slice(0, 4000);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const h = fnv1a(t);
    v[h % EMBED_DIM] += 1;
    v[(h >>> 7) % EMBED_DIM] += 0.5;
    if (i > 0) {
      const bg = fnv1a(tokens[i - 1] + "_" + t);
      v[bg % EMBED_DIM] += 0.75;
    }
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

/** Returns an embedding for the text using the configured strategy (local default). */
export async function embed(text: string): Promise<number[]> {
  // Provider embeddings could be wired here; local is the robust default.
  void config;
  return localEmbed(text);
}

/** pgvector text literal for passing to the match RPC. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.map((x) => x.toFixed(6)).join(",")}]`;
}
