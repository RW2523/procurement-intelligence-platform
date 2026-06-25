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
    _client = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { "x-application-name": "procurement-intel" } },
    });
  }
  return _client;
}

/** Whether the DB is reachable/configured — lets the UI degrade gracefully. */
export { dbConfigured };
