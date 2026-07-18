import { getServiceClient } from "@/lib/supabase/server";
import { createAuthServerClient } from "@/lib/supabase/auth-server";
import type { User } from "@/lib/types";

export async function listUsers(): Promise<User[]> {
  const sb = getServiceClient();
  const { data } = await sb.from("users").select("*").order("role").order("name");
  return (data ?? []) as User[];
}

export async function getUserByEmail(email: string): Promise<User | null> {
  const sb = getServiceClient();
  const { data } = await sb.from("users").select("*").eq("email", email).maybeSingle();
  return (data as User) ?? null;
}

/**
 * The current user. Prefers the signed-in Supabase identity (SSO-aware) matched to a
 * `users` row by email; falls back to the seeded admin when there is no session (e.g.
 * SITE_PASSWORD transition mode) or no matching row (single-tenant).
 */
export async function getCurrentUser(): Promise<User | null> {
  try {
    const auth = await createAuthServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    const email = user?.email;
    if (email) {
      const byEmail = await getUserByEmail(email);
      if (byEmail) return byEmail;
    }
  } catch {
    // No session / auth not configured — fall through to the legacy default.
  }
  const byEmail = await getUserByEmail("info@ajace.com");
  if (byEmail) return byEmail;
  const sb = getServiceClient();
  const { data } = await sb.from("users").select("*").eq("role", "admin").limit(1).maybeSingle();
  return (data as User) ?? null;
}
