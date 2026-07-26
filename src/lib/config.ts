/**
 * Central runtime configuration. Reads from environment; nothing secret is ever
 * sent to the browser (all consumers of the secret values are server-only).
 */

function env(key: string, fallback = ""): string {
  const v = process.env[key] ?? fallback;
  // Treat unfilled .env placeholders ("PASTE_…_HERE") as empty.
  return v.startsWith("PASTE_") ? "" : v;
}

export const config = {
  db: {
    // Amazon RDS. No Supabase: identity comes from the shared AJACE session
    // (see lib/auth/session.ts) and data from lib/db/query.ts.
    url: env("DATABASE_URL"),
  },
  llm: {
    apiKey: env("OPENROUTER_API_KEY"),
    baseUrl: env("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
    generationModel: env("LLM_GENERATION_MODEL", "openai/gpt-4o"),
    draftModel: env("LLM_DRAFT_MODEL", "openai/gpt-4o-mini"),
    summaryModel: env("LLM_SUMMARY_MODEL", "openai/gpt-4o-mini"),
    /** When false the deterministic mock generator is used (no key configured). */
    get live() {
      return Boolean(env("OPENROUTER_API_KEY"));
    },
  },
  embeddings: {
    // OpenRouter now serves an OpenAI-compatible /embeddings endpoint, so the same
    // OpenRouter key/gateway powers embeddings. Blank ⇒ the deterministic local hash
    // embedder is used instead (no external call). Must stay a 1536-dim model to match
    // the vector(1536) column + EMBED_DIM (e.g. openai/text-embedding-3-small).
    apiKey: env("OPENROUTER_API_KEY"),
    baseUrl: env("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
    model: env("EMBEDDING_MODEL", "openai/text-embedding-3-small"),
  },
  crawl: {
    userAgent: env(
      "CRAWL_USER_AGENT",
      "AJACE-ProcurementBot/1.0 (+contact info@ajace.com)",
    ),
    requestTimeoutMs: 45_000,
  },
} as const;

export function assertServerConfig() {
  const missing: string[] = [];
  if (!config.db.url) missing.push("DATABASE_URL");
  if (missing.length) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}. ` +
        `Add them to .env.local (see .env.example).`,
    );
  }
}

/** True when the Supabase service role key is present (DB is usable at runtime). */
export const dbConfigured = Boolean(config.db.url);
