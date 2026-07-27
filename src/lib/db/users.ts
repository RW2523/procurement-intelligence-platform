import { getServiceClient } from "@/lib/supabase/server";
import { readSession } from "@/lib/auth/session";
import { sql } from "@/lib/db/pg";
import type { User } from "@/lib/types";

export async function listUsers(): Promise<User[]> {
  const sb = getServiceClient();
  const { data } = await sb.from("users").select("*").order("role").order("name");
  return (data ?? []) as User[];
}

export async function getUserByEmail(email: string): Promise<User | null> {
  // EXACT match, never a pattern. This resolves a shared-session email to a
  // procurement account and therefore to a ROLE, so `.ilike()` here made the
  // session email a LIKE pattern: an address containing % or _ would match
  // somebody else's row and inherit their role. Case-insensitivity comes from
  // lower(email) — backed by users_email_lower_idx — not from a wildcard match.
  const rows = await sql<User>(
    `select * from public.users where lower(email) = lower($1) limit 1`,
    [email],
  );
  return rows[0] ?? null;
}

/** The signed-in identity's email (from the shared session), or null. */
export async function getSessionEmail(): Promise<string | null> {
  const claims = await readSession();
  if (!claims) return null;
  // The session is stateless, so confirm the account still exists and that the
  // token was not issued before a password reset / "sign out everywhere".
  const rows = await sql<{ email: string }>(
    `select u.email from public.auth_users u
      where u.id = $1 and u.session_version = $2`,
    [claims.id, claims.sv],
  );
  return rows[0]?.email ?? null;
}

/**
 * The current procurement user: the signed-in Supabase identity (SSO-aware) matched
 * to a `users` row by email. Returns null when there is no session OR when the signed-in
 * account has no procurement `users` row. It deliberately does NOT fall back to a seeded
 * admin — a cross-app SSO user without a procurement account must be treated as
 * unauthorized, not silently elevated (authorization is enforced in lib/auth/guard.ts).
 *
 * An account with is_active = false is treated as NO account. Without this the
 * column was decorative: "deactivate" wrote a boolean nobody read, so a suspended
 * user kept their full role. Deactivating must revoke on the next request, the
 * same way the timesheet's currentUser() drops ts_profiles.active = false.
 */
export async function getCurrentUser(): Promise<User | null> {
  const email = await getSessionEmail();
  if (!email) return null;
  const user = await getUserByEmail(email);
  if (!user || !user.is_active) return null;
  return user;
}
