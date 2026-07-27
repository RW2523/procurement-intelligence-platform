import "server-only";
import { sql, transaction, type Query } from "./pg";
import type { User, UserRole } from "@/lib/types";

/**
 * Procurement ACCESS management — the grant/revoke layer behind /admin/access
 * and scripts/grant-procurement-access.mts.
 *
 * The model, restated because it is easy to get wrong:
 *   public.auth_users  — the AJACE login, owned by the TIMESHEET app. Identity.
 *   public.users       — the PROCUREMENT account. Authorization.
 * Having the first is what the shared cookie proves (src/proxy.ts). Having the
 * second, with a role, is what lets you use this app (src/lib/auth/guard.ts).
 * "Granting procurement access" therefore means: create/keep a public.users row
 * for an email that already logs in via the timesheet.
 *
 * Every mutation here writes public.user_access_log. That table is the audit
 * trail for privilege changes, in the same append-only old_value/new_value shape
 * as opportunity_status_log. Callers MUST have been through requireRole("admin")
 * first — nothing in this file authorizes anything on its own.
 *
 * ATOMICITY: the privilege change and its audit row go in ONE transaction(), so
 * the two outcomes are "changed and logged" or "neither". They used to be two
 * autocommitted statements, which meant a failing audit insert left the change
 * applied, unrecorded, and reported to the caller as a failure — `npm run access
 * -- revoke sam@ajace.com --yes` really did delete the account and then throw,
 * and the UI rendered that throw as "That change was refused." Anything added
 * here must keep writing through the transaction's `q`, never the bare `sql()`.
 */

export type AccessAction = "GRANT" | "ROLE_CHANGE" | "REVOKE" | "DEACTIVATE" | "REACTIVATE";

/** One person, as seen by the access screen: login side + procurement side. */
export interface AccessRow {
  email: string;
  /** Procurement account, or null when they can log in but have no access here. */
  user_id: string | null;
  name: string | null;
  role: UserRole | null;
  is_active: boolean | null;
  /** True when the address exists in the timesheet's auth_users. */
  has_login: boolean;
  /** The timesheet's own role ('employee' | 'admin') — context only, not used to authorize. */
  timesheet_role: string | null;
}

export interface AccessLogRow {
  id: string;
  target_email: string;
  action: AccessAction;
  old_value: string | null;
  new_value: string | null;
  actor: string;
  reason: string | null;
  changed_at: string;
}

const normalize = (email: string) => email.trim().toLowerCase();

/**
 * Everyone who can sign in OR already has procurement access.
 *
 * FULL OUTER JOIN on lower(email) deliberately: an admin has to be able to see —
 * and grant to — people who hold an AJACE login but no procurement row yet, which
 * is precisely the set an inner join hides. Ordered access-holders first.
 *
 * Falls back to procurement-only if auth_users is unreachable (a standalone dev
 * database without the timesheet schema), so the screen degrades instead of 500ing.
 */
export async function listAccess(): Promise<AccessRow[]> {
  try {
    return await sql<AccessRow>(
      `select coalesce(u.email, a.email)                   as email,
              u.id                                          as user_id,
              u.name,
              u.role,
              u.is_active,
              (a.id is not null)                            as has_login,
              a.role                                        as timesheet_role
         from public.users u
         full outer join public.auth_users a
           on lower(a.email) = lower(u.email)
        order by (u.id is null),
                 case u.role when 'admin' then 1 when 'approver' then 2
                             when 'writer' then 3 when 'viewer' then 4 else 5 end,
                 lower(coalesce(u.name, u.email, a.email))`,
    );
  } catch {
    const rows = await sql<User>(`select * from public.users order by role, name`);
    return rows.map((u) => ({
      email: u.email,
      user_id: u.id,
      name: u.name,
      role: u.role,
      is_active: u.is_active,
      has_login: false,
      timesheet_role: null,
    }));
  }
}

/** The most recent privilege changes, newest first — rendered under the grid. */
export async function listAccessLog(limit = 40): Promise<AccessLogRow[]> {
  return await sql<AccessLogRow>(
    `select * from public.user_access_log order by changed_at desc limit $1`,
    [Math.max(1, Math.min(200, limit))],
  );
}

