import "server-only";
import type { ReactElement, ReactNode } from "react";
import Link from "next/link";
import { Lock, LogIn, ShieldAlert } from "lucide-react";
import { can } from "@/lib/auth/guard";
import { dbConfigured } from "@/lib/db/pg";
import { getSessionEmail, getUserByEmail } from "@/lib/db/users";
import { NoProcurementAccess } from "@/components/NoProcurementAccess";
import { SetupNotice } from "@/components/SetupNotice";
import type { User, UserRole } from "@/lib/types";

/**
 * The per-ROUTE authorization gate for server pages.
 *
 * WHY THIS EXISTS. Authorization used to live in exactly one place: a ternary in
 * the root layout (`shell.authed && !shell.user ? <NoProcurementAccess/> : children`).
 * Every data page relied on it and none checked anything itself. That is not a
 * gate, for two independent reasons:
 *
 *  0. Swapping `children` out in a layout does not reliably prevent the page
 *     segment from rendering: src/app/notifications/page.tsx records a verified
 *     case where the refusal screen was returned with all 100 notification rows
 *     still in the flight payload.
 *  1. Layouts do not re-render on navigation. Next's own guidance says so —
 *     node_modules/next/dist/docs/01-app/02-guides/authentication.md:1350 ("be
 *     cautious when doing checks in Layouts as these don't re-render on
 *     navigation, meaning the user session won't be checked on every route
 *     change") and :1446 ("A common pattern in SPAs is to `return null` in a
 *     layout ... This pattern is **not recommended**"). The Sidebar renders its
 *     nine non-admin links for a user with no procurement account, so one click
 *     — or just Link prefetch — fetches the page segment on its own, without the
 *     root layout, and the page body runs and serialises real data.
 *  2. The ternary rendered `children` whenever `shell.authed` was false, and
 *     `authed` is false in more cases than "signed out": getShellData() swallows
 *     any error and returns EMPTY, and getSessionEmail() returns null when the
 *     session_version no longer matches (password reset / "sign out everywhere")
 *     while src/proxy.ts — which only verifies the JWT signature — still lets the
 *     request through. A revoked session therefore went from "no access" to
 *     "full read of every page".
 *
 * So the check moved to the routes, as close to the data as this codebase allows.
 * Call it at the top of every server page (after the page's own `dbConfigured`
 * branch, so the un-configured experience is unchanged):
 *
 *     const { deny } = await pageGate();
 *     if (deny) return deny;
 *
 * or, when the page needs the user:
 *
 *     const gate = await pageGate();
 *     if (!gate.ok) return gate.deny;
 *     gate.user.role // ...
 *
 * It RENDERS a refusal rather than throwing or redirecting, matching how
 * /admin already refuses: this app has no error.tsx (AuthError would surface as
 * Next's generic error screen) and redirecting to a route inside the same layout
 * is how this turns into a loop. Server actions and route handlers keep using
 * requireUser()/requireRole() from lib/auth/guard.ts — they are reachable by
 * direct POST and must still throw.
 */
export type PageAccess =
  | { ok: true; user: User; deny: null }
  | { ok: false; user: null; deny: ReactElement };

export async function pageGate(min: UserRole = "viewer"): Promise<PageAccess> {
  const denied = (deny: ReactElement): PageAccess => ({ ok: false, user: null, deny });

  // No database means no data to protect — let the page show its setup notice.
  if (!dbConfigured) return denied(<SetupNotice />);

  let email: string | null = null;
  let account: User | null = null;
  try {
    // Deliberately NOT getCurrentUser(): it collapses "no session" and "no
    // procurement account" into one null, and those need different words.
    email = await getSessionEmail();
    account = email ? await getUserByEmail(email) : null;
  } catch (err) {
    // A database hiccup must not become an open door. This is the specific
    // failure the old layout gate turned into full access (getShellData()
    // catches everything and reports authed: false).
    console.error("[auth] pageGate could not verify access:", err);
    return denied(<CheckFailed />);
  }

  if (!email) return denied(<SignInRequired />);
  if (!account || !account.is_active) {
    return denied(<NoProcurementAccess email={email} deactivated={!!account} />);
  }
  if (!can(account, min)) return denied(<InsufficientRole user={account} min={min} />);
  return { ok: true, user: account, deny: null };
}

/* ---------------------------------------------------------------- refusals */

function Panel({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="max-w-lg mx-auto mt-16 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center">
      <div className="flex justify-center mb-3 text-[var(--color-faint)]">{icon}</div>
      <h1 className="text-lg font-semibold text-[var(--color-ink)]">{title}</h1>
      <div className="mt-2 text-[0.9rem] text-[var(--color-faint)]">{children}</div>
    </div>
  );
}

/**
 * Shown when there is no CURRENT session. Usually the proxy has already
 * redirected, so in practice this is the revoked-session case: a cookie whose
 * signature still verifies but whose session_version was bumped by a password
 * reset or "sign out everywhere".
 */
export function SignInRequired() {
  const loginUrl = process.env.NEXT_PUBLIC_LOGIN_URL || "/login";
  return (
    <Panel icon={<LogIn size={26} />} title="Your session has ended">
      <p>Sign in again with your AJACE account to open Procurement.</p>
      <Link href={loginUrl} className="btn btn-primary btn-sm mt-5 inline-flex">
        Go to sign in
      </Link>
    </Panel>
  );
}

function CheckFailed() {
  return (
    <Panel icon={<ShieldAlert size={26} />} title="Couldn’t verify your access">
      <p>
        The access check could not reach the database, so this page is not being shown. Reload in a
        moment; if it keeps happening, tell an administrator.
      </p>
    </Panel>
  );
}

function InsufficientRole({ user, min }: { user: User; min: UserRole }) {
  return (
    <Panel icon={<Lock size={26} />} title="You don’t have access to this screen">
      <p>
        Your Procurement role is{" "}
        <span className="font-medium text-[var(--color-ink-2)]">{user.role}</span>. This screen needs{" "}
        <span className="font-medium text-[var(--color-ink-2)]">{min}</span> or higher.
      </p>
    </Panel>
  );
}
