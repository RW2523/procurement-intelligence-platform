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
  supabase: {
    url: env("NEXT_PUBLIC_SUPABASE_URL"),
    // Runtime DB key (server-only). All DB access is server-side; there is no browser
    // Supabase client, so the anon key is never referenced and never shipped to the client.
    serviceRoleKey: env("SUPABASE_SERVICE_ROLE_KEY"),
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
  if (!config.supabase.url) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!config.supabase.serviceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (missing.length) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}. ` +
        `Add them to .env.local (see .env.example).`,
    );
  }
}

/** True when the Supabase service role key is present (DB is usable at runtime). */
export const dbConfigured = Boolean(config.supabase.url && config.supabase.serviceRoleKey);
