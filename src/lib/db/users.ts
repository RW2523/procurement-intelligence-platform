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

/** The signed-in Supabase identity's email, or null if there is no valid session. */
export async function getSessionEmail(): Promise<string | null> {
  try {
    const auth = await createAuthServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    return user?.email ?? null;
  } catch {
    return null;
  }
}

/**
 * The current procurement user: the signed-in Supabase identity (SSO-aware) matched
 * to a `users` row by email. Returns null when there is no session OR when the signed-in
 * account has no procurement `users` row. It deliberately does NOT fall back to a seeded
 * admin — a cross-app SSO user without a procurement account must be treated as
 * unauthorized, not silently elevated (authorization is enforced in lib/auth/guard.ts).
 */
export async function getCurrentUser(): Promise<User | null> {
  const email = await getSessionEmail();
  if (!email) return null;
  return await getUserByEmail(email);
}
