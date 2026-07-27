import { getServiceClient } from "@/lib/supabase/server";
import { getNotificationSettings } from "@/lib/db/settings";
import { isDecidedStage, isSubmittedStage } from "@/lib/types";
import { daysUntil, fmtDate } from "@/lib/utils";

const OPEN_STATUSES = ["NEW", "OPEN", "AMENDED", "CLOSING_SOON"];

/**
 * `status` is the PORTAL's view of the solicitation; `pipeline_stage` is OUR
 * capture decision. A portal keeps a solicitation listed as OPEN right up to
 * its due date regardless of what we decided about it, so filtering on status
 * alone kept nagging about bids the team had explicitly parked (NO_BID) or that
 * were already over (WON / LOST). Reminders nobody can act on are how a team
 * learns to ignore the ones that matter, so the capture stage gates them too.
 *
 * Two gates, because the two reminder tracks answer different questions:
 *
 *  - Submission deadline: suppress only where no submission will ever happen —
 *    NO_BID (deliberately parked) and WON / LOST (the agency already decided).
 *    In-flight stages (SUBMITTED / ORALS / BAFO) deliberately KEEP getting
 *    these: an amendment can extend or reset the due date and a BAFO round has
 *    a real, new deadline against the same row, so muting them would suppress
 *    an actionable warning. A reminder on a bid we already sent is mildly
 *    redundant; a missed BAFO deadline loses the bid.
 *
 *  - Q&A deadline: suppress everything above PLUS the in-flight stages. The
 *    pre-bid question window exists to shape a submission that has not gone out
 *    yet; once the bid is with the agency there is nothing left for an answer to
 *    change, so the reminder is pure noise.
 *
 * Both gates fail OPEN: an unrecognised or missing stage still gets reminded.
 * `pipeline_stage` is NOT NULL DEFAULT 'IDENTIFIED' in the schema, so this only
 * matters if a future stage value lands before this file learns about it —
 * over-reminding on one row beats silently dropping a real deadline.
 */
function submissionRemindersMuted(stage: string | null): boolean {
  if (!stage) return false;
  return stage === "NO_BID" || isDecidedStage(stage);
}

function qaRemindersMuted(stage: string | null): boolean {
  if (!stage) return false;
  // isSubmittedStage covers in-flight (SUBMITTED/ORALS/BAFO) *and* decided (WON/LOST).
  return stage === "NO_BID" || isSubmittedStage(stage);
}

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
    .select("id, title, due_date, q_and_a_deadline, status, pipeline_stage, relevance_score")
    .in("status", OPEN_STATUSES);

  let deadlineAlerts = 0;
  let qaAlerts = 0;

  for (const o of opps ?? []) {
    // Filtered here rather than in SQL: a `not in (...)` predicate drops rows
    // whose pipeline_stage is NULL, which would fail CLOSED on exactly the rows
    // the comment above says must fail open.
    const stage = (o.pipeline_stage as string | null) ?? null;

    const dDue = daysUntil(o.due_date as string | null);
    if (!submissionRemindersMuted(stage) && dDue !== null && dDue >= 0 && settings.deadline_reminder_days.includes(dDue)) {
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
    if (!qaRemindersMuted(stage) && dQa !== null && dQa >= 0 && settings.qa_reminder_days.includes(dQa)) {
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
