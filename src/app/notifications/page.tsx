import { dbConfigured } from "@/lib/supabase/server";
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
  const notifications = await listNotifications(100);
  return (
    <>
      <PageHeader title="Notifications" subtitle="New opportunities, amendments, deadlines, Q&A windows & crawl failures" />
      <NotificationsList notifications={notifications} />
    </>
  );
}
