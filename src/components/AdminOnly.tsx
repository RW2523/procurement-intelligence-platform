import { Lock } from "lucide-react";
import type { User } from "@/lib/types";

/**
 * The refusal a non-admin sees on an admin screen.
 *
 * Rendered, never thrown: requireRole() raises AuthError, and with no error.tsx
 * anywhere in this app that surfaces as Next's generic error screen — which
 * looks like a bug rather than a decision. Server pages therefore check with
 * can(user, "admin") and return this; the server ACTIONS behind the screen still
 * call requireRole("admin") and still throw, because those are the real gate and
 * are reachable by direct POST without ever loading this page.
 */
export function AdminOnly({ user }: { user: User | null }) {
  return (
    <div className="max-w-lg mx-auto mt-16 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center">
      <div className="flex justify-center mb-3 text-[var(--color-faint)]">
        <Lock size={26} />
      </div>
      <h1 className="text-lg font-semibold text-[var(--color-ink)]">Administrators only</h1>
      <p className="mt-2 text-[0.9rem] text-[var(--color-faint)]">
        {user
          ? <>Your Procurement role is <span className="font-medium text-[var(--color-ink-2)]">{user.role}</span>. This screen needs <span className="font-medium text-[var(--color-ink-2)]">admin</span>.</>
          : <>You need a Procurement account with the admin role to open this screen.</>}
      </p>
    </div>
  );
}