/** The timesheet login for an address, if there is one. */
export async function findLogin(email: string): Promise<{ id: string; email: string } | null> {
  try {
    const rows = await sql<{ id: string; email: string }>(
      `select id, email from public.auth_users where lower(email) = $1 limit 1`,
      [normalize(email)],
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

/** The procurement account for an address, if there is one. */
export async function findAccount(email: string): Promise<User | null> {
  const rows = await sql<User>(
    `select * from public.users where lower(email) = $1 limit 1`,
    [normalize(email)],
  );
  return rows[0] ?? null;
}

/** How many admins could actually administer right now. Guards the last-admin rule. */
export async function countActiveAdmins(): Promise<number> {
  const rows = await sql<{ n: string }>(
    `select count(*)::text as n from public.users where role = 'admin' and is_active`,
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Append one audit row. `q` defaults to a standalone statement, but every
 * mutation below passes its transaction's querier so the log lands (or rolls
 * back) with the privilege change it describes.
 */
export async function logAccessChange(
  entry: {
    targetEmail: string;
    action: AccessAction;
    oldValue?: string | null;
    newValue?: string | null;
    actor: string;
    reason?: string | null;
  },
  q: Query = sql,
): Promise<void> {
  await q(
    `insert into public.user_access_log (target_email, action, old_value, new_value, actor, reason)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      normalize(entry.targetEmail),
      entry.action,
      entry.oldValue ?? null,
      entry.newValue ?? null,
      entry.actor,
      entry.reason ?? null,
    ],
  );
}

export interface GrantResult {
  user: User;
  /** What actually happened, so callers can report it honestly rather than always saying "granted". */
  effect: "created" | "role_changed" | "reactivated" | "unchanged";
}

/**
 * Grant procurement access to `email` at `role`, creating the account if needed.
 * Idempotent: re-running with the same role is a no-op that reports "unchanged".
 *
 * `on conflict (email)` is the concurrency guard — two admins clicking at once
 * must not produce two rows for one person, and the unique index on email plus
 * users_email_lower_idx make that impossible at the database level rather than
 * relying on the read-then-write above being atomic.
 */
export async function grantAccess(args: {
  email: string;
  role: UserRole;
  name?: string | null;
  actor: string;
  reason?: string | null;
}): Promise<GrantResult> {
  const email = normalize(args.email);
  const existing = await findAccount(email);

  if (existing) {
    const sameRole = existing.role === args.role;
    const alreadyActive = existing.is_active;
    if (sameRole && alreadyActive) return { user: existing, effect: "unchanged" };

    return await transaction(async (q) => {
      const rows = await q<User>(
        `update public.users
            set role = $2, is_active = true, updated_at = now()
          where id = $1
          returning *`,
        [existing.id, args.role],
      );
      // Another admin revoked them between the read above and this write. Throw
      // rather than return undefined-as-User: the rollback means nothing was
      // changed and nothing was logged, which is what the caller will be told.
      if (!rows[0]) throw new Error(`${email} no longer has a procurement account — nothing was changed.`);
      const effect: GrantResult["effect"] = sameRole ? "reactivated" : "role_changed";
      await logAccessChange(
        {
          targetEmail: email,
          action: sameRole ? "REACTIVATE" : "ROLE_CHANGE",
          oldValue: alreadyActive ? existing.role : `${existing.role} (inactive)`,
          newValue: args.role,
          actor: args.actor,
          reason: args.reason,
        },
        q,
      );
      return { user: rows[0], effect };
    });
  }

  // No procurement row yet. Keep the two sides in step: prefer the login's own
  // spelling of the address so the join in listAccess() lines up exactly.
  // Deliberately BEFORE the transaction: findLogin() swallows the error from a
  // database with no auth_users, and inside a transaction that caught error
  // would still have aborted it, failing the insert below with "current
  // transaction is aborted".
  const login = await findLogin(email);
  const name = (args.name?.trim() || null) ?? null;
  const fallbackName = name || email.split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  return await transaction(async (q) => {
    const rows = await q<User>(
      `insert into public.users (name, email, role)
       values ($1, $2, $3)
       on conflict (email) do update set role = excluded.role, is_active = true, updated_at = now()
       returning *`,
      [fallbackName, login?.email ?? email, args.role],
    );
    await logAccessChange(
      {
        targetEmail: email,
        action: "GRANT",
        oldValue: null,
        newValue: args.role,
        actor: args.actor,
        reason: args.reason,
      },
      q,
    );
    return { user: rows[0], effect: "created" };
  });
}

/**
 * Remove the procurement account entirely.
 *
 * DELETE, not deactivate — this is the true "revoke". Their AJACE login is
 * untouched; they simply stop having a procurement account and land on the
 * "no access" page. FKs that point at users (opportunities.assigned_to,
 * responses.created_by, …) are all `on delete set null`, so history survives.
 */
export async function revokeAccess(args: {
  email: string;
  actor: string;
  reason?: string | null;
}): Promise<{ removed: boolean; previousRole: UserRole | null }> {
  const email = normalize(args.email);

  return await transaction(async (q) => {
    // `returning *` instead of a separate findAccount(): the role recorded in
    // the audit row is then provably the role the delete actually removed.
    const rows = await q<User>(
      `delete from public.users where lower(email) = $1 returning *`,
      [email],
    );
    const removed = rows[0];
    if (!removed) return { removed: false, previousRole: null };

    await logAccessChange(
      {
        targetEmail: email,
        action: "REVOKE",
        oldValue: removed.role,
        newValue: null,
        actor: args.actor,
        reason: args.reason,
      },
      q,
    );
    return { removed: true, previousRole: removed.role };
  });
}

/**
 * Suspend (or restore) an account without deleting it — the reversible form of
 * revoke, and the one to use for someone on leave. getCurrentUser() treats an
 * inactive account as no account at all.
 */
export async function setAccountActive(args: {
  email: string;
  active: boolean;
  actor: string;
  reason?: string | null;
}): Promise<{ changed: boolean }> {
  const email = normalize(args.email);

  return await transaction(async (q) => {
    // No row back means either no account or it was already in that state —
    // both are "changed: false", exactly as the read-then-write version reported.
    const rows = await q<User>(
      `update public.users
          set is_active = $2, updated_at = now()
        where lower(email) = $1
          and is_active is distinct from $2
        returning *`,
      [email, args.active],
    );
    if (!rows[0]) return { changed: false };

    await logAccessChange(
      {
        targetEmail: email,
        action: args.active ? "REACTIVATE" : "DEACTIVATE",
        // The update only matched because the state differed, so the old value
        // is necessarily the opposite of the new one.
        oldValue: args.active ? "inactive" : "active",
        newValue: args.active ? "active" : "inactive",
        actor: args.actor,
        reason: args.reason,
      },
      q,
    );
    return { changed: true };
  });
}
