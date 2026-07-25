import "server-only";
import { db } from "@/lib/db/query";
import { dbConfigured } from "@/lib/db/pg";

/**
 * Server-only data client. Formerly a Supabase service-role client; now a
 * Supabase-COMPATIBLE builder over Amazon RDS (see src/lib/db/query.ts), so the
 * ~130 existing `.from(...)` call sites keep working unchanged.
 *
 * As before, this bypasses no authorization of its own — src/lib/auth/guard.ts
 * is and always was the gate. It must never be imported into a client component.
 */
export function getServiceClient() {
  if (!dbConfigured) {
    throw new Error("DATABASE_URL is not set — the app cannot reach Postgres.");
  }
  return db();
}

/** Whether the DB is reachable/configured — lets the UI degrade gracefully. */
export { dbConfigured };
