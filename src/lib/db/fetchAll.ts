import { getServiceClient } from "@/lib/supabase/server";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retryable transient DB errors (cold pooler connection tripping a short timeout). */
function isTransient(msg: string): boolean {
  return /statement timeout|timeout|ECONNRESET|fetch failed|Connection terminated|57014/i.test(msg);
}

/**
 * Fetch every row of a table for aggregate stats, paging past Supabase's 1,000-row
 * per-request cap (an unpaginated select silently truncates). Select scalar columns
 * only — no PostgREST embeds — so each page is a fast scan. Retries transient
 * timeouts (the first query on a cold pgBouncer connection can be slow; the retry
 * runs warm).
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
    let page: T[] | null = null;
    let lastErr = "";
    for (let attempt = 0; attempt < 3 && page === null; attempt++) {
      const { data, error } = await sb.from(table).select(select).range(from, from + pageSize - 1);
      if (!error) {
        page = (data ?? []) as unknown as T[];
        break;
      }
      lastErr = error.message;
      if (!isTransient(error.message)) throw new Error(error.message);
      await sleep(400 * (attempt + 1));
    }
    if (page === null) throw new Error(`fetchAllRows(${table}) failed after retries: ${lastErr}`);
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out;
}
