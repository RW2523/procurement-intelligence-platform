import Link from "next/link";
import { NoProcurementAccess } from "@/components/NoProcurementAccess";
import { getShellData } from "@/lib/shell";

/**
 * src/proxy.ts has always let `/no-access` through unauthenticated — but the
 * route did not exist, so the one path it deliberately exempted 404'd. This is
 * that page: a stable, linkable destination for "signed in, but not here", and
 * the landing spot for anyone sent a link after being told they lack access.
 *
 * Nothing REDIRECTS here. The root layout renders the same component in place of
 * whatever page a user without access asked for, so they get the explanation on
 * the URL they wanted and there is no redirect to loop on. Which also means that
 * by the time this page's own body renders, the visitor either has access or is
 * not signed in at all — both are handled below.
 */
export const dynamic = "force-dynamic";

export default async function NoAccessPage() {
  const shell = await getShellData();

  if (shell.user) {
    return (
      <div className="max-w-lg mx-auto mt-16 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center">
        <h1 className="text-lg font-semibold text-[var(--color-ink)]">You do have access</h1>
        <p className="mt-2 text-[0.9rem] text-[var(--color-faint)]">
          Signed in as {shell.user.email} with the {shell.user.role} role.
        </p>
        <Link href="/" className="btn btn-primary btn-sm mt-5 inline-flex">Go to the dashboard</Link>
      </div>
    );
  }

  return <NoProcurementAccess email={shell.email} deactivated={shell.access === "deactivated"} />;
}
