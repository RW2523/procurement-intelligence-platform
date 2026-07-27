import { dbConfigured } from "@/lib/supabase/server";
import { DEFAULT_COMPANY } from "@/lib/defaults";
import type { CompanySettings, Notification, User } from "@/lib/types";

/**
 * Why the shell reports an access STATE and not just a user:
 * "no procurement account" and "account deactivated" both resolve to
 * `user: null` (getCurrentUser() drops inactive accounts, exactly as the guard
 * does), but they need different words on screen — the second one is not
 * something an administrator forgot to do.
 */
export type AccessState = "ok" | "none" | "deactivated";

export interface ShellData {
  dbConfigured: boolean;
  /** True when a valid shared AJACE session exists (regardless of whether it maps to a procurement account). */
  authed: boolean;
  company: CompanySettings;
  /** The procurement account, or null when there isn't a usable one. */
  user: User | null;
  /** The signed-in identity's email, even when they have no procurement account. */
  email: string | null;
  access: AccessState;
  unread: number;
  notifications: Notification[];
}

const EMPTY: ShellData = {
  dbConfigured: false,
  authed: false,
  company: DEFAULT_COMPANY,
  user: null,
  email: null,
  access: "none",
  unread: 0,
  notifications: [],
};

/** Loads chrome data for the app shell; never throws (lets the app boot pre-config). */
export async function getShellData(): Promise<ShellData> {
  if (!dbConfigured) return EMPTY;
  try {
    const [{ getCompanySettings }, { getSessionEmail, getUserByEmail }] = await Promise.all([
      import("@/lib/db/settings"),
      import("@/lib/db/users"),
    ]);
    const email = await getSessionEmail();
    const [company, account] = await Promise.all([
      getCompanySettings(),
      email ? getUserByEmail(email) : Promise.resolve(null),
    ]);
    // Mirror getCurrentUser() exactly: an inactive account is not an account.
    // Resolving the shell more leniently than the guard is how a suspended user
    // ends up with a full sidebar and a role badge over screens that then refuse
    // every action they take.
    const user = account && account.is_active ? account : null;
    const access: AccessState = !email ? "none" : account ? (account.is_active ? "ok" : "deactivated") : "none";

    // WHO you are is settled above; only now is it safe to load procurement DATA.
    // Notifications are not scoped to a person — listNotifications() reads the
    // whole table — so fetching them alongside the account lookup handed every
    // signed-in timesheet employee a populated tray (opportunity titles, bodies,
    // crawl failures, deadlines and /opportunities/<id> links) on top of the
    // "you don't have access" screen, serialized into the RSC payload whether or
    // not the tray was ever opened. The gate is this early return, not the
    // rendering: data that is never fetched cannot be shipped.
    if (!user) {
      return {
        dbConfigured: true,
        authed: Boolean(email),
        company,
        user: null,
        email,
        access,
        unread: 0,
        notifications: [],
      };
    }
    const { unreadCount, listNotifications } = await import("@/lib/db/notifications");
    const [unread, notifications] = await Promise.all([unreadCount(), listNotifications(8)]);
    return { dbConfigured: true, authed: Boolean(email), company, user, email, access, unread, notifications };
  } catch {
    return EMPTY;
  }
}
