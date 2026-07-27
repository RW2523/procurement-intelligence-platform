import { ShieldAlert } from "lucide-react";

/**
 * What a person sees when they hold a valid AJACE login but no procurement
 * account (or a deactivated one).
 *
 * This is a RENDERED PAGE, deliberately not a redirect. src/proxy.ts already
 * lets everyone with a valid cookie through — it cannot tell whether they have
 * procurement access without a database round-trip on every request — so the
 * decision lands here. Redirecting from a layout to a page that is itself inside
 * that layout is how this turns into a loop; and letting requireRole() throw
 * from a page turns it into the default error screen, since this app has no
 * error.tsx. So: render, plainly, and say what to do next.
 */
export function NoProcurementAccess({
  email,
  deactivated = false,
}: {
  email?: string | null;
  deactivated?: boolean;
}) {
  return (
    <div className="max-w-lg mx-auto mt-16 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center">
      <div className="flex justify-center mb-3 text-[var(--color-amber-700)]">
        <ShieldAlert size={28} />
      </div>
      <h1 className="text-lg font-semibold text-[var(--color-ink)]">
        You don&apos;t have access to Procurement
      </h1>
      <p className="mt-2 text-[0.9rem] text-[var(--color-faint)]">
        {deactivated ? (
          <>Your Procurement account has been deactivated.</>
        ) : (
          <>
            You&apos;re signed in to AJACE{email ? <> as <span className="font-medium text-[var(--color-ink-2)]">{email}</span></> : null},
            but this app needs a separate Procurement role on top of that login.
          </>
        )}
      </p>
      <p className="mt-3 text-[0.85rem] text-[var(--color-muted)]">
        Ask an administrator to grant you access from <span className="font-mono text-[0.8rem]">Admin → Access</span>.
        Your timesheet is unaffected — it keeps working normally.
      </p>
    </div>
  );
}
