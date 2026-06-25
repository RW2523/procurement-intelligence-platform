import { getServiceClient } from "@/lib/supabase/server";
import type { Notification } from "@/lib/types";

export async function listNotifications(limit = 50): Promise<Notification[]> {
  const sb = getServiceClient();
  const { data } = await sb
    .from("notifications")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as Notification[];
}

export async function unreadCount(): Promise<number> {
  const sb = getServiceClient();
  const { count } = await sb
    .from("notifications")
    .select("*", { count: "exact", head: true })
    .eq("is_read", false);
  return count ?? 0;
}

export async function markRead(id: string): Promise<void> {
  const sb = getServiceClient();
  await sb.from("notifications").update({ is_read: true }).eq("id", id);
}

export async function markAllRead(): Promise<void> {
  const sb = getServiceClient();
  await sb.from("notifications").update({ is_read: true }).eq("is_read", false);
}
