import { getServiceClient } from "@/lib/supabase/server";
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

/** The "current user" for this single-tenant demo — the admin by configured email. */
export async function getCurrentUser(): Promise<User | null> {
  const sb = getServiceClient();
  const byEmail = await getUserByEmail("info@ajace.com");
  if (byEmail) return byEmail;
  const { data } = await sb.from("users").select("*").eq("role", "admin").limit(1).maybeSingle();
  return (data as User) ?? null;
}
