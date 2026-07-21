import { dbConfigured } from "@/lib/supabase/server";
import { DEFAULT_COMPANY } from "@/lib/defaults";
import type { CompanySettings, Notification, User } from "@/lib/types";

export interface ShellData {
  dbConfigured: boolean;
  /** True when a Supabase session exists (regardless of whether it maps to a procurement account). */
  authed: boolean;
  company: CompanySettings;
  user: User | null;
  unread: number;
  notifications: Notification[];
}

/** Loads chrome data for the app shell; never throws (lets the app boot pre-config). */
export async function getShellData(): Promise<ShellData> {
  if (!dbConfigured) {
    return { dbConfigured: false, authed: false, company: DEFAULT_COMPANY, user: null, unread: 0, notifications: [] };
  }
  try {
    const [{ getCompanySettings }, { getSessionEmail, getUserByEmail }, { unreadCount, listNotifications }] = await Promise.all([
      import("@/lib/db/settings"),
      import("@/lib/db/users"),
      import("@/lib/db/notifications"),
    ]);
    const email = await getSessionEmail();
    const [company, user, unread, notifications] = await Promise.all([
      getCompanySettings(),
      email ? getUserByEmail(email) : Promise.resolve(null),
      unreadCount(),
      listNotifications(8),
    ]);
    return { dbConfigured: true, authed: Boolean(email), company, user, unread, notifications };
  } catch {
    return { dbConfigured: false, authed: false, company: DEFAULT_COMPANY, user: null, unread: 0, notifications: [] };
  }
}
