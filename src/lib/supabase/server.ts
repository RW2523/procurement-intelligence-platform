import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config, dbConfigured } from "@/lib/config";

/**
 * Server-only Supabase client using the SERVICE ROLE key. It bypasses RLS, so it
 * must never be imported into a client component. RLS stays enabled on every
 * table; the service role is the single trusted path from our Next.js server.
 */
let _client: SupabaseClient | null = null;

export function getServiceClient(): SupabaseClient {
  if (!dbConfigured) {
    throw new Error(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and " +
        "SUPABASE_SERVICE_ROLE_KEY in .env.local.",
    );
  }
  if (!_client) {
    // RLS on every table requires the server-only x-app-secret header, so possessing
    // the (public-tier) anon key alone grants no data access — the app is the only
    // caller that sends the secret.
    const headers: Record<string, string> = { "x-application-name": "procurement-intel" };
    if (config.supabase.appDbSecret) headers["x-app-secret"] = config.supabase.appDbSecret;
    _client = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers },
    });
  }
  return _client;
}

/** Whether the DB is reachable/configured — lets the UI degrade gracefully. */
export { dbConfigured };
