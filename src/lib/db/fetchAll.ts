import { getServiceClient } from "@/lib/supabase/server";

/**
 * Fetch every row of a table for aggregate stats, paging past Supabase's 1,000-row
 * per-request cap (an unpaginated select silently truncates — dashboards computed on
 * a subset look plausible but are wrong).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchAllRows<T = Record<string, any>>(
  table: string,
  select: string,
  pageSize = 1000,
  maxRows = 20_000,
): Promise<T[]> {
  const sb = getServiceClient();
  const out: T[] = [];
  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await sb
      .from(table)
      .select(select)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown as T[];
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}
