import { dbConfigured } from "@/lib/supabase/server";
import { getCurrentUser } from "@/lib/db/users";
import { listNotifications } from "@/lib/db/notifications";
import { PageHeader } from "@/components/ui";
import { NotificationsList } from "@/components/notifications/NotificationsList";
import { SetupNotice } from "@/components/SetupNotice";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  if (!dbConfigured) {
    return (
      <>
        <PageHeader title="Notifications" subtitle="New opportunities, amendments, deadlines & crawl failures" />
        <SetupNotice />
      </>
    );
  }
  // A layout cannot stop a page from rendering. The root layout swaps
  // <NoProcurementAccess/> in for `children`, but Next still renders this
  // segment and streams its props into the RSC payload — verified: requesting
  // /notifications as a signed-in timesheet employee with no procurement
  // account returned the access-denied screen with all 100 notification rows
  // (titles, bodies, opportunity ids) in the flight data. So the page checks for
  // itself. Return null rather than throwing: the layout is already rendering
  // the explanation, and this app has no error.tsx for an AuthError to land in.
  if (!(await getCurrentUser())) return null;
  const notifications = await listNotifications(100);
  return (
    <>
      <PageHeader title="Notifications" subtitle="New opportunities, amendments, deadlines, Q&A windows & crawl failures" />
      <NotificationsList notifications={notifications} />
    </>
  );
}
