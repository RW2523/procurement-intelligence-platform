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

/**
 * Provider embedding via an OpenAI-compatible endpoint (OpenRouter by default).
 * Returns exactly EMBED_DIM values or throws — a dimension mismatch must fail loudly
 * rather than silently corrupt the pgvector index with wrong-width rows.
 */
async function providerEmbed(text: string): Promise<number[]> {
  const { apiKey, baseUrl, model } = config.embeddings;
  const res = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, input: text }),
  });
  if (!res.ok) {
    throw new Error(
      `embeddings failed: ${res.status} ${await res.text().catch(() => "")}`,
    );
  }
  const json = (await res.json()) as { data?: { embedding: number[] }[] };
  const vec = json.data?.[0]?.embedding;
  if (!vec) throw new Error("embeddings response missing data[0].embedding");
  if (vec.length !== EMBED_DIM) {
    throw new Error(
      `embedding dim mismatch: model "${model}" returned ${vec.length}, expected ${EMBED_DIM}. ` +
        `Use a 1536-dim model (e.g. openai/text-embedding-3-small), or update EMBED_DIM ` +
        `and the vector(${EMBED_DIM}) column together.`,
    );
  }
  return vec;
}

/**
 * Returns an embedding for the text. Uses the configured provider (OpenRouter /
 * OpenAI-compatible) when an embeddings API key is set; otherwise the deterministic
 * local hash embedder (no external call).
 *
 * NOTE: switching between provider and local — or between embedding models — means
 * RE-EMBEDDING the whole corpus. Stored chunk vectors and query vectors must come from
 * the same embedder, or similarity search returns garbage.
 */
export async function embed(text: string): Promise<number[]> {
  if (config.embeddings.apiKey) return providerEmbed(text);
  return localEmbed(text);
}

/** pgvector text literal for passing to the match RPC. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.map((x) => x.toFixed(6)).join(",")}]`;
}
