import { dbConfigured } from "@/lib/supabase/server";
import { DEFAULT_COMPANY } from "@/lib/defaults";
import type { CompanySettings, Notification, User } from "@/lib/types";

export interface ShellData {
  dbConfigured: boolean;
  company: CompanySettings;
  user: User | null;
  unread: number;
  notifications: Notification[];
}

/** Loads chrome data for the app shell; never throws (lets the app boot pre-config). */
export async function getShellData(): Promise<ShellData> {
  if (!dbConfigured) {
    return { dbConfigured: false, company: DEFAULT_COMPANY, user: null, unread: 0, notifications: [] };
  }
  try {
    const [{ getCompanySettings }, { getCurrentUser }, { unreadCount, listNotifications }] = await Promise.all([
      import("@/lib/db/settings"),
      import("@/lib/db/users"),
      import("@/lib/db/notifications"),
    ]);
    const [company, user, unread, notifications] = await Promise.all([
      getCompanySettings(),
      getCurrentUser(),
      unreadCount(),
      listNotifications(8),
    ]);
    return { dbConfigured: true, company, user, unread, notifications };
  } catch {
    return { dbConfigured: false, company: DEFAULT_COMPANY, user: null, unread: 0, notifications: [] };
  }
}
