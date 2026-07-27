import { getServiceClient } from "@/lib/supabase/server";
import type { ForecastOpportunity } from "@/lib/types";

/**
 * The "Forecased Opportunities" [sic] sheet: agency forecast entries that have
 * not been solicited yet. Its own table rather than a flag on `opportunities` —
 * a forecast item has no solicitation number, no source, no due date, no status
 * and no stage, every one of which is not-null or CHECK-constrained there.
 */

export interface ForecastRow extends ForecastOpportunity {
  /** Set when the forecast has been promoted into a real pursuit. */
  promoted?: { id: string; title: string; external_id: string } | null;
}

/**
 * Returns forecast rows soonest-first, or `null` when the table does not exist.
 *
 * The null case is not paranoia: `forecast_opportunities` is created by
 * deploy/db/migrations/001-pipeline-2026.sql, so any box where the app was
 * deployed before the migration ran would otherwise throw an unhandled
 * "relation does not exist" and blank the page with a 500. The caller renders a
 * "run the migration" notice instead.
 */
export async function listForecastOpportunities(): Promise<ForecastRow[] | null> {
  const sb = getServiceClient();
  try {
    const { data, error } = await sb
      .from("forecast_opportunities")
      .select("*")
      .order("estimated_solicitation_date", { ascending: true, nullsFirst: false })
      .limit(500);
    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as ForecastRow[];
  } catch (e) {
    const msg = (e as Error).message ?? "";
    // 42P01 undefined_table — the only failure we translate into "not migrated".
    if (/does not exist|42P01|undefined_table/i.test(msg)) return null;
    throw e;
  }
}
