import { getServiceClient } from "@/lib/supabase/server";
import { getNotificationSettings } from "@/lib/db/settings";
import { daysUntil, fmtDate } from "@/lib/utils";

const OPEN_STATUSES = ["NEW", "OPEN", "AMENDED", "CLOSING_SOON"];

/**
 * Scan tracked opportunities for approaching submission and Q&A deadlines and emit
 * reminder notifications. Q&A deadlines come earlier than submission and are the
 * most expensive window to miss — they get their own reminder track.
 */
export async function scanDeadlines(): Promise<{ deadlineAlerts: number; qaAlerts: number }> {
  const sb = getServiceClient();
  const settings = await getNotificationSettings();
  const { data: opps } = await sb
    .from("opportunities")
    .select("id, title, due_date, q_and_a_deadline, status, relevance_score")
    .in("status", OPEN_STATUSES);

  let deadlineAlerts = 0;
  let qaAlerts = 0;

  for (const o of opps ?? []) {
    const dDue = daysUntil(o.due_date as string | null);
    if (dDue !== null && dDue >= 0 && settings.deadline_reminder_days.includes(dDue)) {
      if (await ensureNotif(sb, o.id, "DEADLINE", dDue)) {
        await sb.from("notifications").insert({
          type: "DEADLINE",
          title: `Due in ${dDue} day${dDue === 1 ? "" : "s"}: ${o.title}`,
          body: `Submission deadline ${fmtDate(o.due_date as string)}.`,
          opportunity_id: o.id,
          severity: dDue <= 1 ? "critical" : "warning",
        });
        deadlineAlerts++;
      }
    }
    const dQa = daysUntil(o.q_and_a_deadline as string | null);
    if (dQa !== null && dQa >= 0 && settings.qa_reminder_days.includes(dQa)) {
      if (await ensureNotif(sb, o.id, "QA_DEADLINE", dQa)) {
        await sb.from("notifications").insert({
          type: "QA_DEADLINE",
          title: `Q&A closes in ${dQa} day${dQa === 1 ? "" : "s"}: ${o.title}`,
          body: `Pre-bid question deadline ${fmtDate(o.q_and_a_deadline as string)} — submit questions before it closes.`,
          opportunity_id: o.id,
          severity: "warning",
        });
        qaAlerts++;
      }
    }
  }
  return { deadlineAlerts, qaAlerts };
}

/** True if no equivalent reminder already exists for this opp/type/day. */
async function ensureNotif(
  sb: ReturnType<typeof getServiceClient>,
  oppId: string,
  type: string,
  day: number,
): Promise<boolean> {
  const { data } = await sb
    .from("notifications")
    .select("id")
    .eq("opportunity_id", oppId)
    .eq("type", type)
    .ilike("title", `%${day} day%`)
    .limit(1);
  return !(data && data.length > 0);
}
