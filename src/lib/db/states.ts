import "server-only";
import { sql } from "@/lib/db/pg";

/**
 * Every state that can actually appear on an opportunity row.
 *
 * WHY THIS IS NOT `listSources()`. State lives in TWO columns and a row may use
 * either: `sources.state` for crawled rows, and `opportunities.state` for
 * hand-entered ones (the seeded 'manual' source has state = null, so a typed-in
 * row carries its own). `listOpportunities()` has matched both sides since the
 * state filter moved into SQL — but the dropdown was still built from
 * `sources.state` alone, so a state that exists ONLY on hand-entered rows had no
 * <option> and could never be selected. On the operator's real workbook that was
 * CA, FL, MN, NY and VA — 17 of their 71 rows, reachable only by hand-typing
 * "?state=NY" into the address bar.
 *
 * The union is taken in SQL and deduped there, so this returns one short row per
 * distinct (origin, state) rather than one per opportunity.
 *
 * CASING. Every value returned is one that is genuinely STORED — this never
 * invents a spelling — but the same code does occur in two cases, because
 * `createSource()` writes its free-text box verbatim ("nc" alongside "NC"). The
 * spellings are folded to one option per code, and the tie-break is DETERMINISTIC
 * (the already-uppercase spelling, else the lexicographically first) so the same
 * data always yields the same option list. Which spelling wins does not affect
 * filtering: both sides of `listOpportunities()`'s state test are `ilike`, and
 * the page canonicalises "?state=" against this list case-insensitively.
 */
export async function listFilterStates(): Promise<string[]> {
  const rows = await sql<{ state: string }>(
    `select state from sources where state is not null and btrim(state) <> ''
     union
     select state from opportunities where state is not null and btrim(state) <> ''`,
  );
  const byCode = new Map<string, string>();
  for (const { state } of rows) {
    const raw = state.trim();
    if (!raw) continue;
    const key = raw.toUpperCase();
    const held = byCode.get(key);
    if (held === undefined || better(raw, held)) byCode.set(key, raw);
  }
  return [...byCode.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, raw]) => raw);
}

/** Prefer the canonical uppercase spelling; otherwise pick one, but always the same one. */
function better(candidate: string, held: string): boolean {
  const cUpper = candidate === candidate.toUpperCase();
  const hUpper = held === held.toUpperCase();
  if (cUpper !== hUpper) return cUpper;
  return candidate < held;
}
