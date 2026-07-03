import { getServiceClient } from "@/lib/supabase/server";
import { getTargetingProfile } from "./profile";
import { urgencyFor } from "./engine";

/**
 * Recompute the §10 urgency band for every scored, still-open opportunity.
 * Bands drift daily as deadlines approach (STANDARD → URGENT → INSUFFICIENT_TIME),
 * so the daily cron calls this after crawling.
 */
export async function refreshUrgencyBands(): Promise<{ updated: number }> {
  const sb = getServiceClient();
  const profile = await getTargetingProfile();
  const { data: rows } = await sb
    .from("opportunities")
    .select("id, due_date, urgency")
    .not("pursuit_bucket", "is", null)
    .not("status", "in", '("CLOSED","REMOVED","AWARDED","CANCELLED")');

  let updated = 0;
  for (const r of rows ?? []) {
    const next = urgencyFor(r.due_date, profile.dateBands);
    if (next !== r.urgency) {
      await sb.from("opportunities").update({ urgency: next }).eq("id", r.id);
      updated++;
    }
  }
  return { updated };
}
