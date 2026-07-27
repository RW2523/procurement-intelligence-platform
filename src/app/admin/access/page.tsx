import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { dbConfigured } from "@/lib/supabase/server";
import { can } from "@/lib/auth/guard";
import { getCurrentUser } from "@/lib/db/users";
import { listAccess, listAccessLog } from "@/lib/db/access";
import { PageHeader } from "@/components/ui";
import { AdminOnly } from "@/components/AdminOnly";
import { AccessManager } from "@/components/admin/AccessManager";
import { SetupNotice } from "@/components/SetupNotice";

/**
 * Who may use Procurement.
 *
 * THE GATE. `can(user, "admin")` decides whether the screen renders at all, and
 * it runs before any of the data below is fetched, so a non-admin never even
 * causes a read of the user list. It is a rendered refusal rather than
 * requireRole(): AuthError from a page hits Next's generic error screen (this app
 * has no error.tsx), which reads as a crash. The actual enforcement is in the
 * three server actions this page's client component calls — they re-check
 * requireRole("admin") because a Server Action is reachable by direct POST
 * whether or not this page was ever loaded.
 */
export const dynamic = "force-dynamic";

export default async function AccessPage() {
  if (!dbConfigured) {
    return (
      <>
        <PageHeader title="Access" subtitle="Who may use Procurement" />
        <SetupNotice />
      </>
    );
  }

  const me = await getCurrentUser();
  if (!me || !can(me, "admin")) return <AdminOnly user={me} />;

  const [rows, log] = await Promise.all([listAccess(), listAccessLog(40)]);

  return (
    <>
      <Link
        href="/admin"
        className="inline-flex items-center gap-1.5 text-[0.82rem] text-[var(--color-muted)] hover:text-[var(--color-ink)] mb-3"
      >
        <ArrowLeft size={15} /> Admin
      </Link>
      <PageHeader
        title="Access & roles"
        subtitle="One AJACE login covers the timesheet and this app, but Procurement needs a role on top of it. Grant that role here — viewers read, writers draft and move opportunities, approvers approve, admins configure. Revoking removes the Procurement account only; the person keeps their AJACE login and timesheet."
      />
      <AccessManager rows={rows} log={log} currentEmail={me.email} />
    </>
  );
}
